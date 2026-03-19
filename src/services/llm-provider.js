/**
 * LLM Provider Layer — agents-service-v2
 * Multi-provider with health check, fallback, caching, cost tracking
 */
import axios from 'axios';
import { logger } from '../utils/logger.js';

const PROVIDERS = {
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    defaultModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat'
  },
  qwen: {
    apiKey: process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '',
    baseUrl: process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: process.env.QWEN_MODEL || 'qwen-max'
  },
  doubao: {
    apiKey: process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY || '',
    baseUrl: process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: process.env.DEEPSEEK_VISION_MODEL || 'doubao-seed-2-0-pro-260215'
  }
};

// Health tracking
const _health = {};
for (const n of Object.keys(PROVIDERS)) _health[n] = { healthy: true, failCount: 0, lastFailTime: 0 };
const FAIL_THRESHOLD = 2, COOLDOWN_MS = 180000;

function markFail(p) { const h=_health[p]; if(!h)return; h.failCount++; h.lastFailTime=Date.now(); if(h.failCount>=FAIL_THRESHOLD){h.healthy=false; logger.error({provider:p},'Provider UNHEALTHY');} }
function markOk(p) { const h=_health[p]; if(!h)return; const was=!h.healthy; h.healthy=true; h.failCount=0; if(was) logger.info({provider:p},'Provider recovered'); }
function isHealthy(p) { const h=_health[p]; if(!h)return true; if(h.healthy)return true; return Date.now()-h.lastFailTime>COOLDOWN_MS; }

export function getProviderHealthStatus() {
  const r={}; const now=Date.now();
  for(const[n,h] of Object.entries(_health)) r[n]={healthy:h.healthy,failCount:h.failCount,available:isHealthy(n),hasKey:!!PROVIDERS[n]?.apiKey};
  return r;
}

function resolveProvider(m) { const s=String(m||'').toLowerCase(); if(s.startsWith('qwen'))return'qwen'; if(s.startsWith('doubao')||s.includes('volces'))return'doubao'; return'deepseek'; }

function getClientConfig(model) {
  const p=resolveProvider(model), cfg=PROVIDERS[p]||PROVIDERS.deepseek;
  return { provider:p, model:String(model||'').trim()||cfg.defaultModel, apiKey:cfg.apiKey, baseUrl:cfg.baseUrl };
}

function buildFallbackChain(model) {
  const primary=resolveProvider(model), chain=[{provider:primary,model}];
  for(const[n,c] of Object.entries(PROVIDERS)) if(n!==primary&&c.apiKey) chain.push({provider:n,model:c.defaultModel});
  return chain;
}

// Cache
const _cache=new Map(), CACHE_TTL=300000;
function getCached(k){const e=_cache.get(k);if(e&&Date.now()-e.ts<CACHE_TTL)return e.v;_cache.delete(k);return null;}
function setCache(k,v){if(_cache.size>200)_cache.delete(_cache.keys().next().value);_cache.set(k,{v,ts:Date.now()});}

// Cost tracker
const _cost={daily:{},lastReset:''};
function trackCost(p,m,tokens){const d=new Date().toISOString().slice(0,10);if(_cost.lastReset!==d){_cost.daily[d]={};_cost.lastReset=d;const ks=Object.keys(_cost.daily).sort();while(ks.length>7)delete _cost.daily[ks.shift()];}const k=`${p}/${m}`;if(!_cost.daily[d][k])_cost.daily[d][k]={calls:0,tokens:0};_cost.daily[d][k].calls++;_cost.daily[d][k].tokens+=(tokens||0);}
export function getCostStats(days=7){const r={},ks=Object.keys(_cost.daily).sort().slice(-days);for(const d of ks)r[d]=_cost.daily[d]||{};return r;}

const _metrics={totalCalls:0,errorCount:0,avgResponseTime:0,cacheHits:0};
export function getPerformanceMetrics(){return{..._metrics,providerHealth:getProviderHealthStatus()};}

function isRetryable(e){if(!e)return false;const s=e?.response?.status;return s===429||s===502||s===503||s===504||e.code==='ECONNABORTED'||e.code==='ETIMEDOUT';}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

export async function callLLM(messages, options={}) {
  const model=String(options.model||PROVIDERS.deepseek.defaultModel).trim();
  const temp=Number(options.temperature??0.1), maxTok=Number(options.max_tokens??1500);
  const hasTools=!!(options.tools?.length);

  if(!options.skipCache&&!hasTools){const ck=`${model}:${JSON.stringify(messages.slice(-2))}:${temp}`;const c=getCached(ck);if(c){_metrics.cacheHits++;return{ok:true,content:c,cached:true};}}

  const start=Date.now(); _metrics.totalCalls++;
  const chain=hasTools?[{provider:resolveProvider(model),model}]:buildFallbackChain(model);

  for(const cand of chain){
    if(!isHealthy(cand.provider))continue;
    const cfg=getClientConfig(cand.model); if(!cfg.apiKey)continue;
    const payload={model:cfg.model,messages,temperature:temp,max_tokens:maxTok,top_p:0.9};
    if(hasTools){payload.tools=options.tools;if(options.tool_choice)payload.tool_choice=options.tool_choice;}

    const maxAttempts=cand.provider===resolveProvider(model)?2:1;
    let resp=null,lastErr=null;
    for(let a=1;a<=maxAttempts;a++){
      try{
        resp=await axios.post(`${cfg.baseUrl}/chat/completions`,payload,{headers:{'Authorization':`Bearer ${cfg.apiKey}`,'Content-Type':'application/json'},timeout:options.timeout||60000});
        break;
      }catch(e){lastErr=e;if(a<maxAttempts&&isRetryable(e)){await sleep(600*a);continue;}}
    }

    if(resp){
      markOk(cand.provider);
      const msg=resp.data?.choices?.[0]?.message||{}, content=msg.content||'';
      const rt=Date.now()-start;
      _metrics.avgResponseTime=(_metrics.avgResponseTime*(_metrics.totalCalls-1)+rt)/_metrics.totalCalls;
      trackCost(cand.provider,cfg.model,Number(resp.data?.usage?.total_tokens||0));
      if(!options.skipCache&&content&&!msg.tool_calls){const ck=`${model}:${JSON.stringify(messages.slice(-2))}:${temp}`;setCache(ck,content);}
      const fb=cand.provider!==resolveProvider(model);
      if(fb)logger.info({from:resolveProvider(model),to:cand.provider},'LLM fallback used');
      return{ok:true,content,message:msg,raw:resp.data,responseTime:rt,fallbackUsed:fb?cand.provider:undefined,actualModel:cfg.model};
    }
    markFail(cand.provider);
    logger.warn({provider:cand.provider,error:lastErr?.message},'Provider failed');
  }

  _metrics.errorCount++;
  return{ok:false,error:'all_providers_failed',content:'',providerHealth:getProviderHealthStatus()};
}

export async function callVisionLLM(imageUrl, prompt) {
  const model=PROVIDERS.doubao.defaultModel;
  const cfg=getClientConfig(model); if(!cfg.apiKey)return{ok:false,error:'no_api_key',content:''};
  const content=[];
  if(Array.isArray(imageUrl)){for(const i of imageUrl){if(i?.type==='text')content.push({type:'text',text:String(i.text)});else if(i?.type==='image'&&i.image_url)content.push({type:'image_url',image_url:{url:String(i.image_url)}});else if(i?.type==='image_url'){const u=typeof i.image_url==='string'?i.image_url:i.image_url?.url;if(u)content.push({type:'image_url',image_url:{url:u}});}}}
  else{const p=String(imageUrl||'').trim();if(p)content.push({type:'image_url',image_url:{url:p}});if(prompt)content.push({type:'text',text:String(prompt)});}
  if(!content.length)return{ok:false,error:'invalid_input',content:''};
  try{
    const resp=await axios.post(`${cfg.baseUrl}/chat/completions`,{model:cfg.model,messages:[{role:'user',content}],temperature:0.2,max_tokens:1500},{headers:{'Authorization':`Bearer ${cfg.apiKey}`,'Content-Type':'application/json'},timeout:90000});
    trackCost(cfg.provider,cfg.model,Number(resp.data?.usage?.total_tokens||0));
    return{ok:true,content:resp.data?.choices?.[0]?.message?.content||'',raw:resp.data};
  }catch(e){logger.error({err:e?.message},'Vision LLM error');return{ok:false,error:e?.message||'vision_failed',content:''};}
}

export async function verifyLLMHealth() {
  const results=[];
  for(const[name,cfg] of Object.entries(PROVIDERS)){
    if(!cfg.apiKey){results.push({name,ok:false,error:'API_KEY未配置'});continue;}
    try{
      const r=await axios.post(`${cfg.baseUrl}/chat/completions`,{model:cfg.defaultModel,messages:[{role:'user',content:'回复OK'}],max_tokens:5,temperature:0},{headers:{Authorization:`Bearer ${cfg.apiKey}`,'Content-Type':'application/json'},timeout:15000});
      results.push({name,model:cfg.defaultModel,ok:true,reply:(r.data?.choices?.[0]?.message?.content||'').slice(0,20)});
      markOk(name);
    }catch(e){
      results.push({name,model:cfg.defaultModel,ok:false,error:`${e?.response?.status||'timeout'}: ${(e?.response?.data?.error?.message||e?.message||'').slice(0,100)}`});
      markFail(name);
    }
  }
  const allOk=results.every(r=>r.ok);
  logger.info({allOk,results:results.map(r=>`${r.ok?'✅':'❌'} ${r.name}`).join(', ')},'LLM health check');
  return{allOk,results};
}
