// ═══════════════════════════════════════════════════════
// Deterministic Reply Builders — V2
// Ported from V1 agents.js for consistent data-grounded responses
// ═══════════════════════════════════════════════════════
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

// ── Helpers ───────────────────────────────────────────

function fmt(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}

function toD(v) {
  const s = String(v||'').trim(); if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  try { const d = new Date(s); return Number.isFinite(d.getTime()) ? d.toISOString().slice(0,10) : ''; } catch { return ''; }
}

function inRange(v, start, end) {
  const d = toD(v); if (!d) return false;
  if (start && d < start) return false;
  if (end && d > end) return false;
  return true;
}

function storeKey(v) { return String(v||'').trim().toLowerCase().replace(/\s+/g,''); }
function storeLike(v) { return `%${storeKey(v)}%`; }
function storeAlias(v) { return storeKey(v).replace(/(上海|北京|深圳|广州|大宁|门店|店铺|店|商场|广场|购物中心)/g,''); }

function sameStore(a, b) {
  const x = storeKey(a), y = storeKey(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const ax = storeAlias(a), by = storeAlias(b);
  return !!(ax && by && (ax === by || ax.includes(by) || by.includes(ax)));
}

function bitableDate(v, fb) {
  if (v == null || v === '') return toD(fb);
  if (typeof v === 'number' && Number.isFinite(v)) return toD(new Date(v > 1e12 ? v : v*1000).toISOString());
  const s = String(v).trim(); if (!s) return toD(fb);
  if (/^\d{10,13}$/.test(s)) { const n = Number(s); return toD(new Date(s.length===13?n:n*1000).toISOString()); }
  return toD(s) || toD(fb);
}

function ext(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number') return String(val);
  if (Array.isArray(val)) {
    const p = [];
    for (const it of val) {
      if (typeof it === 'string') { p.push(it); continue; }
      if (it && typeof it === 'object') {
        if (Array.isArray(it.text_arr) && it.text_arr.length) p.push(...it.text_arr.map(t=>String(t||'').trim()).filter(Boolean));
        else if (it.text) p.push(String(it.text).trim());
      }
    }
    return p.join('，').trim();
  }
  if (typeof val === 'object' && val.text) return String(val.text).trim();
  return String(val).trim();
}

export function resolveDateRange(text, dd = 7) {
  const q = String(text||'').trim();
  const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate()), ms = 86400000;
  const mr = (y, m) => {
    if (!Number.isFinite(y)||!Number.isFinite(m)||m<1||m>12) return null;
    return { start: fmt(new Date(y,m-1,1)), end: fmt(new Date(y,m,0)) };
  };
  const rm = q.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(?:到|至|~|～|-|—)\s*(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月/);
  if (rm) {
    let sy=parseInt(rm[1]||now.getFullYear(),10), sm=parseInt(rm[2],10);
    let ey=parseInt(rm[3]||sy,10), em=parseInt(rm[4],10);
    if (!rm[3]&&em<sm) ey++;
    const s=mr(sy,sm), e=mr(ey,em);
    if (s&&e) return {label:`${sy}年${sm}月-${ey}年${em}月`,start:s.start,end:e.end};
  }
  const sm2 = q.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月/);
  if (sm2 && !/上[个]?月|本月/.test(q)) {
    const y=parseInt(sm2[1]||now.getFullYear(),10), m=parseInt(sm2[2],10);
    const r=mr(y,m); if (r) return {label:`${y}年${m}月`,start:r.start,end:r.end};
  }
  if (/今[天日]/.test(q)) return {label:'今日',start:fmt(today),end:fmt(today)};
  if (/昨[天日]/.test(q)) { const y=new Date(today-ms); return {label:'昨日',start:fmt(y),end:fmt(y)}; }
  if (/前[天日]/.test(q)) { const d=new Date(today-2*ms); return {label:'前天',start:fmt(d),end:fmt(d)}; }
  if (/上周/.test(q)) { const dow=today.getDay()||7; const m2=new Date(today-(dow+6)*ms); return {label:'上周',start:fmt(m2),end:fmt(new Date(+m2+6*ms))}; }
  if (/本周/.test(q)) { const dow=today.getDay()||7; return {label:'本周',start:fmt(new Date(today-(dow-1)*ms)),end:fmt(today)}; }
  if (/上[个]?月/.test(q)) { const f=new Date(now.getFullYear(),now.getMonth(),1),l=new Date(f-ms),s2=new Date(l.getFullYear(),l.getMonth(),1); return {label:'上月',start:fmt(s2),end:fmt(l)}; }
  if (/本月/.test(q)) return {label:'本月',start:fmt(new Date(now.getFullYear(),now.getMonth(),1)),end:fmt(today)};
  const nm = q.match(/近\s*(\d+)\s*天/);
  if (nm) { const n=parseInt(nm[1],10)||dd; return {label:`近${n}天`,start:fmt(new Date(today-(n-1)*ms)),end:fmt(today)}; }
  if (/最近/.test(q)) return {label:`近${dd}天`,start:fmt(new Date(today-(dd-1)*ms)),end:fmt(today)};
  return {label:`近${dd}天`,start:fmt(new Date(today-(dd-1)*ms)),end:fmt(today)};
}

function topN(map, n=5) { return Array.from(map.entries()).sort((a,b)=>b[1]-a[1]).slice(0,n); }

// Resolve store name against daily_reports / sales_raw actual store values
async function resolveDbStoreName(tableName, storeInput) {
  const s = String(storeInput||'').trim();
  if (!s) return '';
  try {
    const r = await query(`SELECT DISTINCT store FROM ${tableName} WHERE store IS NOT NULL LIMIT 50`);
    const stores = (r.rows||[]).map(x => x.store).filter(Boolean);
    // exact match first
    const exact = stores.find(x => storeKey(x) === storeKey(s));
    if (exact) return exact;
    // fuzzy match via sameStore
    const fuzzy = stores.find(x => sameStore(x, s));
    if (fuzzy) return fuzzy;
  } catch(_e) {}
  return s;
}

// ── 1. Identity (我是谁) ─────────────────────────────

async function buildIdentityReply(text, ctx) {
  if (!/(我是谁|你知道我|我叫什么|我的名字|我的信息)/.test(text)) return '';
  const roleMap = { admin:'管理员', hq_manager:'总部营运经理', store_manager:'店长',
    store_production_manager:'出品经理', front_manager:'前厅经理', employee:'员工' };
  const name = ctx.realName || ctx.username || '未知';
  const roleName = roleMap[ctx.role] || ctx.role || '未知';
  const lines = [`您好！您的信息如下：`, `- 姓名：${name}`, `- 角色：${roleName}`];
  if (ctx.store && ctx.store !== '总部') lines.push(`- 所属门店：${ctx.store}`);
  else if (ctx.store === '总部') lines.push(`- 所属：总部`);
  return lines.join('\n');
}

// ── 2. Table Visit (桌访) ────────────────────────────

async function buildTableVisitReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (!/(桌访|桌巡|巡台|不满意.*菜|菜品.*不满意|出品.*不满意|最不满意|不满意在哪|不满意.*原因|哪里不满意|什么不满意|什么.*产品.*不满意|产品.*不满意|不满意.*产品)/.test(q)) return '';
  const p = resolveDateRange(q, 7);
  try {
    const r = await query(`SELECT fields, created_at FROM feishu_generic_records WHERE config_key='table_visit' ORDER BY updated_at DESC LIMIT 3000`);
    const matched = (r.rows||[]).filter(row => {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      return sameStore(ext(f['门店']||f['所属门店']), s);
    });
    const rows = matched.filter(row => {
      const f = row.fields||{};
      const d = bitableDate(f['日期']||f['提交时间'], row.created_at);
      return d && inRange(d, p.start, p.end);
    }).map(row => row.fields||{});
    if (!rows.length) return `📋 ${p.label}桌访记录（${s}）：暂无桌访数据。`;
    const dishMap = new Map(), fbMap = new Map();
    const blocked = new Set(['无','没有','暂无','不清楚','未知','其他','']);
    for (const f of rows) {
      const dishes = ext(f['今天 不满意菜品']||f['今天不满意菜品']||f['不满意菜品']);
      if (dishes) dishes.split(/[，,、]+/).map(x=>x.trim()).filter(Boolean).forEach(d => dishMap.set(d,(dishMap.get(d)||0)+1));
      const fb = ext(f['满意或不满意的主要原因是什么？']||f['不满意原因']||f['顾客反馈']||f['unsatisfied_items']).trim();
      if (fb && !blocked.has(fb)) fb.split(/[，,、]+/).map(x=>x.trim()).filter(Boolean).forEach(x => fbMap.set(x,(fbMap.get(x)||0)+1));
    }
    const dishSorted = topN(dishMap, 8), fbSorted = topN(fbMap, 8);
    // Specific dish query
    const dishNames = dishSorted.map(([d])=>d);
    const mentioned = dishNames.find(d => q.includes(d));
    if (mentioned) {
      const dRows = rows.filter(f => String(ext(f['今天 不满意菜品']||f['今天不满意菜品']||f['不满意菜品'])).includes(mentioned));
      const dFb = new Map();
      for (const f of dRows) {
        const fb = ext(f['满意或不满意的主要原因是什么？']||f['不满意原因']||f['顾客反馈']||f['unsatisfied_items']).trim();
        if (fb && !blocked.has(fb)) fb.split(/[，,、]+/).map(x=>x.trim()).filter(Boolean).forEach(x => dFb.set(x,(dFb.get(x)||0)+1));
      }
      const dl = [`📋 「${mentioned}」桌访不满意详情（${s}·${p.label}）【数据来源：桌访巡台记录】`, `提及「${mentioned}」的桌访共${dRows.length}条（总${rows.length}条中）`];
      const dFbSorted = topN(dFb, 8);
      if (dFbSorted.length) { dl.push('','🔔 关联不满意反馈：'); dFbSorted.forEach(([d,c],i)=>dl.push(`${i+1}. ${d}（${c}次）`)); }
      else dl.push('','桌访记录中未记录该菜品的具体不满意原因。');
      return dl.join('\n');
    }
    const lines = [`📋 桌访反馈（${s}·${p.label}）【数据来源：桌访巡台记录，非大众点评】`, `共${rows.length}条桌访记录`];
    if (dishSorted.length) {
      lines.push('','🍽 被提及不满意的产品：');
      dishSorted.forEach(([dish, cnt], idx) => {
        const relatedFb = [];
        for (const f of rows) {
          const dVal = ext(f['今天 不满意菜品']||f['今天不满意菜品']||f['不满意菜品']);
          if (dVal && dVal.includes(dish)) {
            const fb = ext(f['满意或不满意的主要原因是什么？']||f['不满意原因']||f['顾客反馈']||f['unsatisfied_items']).trim();
            if (fb && !blocked.has(fb)) relatedFb.push(fb);
          }
        }
        const uniqueFb = [...new Set(relatedFb)].slice(0, 3);
        lines.push(`${idx+1}. **${dish}**（${cnt}次）${uniqueFb.length ? '：' + uniqueFb.join('；') : ''}`);
      });
    }
    if (!dishSorted.length && fbSorted.length) { lines.push('','🔔 不满意原因汇总：'); fbSorted.forEach(([d,c],i)=>lines.push(`${i+1}. ${d}（${c}次）`)); }
    if (!fbSorted.length && !dishSorted.length) lines.push('','该时段桌访未记录明确不满意内容。');
    return lines.join('\n');
  } catch(e) { return `桌访数据查询失败：${e?.message||'未知错误'}`; }
}

// ── 3. Closing Report (收档) ─────────────────────────

async function buildClosingReportReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (!/(收档|收市|闭档|清洁|卫生|档口.*得分|得分.*档口|谁没.*收档|没收档)/.test(q)) return '';
  const p = resolveDateRange(q, 7);
  try {
    const r = await query(`SELECT fields, created_at FROM feishu_generic_records WHERE config_key='closing_reports' ORDER BY updated_at DESC LIMIT 3000`);
    const all = (r.rows||[]).map(row => ({ f: row.fields && typeof row.fields==='object' ? row.fields : {}, ca: row.created_at }));
    const matched = all.filter(x => sameStore(ext(x.f['门店']||x.f['所属门店']), s));
    const rows = matched.filter(x => {
      const d = bitableDate(x.f['提交时间']||x.f['日期'], x.ca);
      return d && inRange(d, p.start, p.end);
    });
    if (!rows.length) return `${p.label}收档报告（${s}）：0条记录。该时间段暂无收档报告入库。`;
    // Collect all known stations and per-date submissions
    const stationSet = new Set();
    const dateMap = {};
    for (const x of rows) {
      const station = ext(x.f['档口']);
      const d = bitableDate(x.f['提交时间']||x.f['日期'], x.ca);
      if (station) stationSet.add(station);
      if (d) {
        if (!dateMap[d]) dateMap[d] = new Map();
        if (station) {
          const submitter = ext(x.f['提交人']||x.f['姓名']||x.f['负责人']||'');
          dateMap[d].set(station, submitter);
        }
      }
    }
    const stations = Array.from(stationSet);
    const wantWhoMissed = /(谁没|没收档|缺失|漏)/.test(q);
    if (wantWhoMissed && stations.length > 0) {
      const dates = Object.keys(dateMap).sort();
      const lines = [`${p.label}收档提交情况（${s}）`, `已知岗位：${stations.join('、')}`];
      let missTotal = 0;
      for (const d of dates) {
        const submitted = dateMap[d];
        const missing = stations.filter(st => !submitted.has(st));
        if (missing.length === 0) {
          lines.push(`\n📅 ${d}：✅ 全部已提交`);
        } else {
          missTotal += missing.length;
          const missList = missing.map(st => {
            const people = rows.filter(x => ext(x.f['档口']) === st)
              .map(x => ext(x.f['提交人']||x.f['姓名']||x.f['负责人'])).filter(Boolean);
            const uniquePeople = [...new Set(people)];
            return `${st}${uniquePeople.length ? ' ('+uniquePeople.join('/')+')' : ''}`;
          }).join('、');
          lines.push(`\n📅 ${d}：缺失 ${missList}`);
        }
      }
      lines.push(`\n共缺失 ${missTotal} 次收档提交`);
      return lines.join('\n');
    }
    // Default: per-date view showing which stations submitted / missed
    const dates = Object.keys(dateMap).sort();
    if (stations.length > 0 && dates.length > 0) {
      const lines = [`${p.label}收档提交情况（${s}）`, `已知岗位：${stations.join('、')}`];
      let missTotal = 0;
      for (const d of dates) {
        const submitted = dateMap[d];
        const missing = stations.filter(st => !submitted.has(st));
        if (missing.length === 0) {
          lines.push(`\n📅 ${d}：✅ 全部已提交`);
        } else {
          missTotal += missing.length;
          const missList = missing.map(st => {
            const people = rows.filter(x => ext(x.f['档口']) === st)
              .map(x => ext(x.f['提交人']||x.f['姓名']||x.f['负责人'])).filter(Boolean);
            const uniquePeople = [...new Set(people)];
            return `${st}${uniquePeople.length ? ' ('+uniquePeople.join('/')+')' : ''}`;
          }).join('、');
          lines.push(`\n📅 ${d}：缺失 ${missList}`);
        }
      }
      lines.push(`\n共缺失 ${missTotal} 次收档提交`);
      return lines.join('\n');
    }
    // Fallback: simple summary
    const lines = [`${p.label}收档报告（${s}）`, `- 收档记录：${rows.length}条`];
    return lines.join('\n');
  } catch(e) { return `收档报告查询失败：${e?.message||'未知错误'}`; }
}

// ── 4. Opening Report (开档) ─────────────────────────

async function buildOpeningReportReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (!/(开档|开市|备餐|谁没.*开档|没开档)/.test(q)) return '';
  const p = resolveDateRange(q, 7);
  try {
    const r = await query(`SELECT fields, created_at FROM feishu_generic_records WHERE config_key='opening_reports' ORDER BY updated_at DESC LIMIT 3000`);
    const all = (r.rows||[]).map(row => ({ f: row.fields && typeof row.fields==='object' ? row.fields : {}, ca: row.created_at }));
    const matched = all.filter(x => sameStore(ext(x.f['门店']||x.f['所属门店']), s));
    const rows = matched.filter(x => {
      const d = bitableDate(x.f['记录日期']||x.f['提交时间']||x.f['日期'], x.ca);
      return d && inRange(d, p.start, p.end);
    });
    if (!rows.length) return `${p.label}开档报告（${s}）：0条记录。该时间段暂无开档报告入库。`;
    // Collect all known stations
    const stationSet = new Set();
    const dateMap = {};
    for (const x of rows) {
      const station = ext(x.f['岗位']||x.f['档口']);
      const d = bitableDate(x.f['记录日期']||x.f['提交时间']||x.f['日期'], x.ca);
      if (station) stationSet.add(station);
      if (d) {
        if (!dateMap[d]) dateMap[d] = new Map();
        if (station) {
          const submitter = ext(x.f['提交人']||x.f['姓名']||x.f['负责人']||'');
          dateMap[d].set(station, submitter);
        }
      }
    }
    const stations = Array.from(stationSet);
    const wantWhoMissed = /(谁没|没开档|缺失|漏)/.test(q);
    if (wantWhoMissed && stations.length > 0) {
      const dates = Object.keys(dateMap).sort();
      const lines = [`${p.label}开档提交情况（${s}）`, `已知岗位：${stations.join('、')}`];
      let missTotal = 0;
      for (const d of dates) {
        const submitted = dateMap[d];
        const missing = stations.filter(st => !submitted.has(st));
        if (missing.length === 0) {
          lines.push(`\n📅 ${d}：✅ 全部已提交`);
        } else {
          missTotal += missing.length;
          const missList = missing.map(st => {
            const people = rows.filter(x => {
              const xst = ext(x.f['岗位']||x.f['档口']);
              return xst === st;
            }).map(x => ext(x.f['提交人']||x.f['姓名']||x.f['负责人'])).filter(Boolean);
            const uniquePeople = [...new Set(people)];
            return `${st}${uniquePeople.length ? ' ('+uniquePeople.join('/')+')' : ''}`;
          }).join('、');
          lines.push(`\n📅 ${d}：缺失 ${missList}`);
        }
      }
      lines.push(`\n共缺失 ${missTotal} 次开档提交`);
      return lines.join('\n');
    }
    // Default: summary
    const stationTop = new Map();
    rows.forEach(x => { const st = ext(x.f['岗位']||x.f['档口']); if (st) stationTop.set(st,(stationTop.get(st)||0)+1); });
    const mealTop = new Map();
    rows.forEach(x => { const m = ext(x.f['饭市']); if (m) mealTop.set(m,(mealTop.get(m)||0)+1); });
    return [`${p.label}开档报告（${s}）`,
      `- 开档记录：${rows.length}条`,
      `- 岗位分布：${topN(stationTop,5).map(([k,v])=>`${k}(${v})`).join('、')||'无'}`,
      `- 饭市分布：${Array.from(mealTop.entries()).map(([k,v])=>`${k}(${v})`).join('、')||'无'}`
    ].join('\n');
  } catch(e) { return `开档报告查询失败：${e?.message||'未知错误'}`; }
}

// ── 5. Meeting Report (例会) ─────────────────────────

async function buildMeetingReportReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (!/(例会|早会|班会|会议|开会|例会.*得分|例会.*合格)/.test(q)) return '';
  const p = resolveDateRange(q, 7);
  try {
    const r = await query(`SELECT fields, created_at FROM feishu_generic_records WHERE config_key='meeting_reports' ORDER BY updated_at DESC LIMIT 500`);
    const rows = (r.rows||[]).filter(row => {
      const f = row.fields && typeof row.fields==='object' ? row.fields : {};
      if (!sameStore(ext(f['所属门店']||f['门店']), s)) return false;
      const d = bitableDate(f['记录日期']||f['提交时间']||f['日期']||f['例会日期'], row.created_at);
      return d && inRange(d, p.start, p.end);
    });
    if (!rows.length) return `📊 ${p.label}例会数据（${s}）：暂无例会记录入库。`;
    const scores = rows.map(row => {
      const f = row.fields||{};
      let v = parseFloat(ext(f['得分']));
      if (isNaN(v)) { const m = String(f['是否合格的例会']||'').match(/(\d+(?:\.\d+)?)\s*分/); if (m) v = parseFloat(m[1]); }
      return v;
    }).filter(n=>!isNaN(n));
    const avg = scores.length ? (scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1) : '-';
    const qual = rows.filter(row => { const t = String(row.fields?.['是否合格的例会']||''); return t.includes('合格')&&!t.includes('不合格'); });
    const qualRate = rows.length ? `${qual.length}/${rows.length}次合格` : null;
    const hosts = new Map(), absentees = new Map();
    rows.forEach(row => {
      const f = row.fields||{};
      const h = ext(f['主持人']); if (h) hosts.set(h,(hosts.get(h)||0)+1);
      const abs = ext(f['缺席人员姓名']);
      if (abs && abs !== '无') abs.split(/[,，、]/).forEach(n => { n=n.trim(); if(n) absentees.set(n,(absentees.get(n)||0)+1); });
    });
    const lines = [`📊 ${p.label}例会数据（${s}）`, `- 例会记录：${rows.length}次`];
    if (avg !== '-') lines.push(`- 平均得分：${avg}分`);
    if (qualRate) lines.push(`- 合格情况：${qualRate}`);
    if (hosts.size) lines.push(`- 主持人：${topN(hosts,3).map(([k,v])=>`${k}(${v}次)`).join('、')}`);
    if (absentees.size) lines.push(`- 缺席频次Top：${topN(absentees,5).map(([k,v])=>`${k}(${v}次)`).join('、')}`);
    return lines.join('\n');
  } catch(e) { return `例会数据查询失败：${e?.message||'未知错误'}`; }
}

// ── 6. Material Report (原料收货) ────────────────────

async function buildMaterialReportReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (!/(原料|收货|食材|进货|供应商|原材料)/.test(q)) return '';
  const p = resolveDateRange(q, 7);
  try {
    const r = await query(`SELECT fields, created_at FROM feishu_generic_records WHERE config_key LIKE 'material_%' ORDER BY updated_at DESC LIMIT 3000`);
    const all = (r.rows||[]).map(row => ({ f: row.fields && typeof row.fields==='object' ? row.fields : {}, ca: row.created_at }));
    const matched = all.filter(x => sameStore(ext(x.f['所属门店']||x.f['门店']), s));
    const rows = matched.filter(x => {
      const d = bitableDate(x.f['收货日期']||x.f['日期'], x.ca);
      return d && inRange(d, p.start, p.end);
    });
    if (!rows.length) return `${p.label}原料收货日报（${s}）：0条记录。该时间段暂无原料异常数据入库。`;
    const hasIssue = rows.filter(x => {
      const fb = ext(x.f['今日异常反馈']||x.f['今天原料情况']);
      return fb && !/正常|无|没有/.test(fb);
    });
    const matTop = new Map();
    hasIssue.forEach(x => { const n = ext(x.f['异常原料名称']); if (n) matTop.set(n,(matTop.get(n)||0)+1); });
    const sevTop = new Map();
    hasIssue.forEach(x => { const sv = ext(x.f['严重情况']); if (sv) sevTop.set(sv,(sevTop.get(sv)||0)+1); });
    return [`${p.label}原料收货日报（${s}）`,
      `- 收货记录：${rows.length}条`,
      `- 异常记录：${hasIssue.length}条`,
      `- 异常原料Top：${topN(matTop,5).map(([k,v])=>`${k}(${v}次)`).join('、')||'无'}`,
      `- 严重程度：${Array.from(sevTop.entries()).map(([k,v])=>`${k}(${v})`).join('、')||'无'}`
    ].join('\n');
  } catch(e) { return `原料收货日报查询失败：${e?.message||'未知错误'}`; }
}

// ── 7. Bad Review (差评) ─────────────────────────────

async function buildBadReviewReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (!/(差评|负评|投诉|点评|评价.*差|差.*评价|大众点评|美团|评价.*情况|差评.*产品|差评.*多)/.test(q)) return '';
  const p = resolveDateRange(q, 7);
  try {
    const r = await query(`SELECT fields, created_at FROM feishu_generic_records WHERE config_key='bad_review' ORDER BY updated_at DESC LIMIT 3000`);
    const rows = (r.rows||[]).filter(row => {
      const f = row.fields && typeof row.fields==='object' ? row.fields : {};
      if (!sameStore(ext(f['差评门店']||f['门店']||f['所属门店']), s)) return false;
      const d = bitableDate(f['创建日期']||f['日期']||f['提交时间']||f['评价日期'], row.created_at);
      return d && inRange(d, p.start, p.end);
    });
    if (!rows.length) return `📊 ${p.label}差评数据（${s}）：暂无差评记录入库。`;
    const prodTop = new Map(), kwTop = new Map(), platTop = new Map();
    const samples = [];
    rows.forEach(row => {
      const f = row.fields||{};
      const prod = ext(f['差评产品']||f['product_name']);
      const kw = ext(f['差评关键词']||f['keywords']);
      const plat = ext(f['差评平台']||f['platform']);
      const reason = ext(f['差评原因']||f['content']||f['reason']||f['评价内容']);
      if (prod && prod !== '无') prodTop.set(prod,(prodTop.get(prod)||0)+1);
      if (kw) kw.split(/[,，、]/).forEach(k => { k=k.trim(); if(k) kwTop.set(k,(kwTop.get(k)||0)+1); });
      if (plat) {
        const pText = Array.isArray(plat) ? plat.join('') : String(plat);
        pText.split(/[,，、]/).forEach(pp => { pp=pp.trim(); if(pp) platTop.set(pp,(platTop.get(pp)||0)+1); });
      }
      if (reason && samples.length < 3) samples.push(String(reason).slice(0,80));
    });
    const tn = (m,n=5) => topN(m,n).map(([k,v])=>`${k}(${v})`).join('、') || '无';
    const lines = [`📊 差评数据（${s}·${p.label}）`, `- 差评总数：${rows.length}条`];
    if (platTop.size) lines.push(`- 来源平台：${tn(platTop,3)}`);
    if (prodTop.size) lines.push(`- 差评产品Top：${tn(prodTop)}`);
    if (kwTop.size) lines.push(`- 关键词Top：${tn(kwTop)}`);
    if (samples.length) { lines.push(`- 最新样例：`); samples.forEach(s2=>lines.push(`  · ${s2}`)); }
    return lines.join('\n');
  } catch(e) { return `差评数据查询失败：${e?.message||'未知错误'}`; }
}

// ── 8. Daily Report (营收分析) ───────────────────────

async function buildDailyReportReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (!/(营业额|营收|日报|毛利|点评评分|revenue|翻台|客单价|业绩|达成率|目标|生意|经营情况|经营)/.test(q)) return '';
  const p = resolveDateRange(q, 7);
  const resolvedStore = await resolveDbStoreName('daily_reports', s);
  const sl = storeLike(resolvedStore);
  try {
    let sql = `SELECT * FROM daily_reports WHERE lower(regexp_replace(coalesce(store,''),'\\s+','','g')) LIKE $1`;
    const params = [sl];
    if (p.start) { sql += ` AND date >= $${params.length+1}`; params.push(p.start); }
    if (p.end) { sql += ` AND date <= $${params.length+1}`; params.push(p.end); }
    sql += ' ORDER BY date DESC LIMIT 60';
    const r = await query(sql, params);
    const rows = r.rows || [];
    if (!rows.length) {
      try {
        const sr = await query(
          `SELECT s.date::text AS date, ROUND(SUM(COALESCE(s.revenue,0))::numeric,2) AS day_rev,
                  ROUND(SUM(COALESCE(s.sales_amount,0))::numeric,2) AS day_sales
           FROM sales_raw s WHERE lower(regexp_replace(coalesce(s.store,''),'\\s+','','g'))=$1
             AND s.date BETWEEN $2 AND $3 GROUP BY s.date ORDER BY s.date DESC LIMIT 60`,
          [storeKey(resolvedStore), p.start, p.end]);
        const sRows = sr.rows||[];
        if (sRows.length) {
          const tRev = sRows.reduce((a,x)=>a+(parseFloat(x.day_rev)||0),0);
          const tSales = sRows.reduce((a,x)=>a+(parseFloat(x.day_sales)||0),0);
          const ln = [`📊 营收分析（${s} | ${p.label}）`, `\n- **实收营业额**: ${tRev.toFixed(2)} (已扣优惠)`];
          if (tSales>0) ln.push(`- **折前营业额**: ${tSales.toFixed(1)}`);
          ln.push(`\n> 数据源：sales_raw（共${sRows.length}天）`);
          return ln.join('\n');
        }
      } catch(_e){}
      return `📊 ${p.label}营收分析（${s}）：暂无营业数据。`;
    }
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const totalDays = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
    let cumRev=0, cumPre=0, mBudget=0, mDays=0, cumLabor=0;
    try {
      const mR = await query(`SELECT COALESCE(SUM(actual_revenue),0) cr, COALESCE(SUM(pre_discount_revenue),0) cp,
        COALESCE(SUM(budget),0) b, COUNT(*) d, COALESCE(SUM(labor_total),0) cl
        FROM daily_reports WHERE lower(regexp_replace(coalesce(store,''),'\\s+','','g')) LIKE $1 AND date>=$2 AND date<=$3`,
        [sl, monthStart, p.end||monthStart]);
      const m = mR.rows?.[0]||{};
      cumRev=parseFloat(m.cr)||0; cumPre=parseFloat(m.cp)||0; mBudget=parseFloat(m.b)||0; mDays=parseInt(m.d)||0; cumLabor=parseFloat(m.cl)||0;
    } catch(_e){}
    try {
      const rtR = await query(`SELECT target_revenue FROM revenue_targets WHERE lower(regexp_replace(coalesce(store,''),'\\s+','','g')) LIKE $1 AND period=$2 LIMIT 1`, [sl, monthStart.slice(0,7)]);
      if (rtR.rows?.[0]?.target_revenue) mBudget = parseFloat(rtR.rows[0].target_revenue)||mBudget;
    } catch(_e){}

    if (rows.length <= 2) {
      const row = rows[0];
      const aRev = parseFloat(row.actual_revenue)||0;
      const pDis = parseFloat(row.pre_discount_revenue)||0;
      const tDis = parseFloat(row.total_discount)||0;
      if (!mBudget) mBudget = parseFloat(row.budget)||0;
      const lines = [`📊 **营收分析 | ${s}**`, `📅 ${p.label}`, '─────────────────────'];
      lines.push(`💰 **实收营业额**: ¥${aRev.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}（已扣优惠）`);
      if (pDis>0) lines.push(`💳 **折前营业额**: ¥${pDis.toLocaleString('zh-CN',{minimumFractionDigits:1,maximumFractionDigits:1})}`);
      if (tDis>0) lines.push(`🏷️ **总折扣金额**: ¥${tDis.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}`);
      lines.push('─────────────────────','📈 **目标达成情况**');
      if (mBudget>0) {
        const ar = (cumRev/mBudget*100).toFixed(1), tr = (mDays/totalDays*100).toFixed(1);
        const an=parseFloat(ar), tn=parseFloat(tr);
        lines.push(`${an>=tn?'✅':an>=tn-5?'⚠️':'🔴'} **实收达成率**: ${ar}%（累计 ¥${cumRev.toLocaleString('zh-CN',{minimumFractionDigits:0})} / 目标 ¥${mBudget.toLocaleString('zh-CN',{minimumFractionDigits:0})}）`);
        lines.push(`📐 **理论达成率**: ${tr}%（${mDays}/${totalDays}天）`);
        const gap = an-tn;
        lines.push(`${gap>=0?'🟢':'🔴'} **进度差值**: ${gap>=0?'+':''}${gap.toFixed(1)}%（${gap>=0?'超前':'落后'}目标进度）`);
      }
      lines.push('─────────────────────','🔍 **其他指标**');
      const mg = row.actual_margin!=null ? parseFloat(row.actual_margin) : null;
      lines.push(mg!=null&&!isNaN(mg) ? `📊 **毛利率**: ${mg.toFixed(1)}%` : `📊 **毛利率**: 暂无`);
      const dp = row.dianping_rating!=null ? parseFloat(row.dianping_rating) : null;
      if (dp!=null&&!isNaN(dp)) lines.push(`⭐ **大众点评**: ${dp.toFixed(2)} 分`);
      const ef = row.efficiency!=null ? parseFloat(row.efficiency) : null;
      const lb = row.labor_total!=null ? parseFloat(row.labor_total) : null;
      if (ef!=null&&!isNaN(ef)&&ef>0) {
        lines.push(`👥 **今日人效值**: ¥${Math.round(ef).toLocaleString('zh-CN')}${lb!=null&&!isNaN(lb)&&lb>0?`（出勤 ${lb.toFixed(0)} 工时）`:''}`);
      } else if (lb!=null&&!isNaN(lb)&&lb>0&&aRev>0) {
        lines.push(`👥 **今日人效值**: ¥${Math.round(aRev/lb).toLocaleString('zh-CN')}（出勤 ${lb.toFixed(0)} 工时）`);
      }
      const nw = row.new_wechat_members!=null ? parseInt(row.new_wechat_members) : null;
      if (nw!=null&&!isNaN(nw)) lines.push(`📱 **新增企微会员**: ${nw}人`);
      const dineOrd = row.dine_orders!=null ? parseInt(row.dine_orders) : null;
      const delOrd = row.delivery_orders!=null ? parseInt(row.delivery_orders) : null;
      if (dineOrd!=null&&!isNaN(dineOrd)) lines.push(`🍽 **堂食单数**: ${dineOrd}`);
      if (delOrd!=null&&!isNaN(delOrd)) lines.push(`🛵 **外卖单数**: ${delOrd}`);
      return lines.join('\n');
    }
    // Multi-day
    const totRev = rows.reduce((a,r2)=>a+(parseFloat(r2.actual_revenue)||0),0);
    const totPre = rows.reduce((a,r2)=>a+(parseFloat(r2.pre_discount_revenue)||0),0);
    const totDisc = rows.reduce((a,r2)=>a+(parseFloat(r2.total_discount)||0),0);
    const amArr = rows.filter(r2=>r2.actual_margin!=null);
    const amVal = amArr.length ? (amArr.reduce((a,r2)=>a+parseFloat(r2.actual_margin),0)/amArr.length).toFixed(1) : null;
    const dpR = rows.filter(r2=>r2.dianping_rating!=null);
    const avgDp = dpR.length ? (dpR.reduce((a,r2)=>a+parseFloat(r2.dianping_rating),0)/dpR.length).toFixed(2) : null;
    const lines = [`📊 **营收分析 | ${s}**`, `📅 ${p.label}`, '─────────────────────'];
    lines.push(`💰 **实收营业额**: ¥${totRev.toLocaleString('zh-CN',{minimumFractionDigits:0})}（${rows.length}天合计）`);
    if (totPre>0) lines.push(`💳 **折前营业额**: ¥${totPre.toLocaleString('zh-CN',{minimumFractionDigits:0})}`);
    if (totDisc>0) lines.push(`🏷️ **总折扣金额**: ¥${totDisc.toLocaleString('zh-CN',{minimumFractionDigits:0})}`);
    lines.push(`📆 **日均实收**: ¥${Math.round(totRev/rows.length).toLocaleString('zh-CN')}`);
    lines.push('─────────────────────','📈 **目标达成情况**');
    if (mBudget>0) {
      const ar=(cumRev/mBudget*100).toFixed(1), tr=(mDays/totalDays*100).toFixed(1);
      const an=parseFloat(ar), tn=parseFloat(tr);
      lines.push(`${an>=tn?'✅':an>=tn-5?'⚠️':'🔴'} **实收达成率**: ${ar}%`);
      lines.push(`📐 **理论达成率**: ${tr}%（${mDays}/${totalDays}天）`);
    }
    if (amVal) lines.push(`📊 **平均毛利率**: ${amVal}%`);
    if (avgDp) lines.push(`⭐ **大众点评均分**: ${avgDp}`);
    const totLabor = rows.reduce((a,r2)=>a+(parseFloat(r2.labor_total)||0),0);
    if (totLabor>0&&totRev>0) lines.push(`👥 **累计人效值**: ¥${Math.round(totRev/totLabor).toLocaleString('zh-CN')}（累计 ${totLabor.toFixed(0)} 工时）`);
    const totWechat = rows.reduce((a,r2)=>a+(parseInt(r2.new_wechat_members)||0),0);
    if (totWechat>0) lines.push(`📱 **新增企微会员**: ${totWechat}人`);
    return lines.join('\n');
  } catch(e) { return `营收分析查询失败：${e?.message||'未知错误'}`; }
}

// ── 9. Sales Top (销售排行) ──────────────────────────

async function buildSalesTopReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (/(投诉|差评|负评|客诉)/.test(q)) return '';
  if (!/(热销|畅销|top|TOP|销量|卖得|卖的|销售明细|销售排行|销售排名|卖得最好|卖得最差|最好.*(产品|菜品)|最差.*(产品|菜品)|前\d+|后\d+|外卖.*最差|外卖.*最好)/.test(q)) return '';
  const p = resolveDateRange(q, 30);
  const resolvedStore = await resolveDbStoreName('sales_raw', s);
  let bizSql = '';
  if (/(外卖|delivery)/i.test(q)) bizSql = ` AND lower(regexp_replace(COALESCE(s.biz_type,''),'\\s+','','g')) IN ('takeaway','delivery','外卖','外送')`;
  else if (/(堂食|dinein|店内)/i.test(q)) bizSql = ` AND lower(regexp_replace(COALESCE(s.biz_type,''),'\\s+','','g')) IN ('dinein','堂食','店内','堂食点餐')`;
  const limMatch = q.match(/(top|TOP|前)\s*(\d{1,2})/);
  const limit = Math.max(1, Math.min(20, Number(limMatch?.[2]||10)||10));
  const worst = /(最差|最不好卖|倒数|垫底|卖不动|后\d+)/.test(q);
  const sort = worst ? 'ASC' : 'DESC';
  try {
    const r = await query(
      `SELECT s.dish_name, ROUND(SUM(COALESCE(s.qty,0))::numeric,2) AS tq,
              ROUND(SUM(COALESCE(s.sales_amount,0))::numeric,2) AS ts,
              ROUND(SUM(COALESCE(s.revenue,0))::numeric,2) AS tr
       FROM sales_raw s WHERE lower(regexp_replace(COALESCE(s.store,''),'\\s+','','g'))=$1
         AND s.date BETWEEN $2 AND $3 ${bizSql} AND COALESCE(s.dish_name,'')<>''
       GROUP BY s.dish_name HAVING SUM(COALESCE(s.qty,0))>0
       ORDER BY SUM(COALESCE(s.sales_amount,0)) ${sort} LIMIT ${limit}`,
      [storeKey(resolvedStore), p.start, p.end]);
    const rows = r.rows||[];
    if (!rows.length) return `📦 ${p.label}销售数据（${s}）：暂无可用销售明细数据。`;
    const title = worst ? `销售倒数${limit}` : `销售TOP${limit}`;
    const lines = [`📦 ${title}（${s}·${p.label}）`];
    rows.forEach((x,i) => lines.push(`${i+1}. ${x.dish_name}｜折前¥${Number(x.ts||0).toFixed(0)}｜实收¥${Number(x.tr||0).toFixed(0)}｜销量${Number(x.tq||0).toFixed(0)}份`));
    lines.push('> 数据源：sales_raw（门店销售明细）');
    return lines.join('\n');
  } catch(e) { return `销售排行查询失败：${e?.message||'未知错误'}`; }
}

// ── 10. Loss Report (报损) ─────────────────────────────

async function buildLossReportReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (!/(报损|损耗|废弃|丢弃|浪费|loss)/.test(q)) return '';
  const p = resolveDateRange(q, 7);
  try {
    const r = await query(`SELECT fields, created_at FROM feishu_generic_records WHERE config_key='loss_report' ORDER BY updated_at DESC LIMIT 3000`);
    const all = (r.rows||[]).map(row => ({ f: row.fields && typeof row.fields==='object' ? row.fields : {}, ca: row.created_at }));
    const matched = all.filter(x => sameStore(ext(x.f['所属门店']||x.f['门店']), s));
    const rows = matched.filter(x => {
      const d = bitableDate(x.f['日期'], x.ca);
      return d && inRange(d, p.start, p.end);
    });
    if (!rows.length) return `📦 ${p.label}报损记录（${s}）：暂无报损数据。`;
    const dishMap = new Map(), deptMap = new Map(), reasonMap = new Map();
    let totalQty = 0;
    for (const x of rows) {
      const dish = ext(x.f['报损菜品']); 
      const qty = parseFloat(ext(x.f['报损数量'])) || 1;
      const dept = ext(x.f['报损部门']);
      const reason = ext(x.f['报损原因']);
      if (dish) dishMap.set(dish, (dishMap.get(dish)||0) + qty);
      if (dept) deptMap.set(dept, (deptMap.get(dept)||0) + 1);
      if (reason) reasonMap.set(reason, (reasonMap.get(reason)||0) + 1);
      totalQty += qty;
    }
    const dishSorted = topN(dishMap, 10);
    const lines = [`📦 报损记录（${s}·${p.label}）`, `- 报损记录：${rows.length}条`, `- 报损总数量：${totalQty}`];
    if (deptMap.size) lines.push(`- 报损部门：${topN(deptMap,5).map(([k,v])=>`${k}(${v}次)`).join('、')}`);
    if (dishSorted.length) {
      lines.push('','🍽 报损产品明细：');
      dishSorted.forEach(([dish, qty], i) => {
        const reasons = [];
        for (const x of rows) {
          if (ext(x.f['报损菜品']) === dish) {
            const r2 = ext(x.f['报损原因']);
            if (r2) reasons.push(r2);
          }
        }
        const uniqueReasons = [...new Set(reasons)].slice(0, 2);
        lines.push(`${i+1}. ${dish}（${qty}${uniqueReasons.length ? '，原因：'+uniqueReasons.join('、') : ''}）`);
      });
    }
    if (reasonMap.size) {
      lines.push('','📋 报损原因汇总：');
      topN(reasonMap, 5).forEach(([r2,c], i) => lines.push(`${i+1}. ${r2}（${c}次）`));
    }
    return lines.join('\n');
  } catch(e) { return `报损数据查询失败：${e?.message||'未知错误'}`; }
}

// ── 11. Sales Analysis (销售分析+高峰期) ──────────────

async function buildSalesAnalysisReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (!/(什么.*卖.*好|什么.*卖.*差|高峰|几点.*忙|几点.*多|堂食.*产品|外卖.*产品|产品.*销售|销售.*分析|卖.*最好|卖.*最差)/.test(q)) return '';
  const p = resolveDateRange(q, 7);
  const resolvedStore = await resolveDbStoreName('sales_raw', s);
  const sk = storeKey(resolvedStore);
  try {
    // Determine biz type filter
    let bizFilter = '';
    let bizLabel = '全渠道';
    if (/(外卖|delivery)/i.test(q)) { bizFilter = ` AND lower(regexp_replace(COALESCE(s.biz_type,''),'\\s+','','g')) IN ('takeaway','delivery','外卖','外送')`; bizLabel = '外卖'; }
    else if (/(堂食|dinein|店内)/i.test(q)) { bizFilter = ` AND lower(regexp_replace(COALESCE(s.biz_type,''),'\\s+','','g')) IN ('dinein','堂食','店内','堂食点餐')`; bizLabel = '堂食'; }

    // Top products
    const topR = await query(
      `SELECT s.dish_name, ROUND(SUM(COALESCE(s.qty,0))::numeric,2) AS tq,
              ROUND(SUM(COALESCE(s.sales_amount,0))::numeric,2) AS ts
       FROM sales_raw s WHERE lower(regexp_replace(COALESCE(s.store,''),'\\s+','','g'))=$1
         AND s.date BETWEEN $2 AND $3 ${bizFilter} AND COALESCE(s.dish_name,'')<>''
       GROUP BY s.dish_name HAVING SUM(COALESCE(s.qty,0))>0
       ORDER BY SUM(COALESCE(s.sales_amount,0)) DESC LIMIT 10`,
      [sk, p.start, p.end]);
    const botR = await query(
      `SELECT s.dish_name, ROUND(SUM(COALESCE(s.qty,0))::numeric,2) AS tq,
              ROUND(SUM(COALESCE(s.sales_amount,0))::numeric,2) AS ts
       FROM sales_raw s WHERE lower(regexp_replace(COALESCE(s.store,''),'\\s+','','g'))=$1
         AND s.date BETWEEN $2 AND $3 ${bizFilter} AND COALESCE(s.dish_name,'')<>''
       GROUP BY s.dish_name HAVING SUM(COALESCE(s.qty,0))>0
       ORDER BY SUM(COALESCE(s.sales_amount,0)) ASC LIMIT 5`,
      [sk, p.start, p.end]);

    // Peak hours
    const peakR = await query(
      `SELECT EXTRACT(HOUR FROM s.order_time::time) AS hr, COUNT(*) AS cnt,
              ROUND(SUM(COALESCE(s.revenue,0))::numeric,2) AS rev
       FROM sales_raw s WHERE lower(regexp_replace(COALESCE(s.store,''),'\\s+','','g'))=$1
         AND s.date BETWEEN $2 AND $3 ${bizFilter} AND s.order_time IS NOT NULL
       GROUP BY hr ORDER BY cnt DESC LIMIT 5`,
      [sk, p.start, p.end]);

    const topRows = topR.rows||[], botRows = botR.rows||[], peakRows = peakR.rows||[];
    if (!topRows.length && !peakRows.length) return '';

    const lines = [`📊 ${bizLabel}销售分析（${s}·${p.label}）`];
    if (topRows.length) {
      lines.push('','🔥 **畅销产品TOP10**：');
      topRows.forEach((x,i) => lines.push(`${i+1}. ${x.dish_name}｜¥${Number(x.ts||0).toFixed(0)}｜${Number(x.tq||0).toFixed(0)}份`));
    }
    if (botRows.length) {
      lines.push('','📉 **滞销产品TOP5**：');
      botRows.forEach((x,i) => lines.push(`${i+1}. ${x.dish_name}｜¥${Number(x.ts||0).toFixed(0)}｜${Number(x.tq||0).toFixed(0)}份`));
    }
    if (peakRows.length) {
      lines.push('','⏰ **高峰时段**：');
      peakRows.forEach((x) => {
        const h = parseInt(x.hr);
        lines.push(`- ${h}:00-${h+1}:00｜${x.cnt}笔｜¥${Number(x.rev||0).toFixed(0)}`);
      });
    }
    return lines.join('\n');
  } catch(e) { return `销售分析查询失败：${e?.message||'未知错误'}`; }
}

// ── Main Dispatcher ──────────────────────────────────

export async function tryDeterministicReply(text, ctx) {
  const q = String(text||'').trim();
  if (!q) return '';
  const store = ctx.store || '';
  try {
    // Identity
    let reply = await buildIdentityReply(q, ctx);
    if (reply) return reply;
    // Table visit
    reply = await buildTableVisitReply(store, q);
    if (reply) return reply;
    // Bad review
    reply = await buildBadReviewReply(store, q);
    if (reply) return reply;
    // Closing report
    reply = await buildClosingReportReply(store, q);
    if (reply) return reply;
    // Opening report
    reply = await buildOpeningReportReply(store, q);
    if (reply) return reply;
    // Meeting report
    reply = await buildMeetingReportReply(store, q);
    if (reply) return reply;
    // Material report
    reply = await buildMaterialReportReply(store, q);
    if (reply) return reply;
    // Loss report
    reply = await buildLossReportReply(store, q);
    if (reply) return reply;
    // Sales analysis (产品销售+高峰期)
    reply = await buildSalesAnalysisReply(store, q);
    if (reply) return reply;
    // Daily report (revenue)
    reply = await buildDailyReportReply(store, q);
    if (reply) return reply;
    // Sales top
    reply = await buildSalesTopReply(store, q);
    if (reply) return reply;
  } catch(e) {
    logger.error({ err: e?.message }, 'deterministic reply error');
  }
  return '';
}
