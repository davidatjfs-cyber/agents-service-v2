/**
 * LLM Provider Layer — agents-service-v2
 * Multi-provider with health check, fallback, caching, cost tracking
 */
import axios from 'axios';
import { logger } from '../utils/logger.js';
import { isExternalEnabled } from '../utils/safety.js';
import { selectModel } from './model-router.js';

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

function normalizeRouterContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  return {
    intent: ctx.intent ?? 'query',
    complexity: ctx.complexity ?? 'low',
    mode: ctx.mode ?? 'single'
  };
}

/** 本地 Ollama（如 gemma4:26b），不依赖外部API；失败时由上层回退到 API */
async function callOllamaLLM(messages, options = {}) {
  const base = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = String(process.env.OLLAMA_OPERATIONS_MODEL || process.env.OLLAMA_CHAT_MODEL || 'qwen2:7b').trim();
  const temp = Number(options.temperature ?? 0.2);
  const maxTok = Number(options.max_tokens ?? 1500);
  const start = Date.now();
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages,
        options: { temperature: temp, num_predict: maxTok }
      })
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Ollama HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = String(data?.message?.content || '').trim();
    const rt = Date.now() - start;
    _metrics.totalCalls++;
    _metrics.avgResponseTime = (_metrics.avgResponseTime * (_metrics.totalCalls - 1) + rt) / _metrics.totalCalls;
    return {
      ok: true,
      content,
      message: { role: 'assistant', content },
      raw: data,
      responseTime: rt,
      actualModel: model,
      provider: 'ollama'
    };
  } catch (e) {
    logger.warn({ err: e?.message, base, model }, 'callOllamaLLM failed');
    return { ok: false, error: e?.message || 'ollama_failed', content: '' };
  }
}

async function callOpenAICompatibleChain(messages, options, primaryModel) {
  if (!isExternalEnabled()) {
    return { ok: false, error: 'external_disabled', content: '' };
  }
  const model = String(primaryModel || PROVIDERS.deepseek.defaultModel).trim();
  const temp = Number(options.temperature ?? 0.1);
  const maxTok = Number(options.max_tokens ?? 1500);
  const hasTools = !!(options.tools?.length);

  if (!options.skipCache && !hasTools) {
    const ck = `${model}:${JSON.stringify(messages.slice(-2))}:${temp}`;
    const c = getCached(ck);
    if (c) {
      _metrics.cacheHits++;
      return { ok: true, content: c, cached: true };
    }
  }

  const start = Date.now();
  _metrics.totalCalls++;
  const chain = hasTools ? [{ provider: resolveProvider(model), model }] : buildFallbackChain(model);

  for (const cand of chain) {
    if (!isHealthy(cand.provider)) continue;
    const cfg = getClientConfig(cand.model);
    if (!cfg.apiKey) continue;
    const payload = { model: cfg.model, messages, temperature: temp, max_tokens: maxTok, top_p: 0.9 };
    if (hasTools) {
      payload.tools = options.tools;
      if (options.tool_choice) payload.tool_choice = options.tool_choice;
    }

    const maxAttempts = cand.provider === resolveProvider(model) ? 2 : 1;
    let resp = null;
    let lastErr = null;
    for (let a = 1; a <= maxAttempts; a++) {
      try {
        resp = await axios.post(`${cfg.baseUrl}/chat/completions`, payload, {
          headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
          timeout: options.timeout || 60000
        });
        break;
      } catch (e) {
        lastErr = e;
        if (a < maxAttempts && isRetryable(e)) await sleep(600 * a);
      }
    }

    if (resp) {
      markOk(cand.provider);
      const msg = resp.data?.choices?.[0]?.message || {};
      const content = msg.content || '';
      const rt = Date.now() - start;
      _metrics.avgResponseTime = (_metrics.avgResponseTime * (_metrics.totalCalls - 1) + rt) / _metrics.totalCalls;
      trackCost(cand.provider, cfg.model, Number(resp.data?.usage?.total_tokens || 0));
      if (!options.skipCache && content && !msg.tool_calls) {
        const ck = `${model}:${JSON.stringify(messages.slice(-2))}:${temp}`;
        setCache(ck, content);
      }
      const fb = cand.provider !== resolveProvider(model);
      if (fb) logger.info({ from: resolveProvider(model), to: cand.provider }, 'LLM fallback used');
      return {
        ok: true,
        content,
        message: msg,
        raw: resp.data,
        responseTime: rt,
        fallbackUsed: fb ? cand.provider : undefined,
        actualModel: cfg.model
      };
    }
    markFail(cand.provider);
    logger.warn({ provider: cand.provider, error: lastErr?.message }, 'Provider failed');
  }

  _metrics.errorCount++;
  return { ok: false, error: 'all_providers_failed', content: '', providerHealth: getProviderHealthStatus() };
}

/**
 * @param {Array} messages
 * @param {object} options — 支持 options.context = { intent, complexity, mode } 走 model-router；兼容原 options.model
 */
export async function callLLM(messages, options = {}) {
  const hasTools = !!(options.tools?.length);
  const routerCtx = normalizeRouterContext(options.context);
  const routedModel = routerCtx ? selectModel(routerCtx) : null;
  const localModel = process.env.OLLAMA_OPERATIONS_MODEL || 'qwen2:7b';

  if (!hasTools && routedModel === localModel) {
    const o = await callOllamaLLM(messages, options);
    if (o.ok && o.content) return o;
    logger.warn({ err: o.error }, `Ollama (${localModel}) failed, falling back to API LLM`);
  }

  let primaryModel = options.model;
  if (!primaryModel) {
    if (!routerCtx || routedModel === localModel) {
      primaryModel = PROVIDERS.deepseek.defaultModel;
    } else {
      primaryModel = routedModel || PROVIDERS.deepseek.defaultModel;
    }
  }

  return callOpenAICompatibleChain(messages, options, primaryModel);
}

/** 本地 Ollama 图片识别（gemma4:26b 支持 vision），失败时回退到外部 API */
async function callOllamaVision(messages, options = {}) {
  const base = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = String(process.env.OLLAMA_OPERATIONS_MODEL || process.env.OLLAMA_CHAT_MODEL || 'qwen2:7b').trim();
  const temp = Number(options.temperature ?? 0.2);
  const maxTok = Number(options.max_tokens ?? 1500);
  const start = Date.now();
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages,
        options: { temperature: temp, num_predict: maxTok }
      })
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Ollama HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = String(data?.message?.content || '').trim();
    const rt = Date.now() - start;
    _metrics.totalCalls++;
    _metrics.avgResponseTime = (_metrics.avgResponseTime * (_metrics.totalCalls - 1) + rt) / _metrics.totalCalls;
    return {
      ok: true,
      content,
      message: { role: 'assistant', content },
      raw: data,
      responseTime: rt,
      actualModel: model,
      provider: 'ollama'
    };
  } catch (e) {
    logger.warn({ err: e?.message, base, model }, 'callOllamaVision failed');
    return { ok: false, error: e?.message || 'ollama_vision_failed', content: '' };
  }
}

/**
 * 图片识别 — 优先使用本地 Ollama（gemma4:26b 支持 vision），失败时回退到外部 API
 * @param {string|Array} imageUrl — 支持 base64 data URL、URL、或 {type, image_url} 数组
 * @param {string} prompt — 图片分析提示词
 */
export async function callVisionLLM(imageUrl, prompt) {
  const content = [];
  if (Array.isArray(imageUrl)) {
    for (const i of imageUrl) {
      if (i?.type === 'text') content.push({ type: 'text', text: String(i.text) });
      else if (i?.type === 'image' && i.image_url) content.push({ type: 'image_url', image_url: { url: String(i.image_url) } });
      else if (i?.type === 'image_url') {
        const u = typeof i.image_url === 'string' ? i.image_url : i.image_url?.url;
        if (u) content.push({ type: 'image_url', image_url: { url: u } });
      }
    }
  } else {
    const p = String(imageUrl || '').trim();
    if (p) content.push({ type: 'image_url', image_url: { url: p } });
    if (prompt) content.push({ type: 'text', text: String(prompt) });
  }
  if (!content.length) return { ok: false, error: 'invalid_input', content: '' };

  // 优先尝试本地 Ollama vision
  const ollamaMessages = content.map(c => {
    if (c.type === 'image_url') {
      const url = c.image_url.url;
      if (url.startsWith('data:')) {
        const base64 = url.split(',')[1];
        return { role: 'user', content: prompt || '', images: [base64] };
      }
      // URL 类型需要下载转为 base64
      return { role: 'user', content: prompt || '', images: [url] };
    }
    return { role: 'user', content: c.text || '' };
  });

  const ollamaResult = await callOllamaVision(ollamaMessages, { temperature: 0.2, max_tokens: 1500 });
  if (ollamaResult.ok && ollamaResult.content) return ollamaResult;

  // 回退到外部 API
  if (!isExternalEnabled()) {
    return { ok: false, error: 'external_disabled', content: '' };
  }
  const model = PROVIDERS.doubao.defaultModel;
  const cfg = getClientConfig(model);
  if (!cfg.apiKey) return { ok: false, error: 'no_api_key', content: '' };

  const openaiContent = [];
  if (Array.isArray(imageUrl)) {
    for (const i of imageUrl) {
      if (i?.type === 'text') openaiContent.push({ type: 'text', text: String(i.text) });
      else if (i?.type === 'image' && i.image_url) openaiContent.push({ type: 'image_url', image_url: { url: String(i.image_url) } });
      else if (i?.type === 'image_url') {
        const u = typeof i.image_url === 'string' ? i.image_url : i.image_url?.url;
        if (u) openaiContent.push({ type: 'image_url', image_url: { url: u } });
      }
    }
  } else {
    const p = String(imageUrl || '').trim();
    if (p) openaiContent.push({ type: 'image_url', image_url: { url: p } });
    if (prompt) openaiContent.push({ type: 'text', text: String(prompt) });
  }

  try {
    const resp = await axios.post(`${cfg.baseUrl}/chat/completions`, {
      model: cfg.model,
      messages: [{ role: 'user', content: openaiContent }],
      temperature: 0.2,
      max_tokens: 1500
    }, {
      headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 90000
    });
    trackCost(cfg.provider, cfg.model, Number(resp.data?.usage?.total_tokens || 0));
    return { ok: true, content: resp.data?.choices?.[0]?.message?.content || '', raw: resp.data };
  } catch (e) {
    logger.error({ err: e?.message }, 'Vision LLM error');
    return { ok: false, error: e?.message || 'vision_failed', content: '' };
  }
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

/**
 * Planner 层建议生成 Prompt 构建（必须可执行、结构固定）
 */
export function buildBusinessPrompt(data, tone = '务实、可执行、避免空话') {
  const revenue = data?.revenue ?? 0;
  const profitRate = data?.profitRate;
  const avgTicket = data?.avgTicket;
  const tableTurnover = data?.tableTurnover;
  const anomalies = Array.isArray(data?.anomalies) ? data.anomalies : [];

  const profitRatePct = profitRate != null && Number.isFinite(Number(profitRate))
    ? (Number(profitRate) * 100).toFixed(1)
    : '暂无';

  return `
你是一名餐饮区域经理。

门店经营数据：
* 营业额：${Number(revenue).toFixed(2)}
* 利润率：${profitRatePct}%
* 客单价：${avgTicket != null ? Number(avgTicket).toFixed(0) : '暂无'}
* 翻台率：${tableTurnover != null ? Number(tableTurnover).toFixed(2) : '暂无'}
* 当前问题：${anomalies.length ? anomalies.join(",") : "暂无"}

风格要求：${tone}

输出要求：
【经营总结】
【问题分析】
【行动建议】
1.（必须具体动作）
2.（必须具体动作）

禁止：
“优化”“提升”这种空话
`.trim();
}
