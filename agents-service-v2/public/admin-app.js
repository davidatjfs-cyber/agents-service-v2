// ═══════════════════════════════════════════════════════
// Agent Ops Admin — Comprehensive Admin Panel v2
// ═══════════════════════════════════════════════════════
'use strict';

// ── API Layer ──
// Detect if running through nginx proxy (/agents-admin/) or directly on port 3100
const BASE = (() => {
  const loc = window.location;
  // If path starts with /agents-admin, we're behind nginx — use /agents-admin as base
  if (loc.pathname.startsWith('/agents-admin')) return loc.origin + '/agents-admin';
  // Otherwise direct access — derive from script src or use empty
  const s = document.currentScript?.src || '';
  const i = s.lastIndexOf('/');
  return i > 0 ? s.substring(0, i) : '';
})();
async function api(m, p, b) {
  const o = { method: m, headers: { 'Content-Type': 'application/json' } };
  const t = localStorage.getItem('aat');
  if (t) o.headers['Authorization'] = 'Bearer ' + t;
  if (b) o.body = JSON.stringify(b);
  const r = await fetch(BASE + p, o);
  let data = {};
  try { data = await r.json(); } catch (_e) { data = {}; }
  if (r.status === 401) throw new Error('auth');
  if (!r.ok) throw new Error(data.error || data.message || ('请求失败 HTTP ' + r.status));
  return data;
}
const G = p => api('GET', p), PUT = (p, b) => api('PUT', p, b), POST = (p, b) => api('POST', p, b), DEL = p => api('DELETE', p);
function catchNonAuth(e) { if (e?.message === 'auth') throw e; return null; }

/** 与后端 agent-activity 默认日期一致：上海日历当日 */
function shanghaiTodayInputDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

// ── State ──
const AN = { master: 'Master调度中枢', data_auditor: '数据审计', ops_supervisor: '运营督导', chief_evaluator: '绩效考核', train_advisor: '培训顾问', appeal: '申诉处理', marketing_planner: '营销策划', marketing_executor: '营销执行', procurement_advisor: '采购建议' };
let tab = 'dashboard';
let S = { hl: {}, st: {}, fs: {}, agents: {}, rules: [], scores: {}, campaigns: [], templates: [], evalReport: {}, auditItems: [], cfgs: [], schedCfg: {}, anomalyCfg: {}, perfCfg: {}, ratingCfg: {}, kpiTargets: [], kbItems: [], memoryItems: [], knowledgeSources: null, knowledgeSourcesErr: '', featureFlags: {}, selectedAgent: 'data_auditor', activity: {}, activityDate: shanghaiTodayInputDate(), drillData: [], bitableStatus: {}, chairmanCfg: {}, chairmanTab: 'stores' };

// ── DOM Helpers ──
function $(id) { return document.getElementById(id); }
function el(t, a, c) {
  const e = document.createElement(t);
  if (a) Object.entries(a).forEach(([k, v]) => {
    if (k.startsWith('on')) e[k] = v;
    else if (k === 'className') e.className = v;
    else if (k === 'value') e.value = v;
    else if (k === 'innerHTML') e.innerHTML = v;
    else if (k === 'checked') e.checked = v;
    else e.setAttribute(k, v);
  });
  if (typeof c === 'string') e.textContent = c;
  else if (c instanceof HTMLElement) e.appendChild(c);
  else if (Array.isArray(c)) c.forEach(x => { if (x) e.appendChild(x); });
  return e;
}
function card(title, children) {
  const w = el('div', { className: 'bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-4' });
  if (title) w.appendChild(el('h3', { className: 'text-base font-semibold text-gray-800 mb-4 pb-2 border-b border-gray-100' }, title));
  if (Array.isArray(children)) children.forEach(c => { if (c) w.appendChild(c); });
  else if (children) w.appendChild(children);
  return w;
}
function stat(n, l, color) {
  const d = el('div', { className: 'bg-white rounded-xl shadow-sm border border-gray-100 p-5 text-center' });
  d.appendChild(el('div', { className: 'text-2xl font-bold ' + (color || 'text-indigo-600') }, String(n)));
  d.appendChild(el('div', { className: 'text-xs text-gray-500 mt-1' }, l));
  return d;
}
function btn(label, onClick, cls) {
  return el('button', { className: cls || 'bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors font-medium', onclick: onClick }, label);
}
function btnDanger(label, onClick) { return btn(label, onClick, 'bg-red-50 text-red-600 text-sm px-3 py-1.5 rounded-lg hover:bg-red-100 transition-colors font-medium border border-red-200'); }
function btnGhost(label, onClick) { return btn(label, onClick, 'bg-gray-50 text-gray-700 text-sm px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors font-medium border border-gray-200'); }
function inp(id, ph, tp, cls) { return el('input', { id, type: tp || 'text', className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm w-full focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none transition ' + (cls || ''), placeholder: ph }); }
function lbl(text) { return el('label', { className: 'block text-xs font-medium text-gray-600 mb-1' }, text); }
function field(label, inputEl) { const d = el('div', { className: 'mb-3' }); d.appendChild(lbl(label)); d.appendChild(inputEl); return d; }
function msg(t, isErr) {
  let m = $('toast');
  if (!m) { m = el('div', { id: 'toast', className: 'fixed top-4 right-4 px-5 py-3 rounded-xl shadow-lg text-sm z-50 font-medium transition-all' }); document.body.appendChild(m); }
  m.className = 'fixed top-4 right-4 px-5 py-3 rounded-xl shadow-lg text-sm z-50 font-medium transition-all ' + (isErr ? 'bg-red-500 text-white' : 'bg-emerald-500 text-white');
  m.textContent = t; m.style.display = 'block'; setTimeout(() => m.style.display = 'none', 3000);
}
function fmtDate(d) { if (!d) return '-'; return String(typeof d === 'string' ? d : d.toISOString?.() || '').slice(0, 10); }
function fmtTime(d) { if (!d) return '-'; const s = String(typeof d === 'string' ? d : d.toISOString?.() || ''); return s.length > 16 ? s.slice(11, 16) : s; }

/** 从 JWT 解析 payload（仅读 role，不做签名校验；补全 aau 缺失时的权限判断） */
function readJwtPayload() {
  try {
    const t = localStorage.getItem('aat') || '';
    const b64 = (t.split('.')[1] || '').replace(/-/g, '+').replace(/_/g, '/');
    if (!b64) return null;
    return JSON.parse(atob(b64));
  } catch (_e) {
    return null;
  }
}

/** 旧会话可能只有 aat 无 aau；从 JWT 补全 role，避免下钻表不显示「关闭」 */
function syncAauFromJwt() {
  try {
    const pl = readJwtPayload();
    if (!pl?.role) return;
    let u = {};
    try { u = JSON.parse(localStorage.getItem('aau') || '{}'); } catch (_e) {}
    if (!String(u.role || '').trim()) {
      localStorage.setItem('aau', JSON.stringify({
        username: pl.username || u.username || '',
        role: pl.role,
        store: pl.store != null ? pl.store : u.store
      }));
    }
  } catch (_e) { /* ignore */ }
}

/**
 * 异常触发「描述」：库内多为 trigger_value JSON，避免直接塞一整段 raw JSON
 */
function formatAnomalyTriggerDisplay(row) {
  const key = String(row?.anomaly_key || row?.category || '').trim();
  let v = row?.trigger_value;
  const rawDesc = row?.description;
  if (v == null && rawDesc && typeof rawDesc === 'string' && rawDesc.trim().startsWith('{')) {
    try { v = JSON.parse(rawDesc); } catch (_e) { /* 保持下方走原文 */ }
  }
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch (_e) {
      const s = String(rawDesc || v || '-');
      return s.length > 160 ? s.slice(0, 157) + '…' : s;
    }
  }
  if (!v || typeof v !== 'object') {
    const s = String(rawDesc || '-');
    return s.length > 160 ? s.slice(0, 157) + '…' : s;
  }
  if (key === 'traffic_decline' || (v.lastWeek && (v.thisWeek != null || v.trafficDecline != null || v.ordersDecline != null))) {
    const lw = v.lastWeek || {};
    const tw = v.thisWeek || {};
    const parts = [];
    if (lw.orders != null || lw.traffic != null) {
      parts.push('上周：单量 ' + (lw.orders ?? '—') + ' · 客流 ' + (lw.traffic ?? '—'));
    }
    if (tw.orders != null || tw.traffic != null) {
      parts.push('本周：单量 ' + (tw.orders ?? '—') + ' · 客流 ' + (tw.traffic ?? '—'));
    }
    if (v.trafficDecline != null || v.ordersDecline != null) {
      parts.push('环比下滑：客流 ' + (v.trafficDecline ?? '—') + '% · 订单 ' + (v.ordersDecline ?? '—') + '%');
    }
    if (parts.length) return parts.join('；');
  }
  try {
    const s = JSON.stringify(v);
    return s.length > 160 ? s.slice(0, 157) + '…' : s;
  } catch (_e) {
    return '-';
  }
}
const STS = { planned: '🟡 计划中', active: '🟢 执行中', completed: '✅ 已完成', cancelled: '⛔ 已取消' };
const SEV_CLS = { high: 'bg-red-100 text-red-700', medium: 'bg-orange-100 text-orange-700', low: 'bg-yellow-100 text-yellow-700' };
function showModal(title, contentEl) {
  const modal = el('div', { className: 'fixed inset-0 bg-black/50 flex items-center justify-center z-50', onclick: e => { if (e.target === modal) modal.remove(); } });
  const box = el('div', { className: 'bg-white rounded-2xl shadow-2xl p-6 w-full max-w-4xl max-h-[80vh] overflow-auto mx-4' });
  box.appendChild(el('div', { className: 'flex justify-between items-center mb-4 pb-3 border-b border-gray-100' }, [
    el('h3', { className: 'font-bold text-lg text-gray-900' }, title),
    btn('✕ 关闭', () => modal.remove(), 'text-sm text-gray-500 hover:text-red-500 bg-transparent font-bold')
  ]));
  box.appendChild(contentEl); modal.appendChild(box); document.body.appendChild(modal);
}

// ═══════════════════════════════════════════════════════
// LOGIN (no inline handlers — uses el() onclick)
// ═══════════════════════════════════════════════════════
function renderLogin() {
  const a = $('app'); a.innerHTML = '';
  const wrap = el('div', { className: 'min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-purple-50' });
  const box = el('div', { className: 'w-full max-w-md bg-white rounded-2xl shadow-xl border border-gray-100 p-8' });
  box.appendChild(el('div', { className: 'text-center mb-8' }, [
    el('div', { className: 'text-5xl mb-3' }, '🤖'),
    el('h1', { className: 'text-2xl font-bold text-gray-900' }, 'Agent Ops Admin'),
    el('p', { className: 'text-sm text-gray-500 mt-1' }, 'Agents Service V2 管理面板')
  ]));
  box.appendChild(field('用户名', inp('lu', '请输入用户名')));
  const pwdInp = inp('lp', '请输入密码', 'password');
  pwdInp.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  box.appendChild(field('密码', pwdInp));
  box.appendChild(el('div', { id: 'lerr', className: 'text-red-500 text-xs mb-3 hidden' }));
  box.appendChild(btn('登 录', doLogin, 'w-full bg-indigo-600 text-white rounded-lg py-3 hover:bg-indigo-700 transition-colors font-semibold text-base'));
  // Token login
  const det = el('details', { className: 'mt-6' });
  det.appendChild(el('summary', { className: 'text-xs text-gray-400 cursor-pointer hover:text-gray-600' }, '高级: Token登录'));
  const detBox = el('div', { className: 'mt-2' });
  detBox.appendChild(inp('ti', 'JWT Token', 'password', 'text-xs'));
  detBox.appendChild(btn('Token登录', doTokenLogin, 'w-full mt-2 bg-gray-100 text-gray-600 text-xs rounded-lg py-2 hover:bg-gray-200'));
  det.appendChild(detBox);
  box.appendChild(det);
  wrap.appendChild(box); a.appendChild(wrap);
}

async function doLogin() {
  const u = $('lu')?.value?.trim(), p = $('lp')?.value?.trim(), errEl = $('lerr');
  if (!u || !p) { if (errEl) { errEl.textContent = '请输入用户名和密码'; errEl.classList.remove('hidden'); } return; }
  try {
    const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
    const d = await r.json();
    if (d.ok && d.token) {
      localStorage.setItem('aat', d.token);
      if (d.user) localStorage.setItem('aau', JSON.stringify(d.user));
      else localStorage.removeItem('aau');
      go('dashboard');
    }
    else { if (errEl) { errEl.textContent = d.error || '登录失败'; errEl.classList.remove('hidden'); } }
  } catch (e) { if (errEl) { errEl.textContent = '网络错误'; errEl.classList.remove('hidden'); } }
}
function doTokenLogin() {
  const t = $('ti')?.value?.trim();
  if (t) {
    localStorage.setItem('aat', t);
    try {
      const p = (t.split('.')[1] || '').replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(p));
      if (payload?.role) localStorage.setItem('aau', JSON.stringify({ username: payload.username, role: payload.role }));
    } catch (_e) { /* ignore */ }
    go('dashboard');
  }
}

/** 控制台「关闭任务」：与后端 CLOSE_TASK_ROLES 一致；aau 缺 role 时从 JWT 读取 */
function canCloseTasksInAdminUi() {
  try {
    const u = JSON.parse(localStorage.getItem('aau') || '{}');
    let r = String(u.role || '').trim();
    if (!r) {
      const pl = readJwtPayload();
      r = String(pl?.role || '').trim();
    }
    return r === 'admin' || r === 'hq_manager' || r === 'hr_manager';
  } catch (_e) {
    return false;
  }
}

// ═══════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════
function drillStat(n, l, color, drillType) {
  const d = el('div', { className: 'bg-white rounded-xl shadow-sm border border-gray-100 p-5 text-center cursor-pointer hover:shadow-md hover:border-indigo-200 transition-all group', onclick: () => openDrill(drillType) });
  d.appendChild(el('div', { className: 'text-2xl font-bold ' + (color || 'text-indigo-600') }, String(n)));
  d.appendChild(el('div', { className: 'text-xs text-gray-500 mt-1 group-hover:text-indigo-600 transition-colors' }, l + ' 🔍'));
  return d;
}
async function openDrill(type) {
  const content = el('div');
  const titleMap = { anomalies: '异常详情(近7天)', tasks: '未闭环任务', messages: '24h消息详情', rhythm: '节奏执行日志' };
  try {
    const data = await G('/api/dashboard-detail/' + type);
    const items = data.items || [];
    if (!items.length) {
      content.appendChild(el('p', { className: 'text-gray-500 text-sm py-8 text-center' }, '暂无数据'));
      showModal(titleMap[type] || ('详情 — ' + type), content);
      return;
    }
    const tbl = el('table', { className: 'w-full text-sm' });
    const thead = el('thead'); const hr = el('tr', { className: 'bg-gray-50' });
    if (type === 'anomalies') { ['门店','异常类型','严重度','描述','日期','状态'].forEach(h => hr.appendChild(el('th', { className: 'p-2 text-left text-xs font-semibold text-gray-600' }, h))); }
    else if (type === 'tasks') {
      const ths = ['任务ID', '标题', '门店', '严重度', '状态', '处理Agent', '已开(h)', '创建时间'];
      if (canCloseTasksInAdminUi()) ths.push('操作');
      ths.forEach((h) => hr.appendChild(el('th', { className: 'p-2 text-left text-xs font-semibold text-gray-600' }, h)));
    }
    else if (type === 'messages') { ['Agent','门店','用户','延迟ms','证据','时间'].forEach(h => hr.appendChild(el('th', { className: 'p-2 text-left text-xs font-semibold text-gray-600' }, h))); }
    else if (type === 'rhythm') { ['类型','状态','执行日期','耗时','详情'].forEach(h => hr.appendChild(el('th', { className: 'p-2 text-left text-xs font-semibold text-gray-600' }, h))); }
    thead.appendChild(hr); tbl.appendChild(thead);
    const tbody = el('tbody');
    let drillTasksFooter = null;
    let drillTasksHintEl = null;
    items.forEach(it => {
      const tr = el('tr', { className: 'hover:bg-gray-50 border-b border-gray-100' });
      if (type === 'anomalies') {
        tr.appendChild(el('td', { className: 'p-2 text-xs font-medium' }, it.store || '-'));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, it.anomaly_key || it.category || '-'));
        const sevBadge = el('span', { className: 'text-xs px-2 py-0.5 rounded-full font-medium ' + (SEV_CLS[it.severity] || 'bg-gray-100') }, it.severity || '-');
        tr.appendChild(el('td', { className: 'p-2' }, sevBadge));
        {
          const descText = formatAnomalyTriggerDisplay(it);
          tr.appendChild(el('td', { className: 'p-2 text-xs max-w-md', title: descText }, descText.length > 80 ? descText.slice(0, 77) + '…' : descText));
        }
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, fmtDate(it.trigger_date)));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, it.status || '-'));
      } else if (type === 'tasks') {
        const tid = String(it.task_id || '').trim();
        const idShort = tid.length > 8 ? tid.slice(0, 8) + '…' : (tid || '—');
        tr.appendChild(el('td', { className: 'p-2 text-xs font-mono', title: tid || '无任务ID' }, idShort));
        tr.appendChild(el('td', { className: 'p-2 text-xs font-medium max-w-xs truncate', title: it.title || '' }, it.title || '-'));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, it.store || '-'));
        const sevBadge = el('span', { className: 'text-xs px-2 py-0.5 rounded-full font-medium ' + (SEV_CLS[it.severity] || 'bg-gray-100') }, it.severity || '-');
        tr.appendChild(el('td', { className: 'p-2' }, sevBadge));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, it.status || '-'));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, it.agent || '-'));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, it.hours_open ? parseFloat(it.hours_open).toFixed(1) : '-'));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, fmtDate(it.created_at)));
        if (canCloseTasksInAdminUi()) {
          const opTd = el('td', { className: 'p-2 text-xs whitespace-nowrap' });
          const st = String(it.status || '');
          const canRowClose = tid && !['closed', 'settled'].includes(st);
          if (canRowClose) {
            opTd.appendChild(btn('关闭', async () => {
              if (!confirm('确认关闭此任务？\n\n' + tid)) return;
              try {
                await POST('/api/admin/task/' + encodeURIComponent(tid) + '/close', { reason: '仪表盘-未闭环任务下钻列表关闭' });
                msg('已关闭');
                tr.remove();
                const left = tbody.querySelectorAll('tr').length;
                if (drillTasksFooter) drillTasksFooter.textContent = left ? '共 ' + left + ' 条记录' : '';
                if (!left) {
                  tbl.remove();
                  if (drillTasksFooter) drillTasksFooter.remove();
                  if (drillTasksHintEl) drillTasksHintEl.remove();
                  content.appendChild(el('p', { className: 'text-gray-500 text-sm py-8 text-center' }, '暂无未闭环任务'));
                }
              } catch (e) { msg(e?.message || '关闭失败', true); }
            }, 'bg-rose-50 text-rose-700 text-xs px-2 py-1 rounded border border-rose-200 font-medium'));
          } else {
            opTd.appendChild(el('span', { className: 'text-gray-400' }, ['closed', 'settled'].includes(st) ? '已关' : '—'));
          }
          tr.appendChild(opTd);
        }
      } else if (type === 'messages') {
        tr.appendChild(el('td', { className: 'p-2 text-xs font-medium' }, AN[it.agent] || it.agent || '-'));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, it.store || '-'));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, it.username || '-'));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, it.latency_ms || '-'));
        tr.appendChild(el('td', { className: 'p-2' }, it.evidence_violation ? el('span',{className:'text-xs text-red-600 font-medium'},'⚠️违规') : el('span',{className:'text-xs text-green-600'},'✓')));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, fmtTime(it.created_at)));
      } else if (type === 'rhythm') {
        tr.appendChild(el('td', { className: 'p-2 text-xs font-medium' }, it.rhythm_type || '-'));
        const stBadge = el('span', { className: 'text-xs px-2 py-0.5 rounded-full font-medium ' + (it.status==='success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700') }, it.status || '-');
        tr.appendChild(el('td', { className: 'p-2' }, stBadge));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, fmtDate(it.execution_date)));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, it.execution_time ? parseFloat(it.execution_time).toFixed(1)+'s' : '-'));
        const detBtn = btnGhost('查看', () => {
          const s = typeof it.result_summary === 'object' ? JSON.stringify(it.result_summary, null, 2) : String(it.result_summary || it.error_message || '无');
          showModal(it.rhythm_type + ' 详情', el('pre', { className: 'text-xs bg-gray-50 p-4 rounded-lg font-mono overflow-auto max-h-96' }, s.slice(0,3000)));
        });
        tr.appendChild(el('td', { className: 'p-2' }, detBtn));
      }
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody); content.appendChild(tbl);
    drillTasksFooter = el('p', { className: 'text-xs text-gray-400 mt-3 text-right' }, '共 ' + items.length + ' 条记录');
    if (type === 'tasks' && canCloseTasksInAdminUi()) {
      drillTasksHintEl = el('p', { className: 'text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-3' },
        '每条任务可单独点「关闭」归档（需 admin / hq_manager / hr_manager 登录；鼠标悬停「任务ID」可看完整 ID）。');
      content.insertBefore(drillTasksHintEl, tbl);
    }
    content.appendChild(drillTasksFooter);
    showModal(titleMap[type] || ('详情 — ' + type), content);
  } catch (e) {
    if (e?.message === 'auth') { msg('登录已过期，请重新登录', true); return; }
    msg('加载失败: ' + (e?.message || '未知错误'), true);
  }
}
function viewDash() {
  const w = el('div');
  const tt = (S.st.tasks || []).reduce((s, t) => s + (t.c || 0), 0);
  const pend = (S.st.tasks || []).find(t => t.status === 'pending_response')?.c || 0;
  const row = el('div', { className: 'grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6' });
  row.appendChild(stat(S.hl.ok ? '🟢 在线' : '🔴 离线', '系统状态'));
  row.appendChild(drillStat(S.st.messages24h || 0, '24h消息量', 'text-blue-600', 'messages'));
  row.appendChild(drillStat(S.st.anomaliesToday || 0, '今日异常', S.st.anomaliesToday > 0 ? 'text-red-600' : 'text-green-600', 'anomalies'));
  row.appendChild(drillStat(tt, '总任务数', 'text-purple-600', 'tasks'));
  row.appendChild(drillStat(pend, '待处理', pend > 0 ? 'text-orange-600' : 'text-green-600', 'tasks'));
  w.appendChild(row);

  const svcRow = el('div', { className: 'grid grid-cols-1 md:grid-cols-4 gap-4 mb-6' });
  const svcCard = (icon, title, ok, detail) => {
    const c = el('div', { className: 'bg-white rounded-xl shadow-sm border p-4 flex items-center gap-3 ' + (ok ? 'border-green-200' : 'border-red-200') });
    c.appendChild(el('div', { className: 'text-2xl' }, icon));
    const info = el('div');
    info.appendChild(el('div', { className: 'font-semibold text-sm' }, title));
    info.appendChild(el('div', { className: 'text-xs ' + (ok ? 'text-green-600' : 'text-red-600') }, detail));
    c.appendChild(info); return c;
  };
  svcRow.appendChild(svcCard('🗄️', 'PostgreSQL', S.hl.database, S.hl.database ? '连接正常' : '未连接'));
  svcRow.appendChild(svcCard('⚡', 'Redis', S.hl.redis, S.hl.redis ? '连接正常' : '未连接'));
  svcRow.appendChild(svcCard('💬', '飞书', S.fs.configured, S.fs.configured ? (S.fs.hasToken ? 'Token有效' : '已配置/Token刷新中') : '未配置'));
  svcRow.appendChild(svcCard('🧠', 'LLM', true, '3 providers'));
  w.appendChild(svcRow);

  // 零代码核对：等同 curl /health 里的关键字段（打开本页即可，无需命令行）
  const re = S.hl.replyEngine != null ? String(S.hl.replyEngine) : '—';
  const dbWrOk = S.hl.dbWriteEnabled === true;
  w.appendChild(card('✅ 线上版本核对（不用敲命令）', (() => {
    const d = el('div', { className: 'text-sm space-y-2' });
    d.appendChild(el('p', { className: 'text-gray-600' },
      '下面两项来自本机请求的 /health。若与研发告知的版本不一致，说明服务器还没更新代码或未重启 pm2。'));
    d.appendChild(el('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-3' }, [
      el('div', { className: 'rounded-lg border p-3 ' + (re && re !== '—' ? 'border-indigo-200 bg-indigo-50' : 'border-gray-200') }, [
        el('div', { className: 'text-xs text-gray-500' }, 'replyEngine（代码构建号）'),
        el('div', { className: 'font-mono text-base font-semibold text-indigo-900' }, re)
      ]),
      el('div', { className: 'rounded-lg border p-3 ' + (dbWrOk ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50') }, [
        el('div', { className: 'text-xs text-gray-500' }, 'dbWriteEnabled（数据库是否可写）'),
        el('div', { className: 'font-semibold ' + (dbWrOk ? 'text-green-800' : 'text-red-800') }, dbWrOk ? 'true — 控制台可以保存' : 'false — 无法保存配置，需改 ECS 环境变量')
      ])
    ]));
    d.appendChild(el('p', { className: 'text-xs text-gray-400 mt-2' },
      '一键部署：GitHub 仓库 → Actions → agents-service-v2 → Run workflow → 勾选「部署到 ECS」（需先在 Settings → Secrets 配置 ECS_SSH_PRIVATE_KEY）。'));
    return d;
  })()));

  const dbWr = S.hl.dbWriteEnabled === true;
  const diCron = S.hl.dailyInspectionCron === true;
  const wsCron = S.hl.weeklyScoringCron === true;
  const trCron = S.hl.taskReminderCron === true;
  const auto = S.hl.automations === true;
  if (!dbWr || !diCron || !wsCron || !trCron) {
    const lines = [];
    if (!dbWr) lines.push('• 数据库被设为只读（ENABLE_DB_READ_ONLY=true 或 ENABLE_DB_WRITE=false）→ 无法保存配置。默认应可写；请检查 ECS 环境变量。');
    if (!diCron) lines.push('• 每日巡检未启动 → ENABLE_AUTOMATIONS=true 或 ENABLE_DAILY_INSPECTION_CRON=true 后重启 pm2。');
    if (!wsCron) lines.push('• 周度自动评分未启动 → ENABLE_AUTOMATIONS=true 或 ENABLE_WEEKLY_SCORING_CRON=true 后重启 pm2；或在「绩效考核」页手动执行一次。');
    if (!trCron) lines.push('• 任务卡 1h×3 催办未启动 → ENABLE_AUTOMATIONS=true 或 ENABLE_TASK_REMINDER_CRON=true 后重启 pm2。');
    const warn = el('div', { className: 'mb-4 p-4 rounded-xl border-2 border-red-300 bg-red-50 text-sm text-red-900' });
    warn.appendChild(el('div', { className: 'font-semibold mb-2' }, '⚠️ 控制中心无法正常工作'));
    warn.appendChild(el('div', { className: 'text-xs font-normal whitespace-pre-line text-red-800' }, lines.join('\n')));
    w.appendChild(warn);
  } else {
    w.appendChild(el('div', { className: 'mb-4 p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-xs text-emerald-800' },
      '✓ DB 可写 · 每日巡检 · 周度评分 · 任务催办 cron 已启用' + (auto ? ' · 全套自动化已开' : '（部分子开关独立开启）')));
  }

  // Task status breakdown
  const taskBreak = S.st.tasks || [];
  if (taskBreak.length) {
    w.appendChild(card('任务状态分布', (() => {
      const g = el('div', { className: 'flex flex-wrap gap-3' });
      taskBreak.forEach(t => {
        const clr = t.status === 'completed' ? 'bg-green-100 text-green-700' : t.status === 'pending_response' ? 'bg-orange-100 text-orange-700' : t.status === 'active' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-700';
        g.appendChild(el('div', { className: 'px-4 py-2 rounded-lg text-sm font-medium ' + clr }, (t.status || 'unknown') + ': ' + (t.c || 0)));
      });
      return g;
    })()));
  }

  // Quick actions
  w.appendChild(card('快捷操作', (() => {
    const g = el('div', { className: 'flex flex-wrap gap-3' });
    g.appendChild(btn('🔄 刷新系统状态', () => go('dashboard'), 'bg-blue-50 text-blue-700 text-sm px-4 py-2 rounded-lg hover:bg-blue-100 border border-blue-200 font-medium'));
    g.appendChild(btn('📋 Agent活动视图', () => go('activity'), 'bg-teal-50 text-teal-700 text-sm px-4 py-2 rounded-lg hover:bg-teal-100 border border-teal-200 font-medium'));
    g.appendChild(btn('🤖 查看Agent评估', () => go('evaluation'), 'bg-purple-50 text-purple-700 text-sm px-4 py-2 rounded-lg hover:bg-purple-100 border border-purple-200 font-medium'));
    g.appendChild(btn('📢 创建营销活动', () => go('marketing'), 'bg-emerald-50 text-emerald-700 text-sm px-4 py-2 rounded-lg hover:bg-emerald-100 border border-emerald-200 font-medium'));
    g.appendChild(btn('📝 查看审计日志', () => go('audit'), 'bg-gray-50 text-gray-700 text-sm px-4 py-2 rounded-lg hover:bg-gray-100 border border-gray-200 font-medium'));
    g.appendChild(btn('🧠 Agent记忆', () => go('memory'), 'bg-indigo-50 text-indigo-700 text-sm px-4 py-2 rounded-lg hover:bg-indigo-100 border border-indigo-200 font-medium'));
    g.appendChild(btn('📚 知识库管理', () => go('knowledge'), 'bg-amber-50 text-amber-700 text-sm px-4 py-2 rounded-lg hover:bg-amber-100 border border-amber-200 font-medium'));
    return g;
  })()));

  w.appendChild(el('div', { className: 'text-xs text-gray-400 mt-2' }, 'Uptime: ' + (S.hl.uptime ? Math.round(S.hl.uptime / 60) + ' min' : 'N/A') + ' | Version: ' + (S.hl.version || '?') + ' | ' + Object.keys(AN).length + ' Agents | ' + TABS.length + ' Tabs'));
  return w;
}

// ═══════════════════════════════════════════════════════
// AGENT ACTIVITY VIEW (每日任务执行清单)
// ═══════════════════════════════════════════════════════
function viewActivity() {
  const w = el('div');
  const A = S.activity || {};
  const adm = A.adminAlerts || [];

  // Header with date picker
  const hdr = el('div', { className: 'flex flex-wrap justify-between items-center mb-6 gap-3' });
  hdr.appendChild(el('h2', { className: 'text-lg font-bold text-gray-900' }, '📋 Agent 每日活动视图'));
  const dateRow = el('div', { className: 'flex items-center gap-2' });
  const dtInp = el('input', { id: 'actDate', type: 'date', className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-200 outline-none', value: S.activityDate });
  dateRow.appendChild(dtInp);
  dateRow.appendChild(btn('查询', async () => { S.activityDate = $('actDate').value; await load('activity'); render(); }, 'bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700 font-medium'));
  dateRow.appendChild(btn('今天', async () => { S.activityDate = shanghaiTodayInputDate(); await load('activity'); render(); }, 'bg-gray-100 text-gray-700 text-sm px-3 py-2 rounded-lg hover:bg-gray-200 font-medium'));
  hdr.appendChild(dateRow);
  w.appendChild(hdr);

  // Summary stats
  const sumRow = el('div', { className: 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6' });
  sumRow.appendChild(stat(A.totalInteractions || 0, '总交互次数', 'text-blue-600'));
  sumRow.appendChild(stat(A.totalAnomalies || 0, 'BI 异常触发', (A.totalAnomalies || 0) > 0 ? 'text-red-600' : 'text-green-600'));
  sumRow.appendChild(stat(A.totalRhythm || 0, '节奏执行', 'text-purple-600'));
  sumRow.appendChild(stat(A.totalAdminAlerts || 0, '管理告警 A/B/C', (A.totalAdminAlerts || 0) > 0 ? 'text-amber-600' : 'text-gray-500'));
  sumRow.appendChild(stat(Object.keys(A.summary || {}).length, '活跃 Agent 数', 'text-indigo-600'));
  w.appendChild(sumRow);

  // A/B/C 数据告警（飞书已发出后落库，与 BI anomaly_triggers 并列可查）
  if (adm.length > 0) {
    const adCard = el('div', { className: 'bg-white rounded-xl shadow-sm border border-amber-100 p-6 mb-6 ring-1 ring-amber-50' });
    adCard.appendChild(el('h3', { className: 'text-base font-semibold text-gray-800 mb-3 pb-2 border-b border-amber-100' }, '🔔 管理数据告警 A/B/C（' + adm.length + ' 条）'));
    adCard.appendChild(el('p', { className: 'text-xs text-gray-500 mb-3' }, 'A=紧急 · B=绩效/流程 · C=准确性。与飞书管理员通知同源；去重后仅记录实际发出成功的条目。'));
    const adTbl = el('table', { className: 'w-full text-sm' });
    const ah = el('thead'); const ar = el('tr', { className: 'bg-amber-50/80' });
    ['级别', '类型', '标题', '送达', '时间', '摘要'].forEach((h) => ar.appendChild(el('th', { className: 'p-2 text-left text-xs font-semibold text-gray-600' }, h)));
    ah.appendChild(ar); adTbl.appendChild(ah);
    const ab = el('tbody');
    adm.forEach((row) => {
      const pr = String(row.priority || 'B').toUpperCase();
      const prCls = pr === 'A' ? 'bg-red-100 text-red-800' : pr === 'C' ? 'bg-yellow-100 text-yellow-800' : 'bg-orange-100 text-orange-800';
      const tr = el('tr', { className: 'border-b border-gray-100 hover:bg-amber-50/40 align-top' });
      tr.appendChild(el('td', { className: 'p-2' }, el('span', { className: 'text-xs px-2 py-0.5 rounded-full font-bold ' + prCls }, pr)));
      tr.appendChild(el('td', { className: 'p-2 text-xs font-mono text-gray-600' }, row.alert_type || '-'));
      tr.appendChild(el('td', { className: 'p-2 text-xs font-medium text-gray-900 max-w-[200px]' }, row.title || '-'));
      tr.appendChild(el('td', { className: 'p-2 text-xs text-gray-600' }, (row.sent_count != null ? row.sent_count : '—') + '/' + (row.recipient_count != null ? row.recipient_count : '—')));
      tr.appendChild(el('td', { className: 'p-2 text-xs whitespace-nowrap' }, fmtTime(row.sent_at)));
      const prev = String(row.body_preview || '').slice(0, 220);
      tr.appendChild(el('td', { className: 'p-2 text-xs text-gray-600 max-w-md', title: String(row.body_preview || '') }, prev + (prev.length >= 220 ? '…' : '')));
      ab.appendChild(tr);
    });
    adTbl.appendChild(ab); adCard.appendChild(adTbl); w.appendChild(adCard);
  }

  // Per-agent cards
  const summary = A.summary || {};
  if (Object.keys(summary).length > 0) {
    w.appendChild(el('h3', { className: 'text-base font-semibold text-gray-800 mb-3' }, '🤖 各Agent工作概览'));
    const agGrid = el('div', { className: 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6' });
    Object.entries(summary).forEach(([agId, info]) => {
      const agCard = el('div', { className: 'bg-white rounded-xl shadow-sm border border-gray-100 p-5 hover:shadow-md transition-all' });
      const agHdr = el('div', { className: 'flex justify-between items-center mb-3 pb-2 border-b border-gray-100' });
      agHdr.appendChild(el('div', { className: 'flex items-center gap-2' }, [
        el('span', { className: 'w-3 h-3 rounded-full bg-green-500 inline-block' }),
        el('span', { className: 'font-semibold text-gray-900 text-sm' }, AN[agId] || agId)
      ]));
      agHdr.appendChild(el('span', { className: 'text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium' }, info.interactions + ' 次交互'));
      agCard.appendChild(agHdr);
      const metaGrid = el('div', { className: 'grid grid-cols-2 gap-2 text-xs' });
      metaGrid.appendChild(el('div', { className: 'bg-gray-50 rounded-lg p-2' }, [el('div', { className: 'text-gray-500' }, '平均延迟'), el('div', { className: 'font-semibold text-gray-900' }, (info.avgLatency || 0) + 'ms')]));
      metaGrid.appendChild(el('div', { className: 'bg-gray-50 rounded-lg p-2' }, [el('div', { className: 'text-gray-500' }, '涉及门店'), el('div', { className: 'font-semibold text-gray-900' }, (info.stores || []).length + ' 家')]));
      if (info.evidenceViolations > 0) {
        metaGrid.appendChild(el('div', { className: 'bg-red-50 rounded-lg p-2 col-span-2' }, [el('div', { className: 'text-red-500' }, '⚠️ 证据违规'), el('div', { className: 'font-semibold text-red-700' }, info.evidenceViolations + ' 次')]));
      }
      agCard.appendChild(metaGrid);
      if ((info.stores || []).length > 0) {
        const storeList = el('div', { className: 'mt-2 flex flex-wrap gap-1' });
        info.stores.forEach(s => storeList.appendChild(el('span', { className: 'text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded' }, s)));
        agCard.appendChild(storeList);
      }
      agGrid.appendChild(agCard);
    });
    w.appendChild(agGrid);
  } else {
    w.appendChild(card('Agent工作概览', el('p', { className: 'text-gray-400 text-sm py-4 text-center' }, '当日暂无Agent交互记录')));
  }

  // Timeline: all interactions sorted by time
  const logs = A.taskLogs || [];
  if (logs.length > 0) {
    const timeCard = el('div', { className: 'bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-4' });
    timeCard.appendChild(el('h3', { className: 'text-base font-semibold text-gray-800 mb-4 pb-2 border-b border-gray-100' }, '⏱️ 交互时间线 (' + logs.length + ' 条)'));
    const timeline = el('div', { className: 'relative pl-6 space-y-3' });
    timeline.appendChild(el('div', { className: 'absolute left-2 top-0 bottom-0 w-0.5 bg-gray-200' }));
    logs.slice(0, 50).forEach(log => {
      const item = el('div', { className: 'relative flex items-start gap-3' });
      const dotColor = log.evidence_violation ? 'bg-red-500' : 'bg-blue-500';
      item.appendChild(el('div', { className: 'absolute -left-4 top-1.5 w-2.5 h-2.5 rounded-full ' + dotColor + ' border-2 border-white shadow-sm' }));
      const content = el('div', { className: 'bg-gray-50 rounded-lg px-3 py-2 flex-1 min-w-0' });
      const topRow = el('div', { className: 'flex items-center gap-2 flex-wrap' });
      topRow.appendChild(el('span', { className: 'text-xs font-medium text-indigo-600' }, AN[log.agent] || log.agent || '?'));
      if (log.store) topRow.appendChild(el('span', { className: 'text-xs bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded' }, log.store));
      if (log.username) topRow.appendChild(el('span', { className: 'text-xs text-gray-500' }, '↔ ' + log.username));
      topRow.appendChild(el('span', { className: 'text-xs text-gray-400 ml-auto' }, fmtTime(log.created_at)));
      if (log.latency_ms) topRow.appendChild(el('span', { className: 'text-xs text-gray-400' }, log.latency_ms + 'ms'));
      content.appendChild(topRow);
      item.appendChild(content);
      timeline.appendChild(item);
    });
    if (logs.length > 50) timeline.appendChild(el('div', { className: 'text-xs text-gray-400 text-center py-2' }, '... 还有 ' + (logs.length - 50) + ' 条'));
    timeCard.appendChild(timeline);
    w.appendChild(timeCard);
  }

  // Rhythm logs
  const rhythms = A.rhythmLogs || [];
  if (rhythms.length > 0) {
    const rhyCard = el('div', { className: 'bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-4' });
    rhyCard.appendChild(el('h3', { className: 'text-base font-semibold text-gray-800 mb-4 pb-2 border-b border-gray-100' }, '🎯 节奏任务执行 (' + rhythms.length + ' 次)'));
    const rhyGrid = el('div', { className: 'space-y-2' });
    rhythms.forEach(r => {
      const rItem = el('div', { className: 'flex items-center gap-3 p-3 bg-gray-50 rounded-lg' });
      const stIcon = r.status === 'success' ? '✅' : '❌';
      rItem.appendChild(el('span', { className: 'text-lg' }, stIcon));
      rItem.appendChild(el('div', { className: 'flex-1 min-w-0' }, [
        el('div', { className: 'text-sm font-medium text-gray-900' }, r.rhythm_type || '-'),
        el('div', { className: 'text-xs text-gray-500' }, fmtTime(r.created_at) + (r.execution_time ? ' · ' + parseFloat(r.execution_time).toFixed(1) + 's' : ''))
      ]));
      if (r.result_summary || r.error_message) {
        rItem.appendChild(btnGhost('详情', () => {
          const s = typeof r.result_summary === 'object' ? JSON.stringify(r.result_summary, null, 2) : String(r.result_summary || r.error_message || '');
          showModal(r.rhythm_type + ' 详情', el('pre', { className: 'text-xs bg-gray-50 p-4 rounded-lg font-mono overflow-auto max-h-96' }, s.slice(0, 3000)));
        }));
      }
      rhyGrid.appendChild(rItem);
    });
    rhyCard.appendChild(rhyGrid);
    w.appendChild(rhyCard);
  }

  // Anomaly triggers
  const anomalies = A.anomalyTriggers || [];
  if (anomalies.length > 0) {
    const anomCard = el('div', { className: 'bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-4' });
    anomCard.appendChild(el('h3', { className: 'text-base font-semibold text-gray-800 mb-4 pb-2 border-b border-gray-100' }, '🚨 异常触发 (' + anomalies.length + ' 条)'));
    const anomTbl = el('table', { className: 'w-full text-sm' });
    const ath = el('thead'); const atr = el('tr', { className: 'bg-gray-50' });
    ['门店', '异常类型', '严重度', '业务日', '描述', '状态', '入库时间'].forEach((h) =>
      atr.appendChild(el('th', { className: 'p-2 text-left text-xs font-semibold text-gray-600' }, h))
    );
    ath.appendChild(atr); anomTbl.appendChild(ath);
    const atb = el('tbody');
    anomalies.forEach(a => {
      const tr = el('tr', { className: 'border-b border-gray-100 hover:bg-gray-50' });
      tr.appendChild(el('td', { className: 'p-2 text-xs font-medium' }, a.store || '-'));
      tr.appendChild(el('td', { className: 'p-2 text-xs' }, a.anomaly_key || '-'));
      tr.appendChild(el('td', { className: 'p-2' }, el('span', { className: 'text-xs px-2 py-0.5 rounded-full font-medium ' + (SEV_CLS[a.severity] || 'bg-gray-100') }, a.severity || '-')));
      tr.appendChild(el('td', { className: 'p-2 text-xs font-mono whitespace-nowrap text-gray-700' }, a.trigger_date || '-'));
      {
        const descText = formatAnomalyTriggerDisplay(a);
        tr.appendChild(el('td', { className: 'p-2 text-xs max-w-md align-top', title: descText }, descText.length > 100 ? descText.slice(0, 97) + '…' : descText));
      }
      tr.appendChild(el('td', { className: 'p-2 text-xs' }, a.status || '-'));
      tr.appendChild(el('td', { className: 'p-2 text-xs' }, fmtTime(a.created_at)));
      atb.appendChild(tr);
    });
    anomTbl.appendChild(atb); anomCard.appendChild(anomTbl);
    w.appendChild(anomCard);
  }

  // Collaboration events (inter-agent)
  const collabs = A.collabEvents || [];
  if (collabs.length > 0) {
    const collabCard = el('div', { className: 'bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-4' });
    collabCard.appendChild(el('h3', { className: 'text-base font-semibold text-gray-800 mb-4 pb-2 border-b border-gray-100' }, '🔗 Agent间协作 (' + collabs.length + ' 次)'));
    collabs.forEach(c => {
      const cItem = el('div', { className: 'p-3 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-lg mb-2 border border-indigo-100' });
      cItem.appendChild(el('div', { className: 'flex items-center gap-2 mb-1' }, [
        el('span', { className: 'text-sm' }, '🔗'),
        el('span', { className: 'text-sm font-medium text-gray-900' }, c.title || '-'),
        el('span', { className: 'text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full' }, c.status || '-')
      ]));
      cItem.appendChild(el('div', { className: 'text-xs text-gray-600' }, '门店: ' + (c.store || '-') + ' · ' + fmtTime(c.created_at)));
      if (c.notes) cItem.appendChild(el('div', { className: 'text-xs text-gray-500 mt-1' }, c.notes.slice(0, 100)));
      collabCard.appendChild(cItem);
    });
    w.appendChild(collabCard);
  }

  // Master tasks
  const tasks = A.masterTasks || [];
  const canClose = canCloseTasksInAdminUi();
  if (tasks.length > 0) {
    const taskCard = el('div', { className: 'bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-4' });
    taskCard.appendChild(el('h3', { className: 'text-base font-semibold text-gray-800 mb-4 pb-2 border-b border-gray-100' }, '📝 任务状态 (' + tasks.length + ' 条)'));
    if (canClose) {
      taskCard.appendChild(el('p', { className: 'text-xs text-gray-500 mb-2' }, 'admin / hq_manager / hr_manager 可对未闭环任务点击「关闭」。若仍无「操作」列：请用环境变量 ADMIN_USERNAME 对应账号登录，或在 feishu_users 将 role 设为上述之一后重新登录。'));
    }
    const taskTbl = el('table', { className: 'w-full text-sm' });
    const tth = el('thead'); const ttr = el('tr', { className: 'bg-gray-50' });
    const thLabels = ['任务ID', '标题', '门店', '严重度', '状态', 'Agent', '创建时间'];
    if (canClose) thLabels.push('操作');
    thLabels.forEach((h) => ttr.appendChild(el('th', { className: 'p-2 text-left text-xs font-semibold text-gray-600' }, h)));
    tth.appendChild(ttr); taskTbl.appendChild(tth);
    const ttb = el('tbody');
    tasks.forEach(t => {
      const tr = el('tr', { className: 'border-b border-gray-100 hover:bg-gray-50' });
      tr.appendChild(el('td', { className: 'p-2 text-xs font-mono max-w-[120px] truncate', title: t.task_id || '' }, (t.task_id || '').slice(0, 14) + ((t.task_id || '').length > 14 ? '…' : '')));
      tr.appendChild(el('td', { className: 'p-2 text-xs font-medium' }, (t.title||'-').slice(0,30)));
      tr.appendChild(el('td', { className: 'p-2 text-xs' }, t.store || '-'));
      tr.appendChild(el('td', { className: 'p-2' }, el('span', { className: 'text-xs px-2 py-0.5 rounded-full font-medium ' + (SEV_CLS[t.severity] || 'bg-gray-100') }, t.severity || '-')));
      tr.appendChild(el('td', { className: 'p-2 text-xs' }, t.status || '-'));
      tr.appendChild(el('td', { className: 'p-2 text-xs' }, AN[t.agent] || t.agent || '-'));
      tr.appendChild(el('td', { className: 'p-2 text-xs' }, fmtTime(t.created_at)));
      if (canClose) {
        const canRowClose = t.status && !['closed', 'settled'].includes(String(t.status));
        const opTd = el('td', { className: 'p-2 text-xs' });
        if (canRowClose) {
          opTd.appendChild(btn('关闭', async () => {
            if (!confirm('确认关闭任务 ' + (t.task_id || '') + ' ？')) return;
            try {
              await POST('/api/admin/task/' + encodeURIComponent(t.task_id) + '/close', { reason: '控制台手动关闭' });
              msg('已关闭');
              go('activity');
            } catch (e) { msg(e?.message || '关闭失败', true); }
          }, 'bg-gray-100 text-gray-700 text-xs px-2 py-1 rounded border border-gray-200'));
        } else opTd.appendChild(el('span', { className: 'text-gray-400' }, '—'));
        tr.appendChild(opTd);
      }
      ttb.appendChild(tr);
    });
    taskTbl.appendChild(ttb); taskCard.appendChild(taskTbl);
    w.appendChild(taskCard);
  }

  if (!logs.length && !rhythms.length && !anomalies.length && !tasks.length && !collabs.length && !Object.keys(summary).length && !adm.length) {
    w.appendChild(card('', el('div', { className: 'text-center py-12' }, [
      el('div', { className: 'text-4xl mb-3' }, '📭'),
      el('p', { className: 'text-gray-500' }, S.activityDate + ' 暂无任何Agent活动记录'),
      el('p', { className: 'text-xs text-gray-400 mt-2' }, '请选择其他日期查看，或确认系统正在运行中')
    ])));
  }

  return w;
}

// ═══════════════════════════════════════════════════════
// AGENT CONFIG
// ═══════════════════════════════════════════════════════
function viewAgents() {
  const w = el('div');
  w.appendChild(el('div', { className: 'flex justify-between items-center mb-4' }, [
    el('h2', { className: 'text-lg font-bold text-gray-900' }, 'Agent 配置管理'),
    el('span', { className: 'text-xs bg-indigo-100 text-indigo-700 px-3 py-1 rounded-full font-medium' }, Object.keys(AN).length + ' Agents')
  ]));
  Object.entries(AN).forEach(([id, nm]) => {
    const c = S.agents[id] || {};
    const isEnabled = c.enabled !== false;
    const b = el('div', { className: 'bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-3 ' + (isEnabled ? '' : 'opacity-60') });
    const hd = el('div', { className: 'flex justify-between items-center mb-3' });
    const titleRow = el('div', { className: 'flex items-center gap-2' });
    titleRow.appendChild(el('span', { className: 'w-2 h-2 rounded-full ' + (isEnabled ? 'bg-green-500' : 'bg-gray-400') }));
    titleRow.appendChild(el('span', { className: 'font-semibold text-gray-900' }, nm));
    titleRow.appendChild(el('code', { className: 'text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded font-mono' }, id));
    hd.appendChild(titleRow);
    const ck = el('input', { type: 'checkbox', id: 'ae_' + id, className: 'w-4 h-4 text-indigo-600 rounded' }); ck.checked = isEnabled;
    const lbEl = el('label', { className: 'flex items-center gap-2 text-sm text-gray-600' }); lbEl.appendChild(ck); lbEl.appendChild(el('span', {}, '启用'));
    hd.appendChild(lbEl); b.appendChild(hd);
    b.appendChild(lbl('System Prompt'));
    const ta = el('textarea', { id: 'ap_' + id, className: 'w-full border border-gray-300 rounded-lg p-3 text-sm mt-1 mb-3 focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none', rows: '3' }); ta.value = c.prompt || ''; b.appendChild(ta);
    const row = el('div', { className: 'flex gap-4 items-end' });
    const mf = (label, eid, val, w) => { const d = el('div'); d.appendChild(lbl(label)); d.appendChild(el('input', { id: eid, type: 'number', step: '0.1', className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm ' + w + ' focus:ring-2 focus:ring-indigo-200 outline-none', value: String(val) })); return d; };
    row.appendChild(mf('Temperature', 'at_' + id, c.temperature || 0.3, 'w-24'));
    row.appendChild(mf('MaxTokens', 'am_' + id, c.maxTokens || 800, 'w-28'));
    row.appendChild(mf('Model', 'amd_' + id, '', 'w-36'));
    const modelInp = row.querySelector('#amd_' + id); if (modelInp) { modelInp.type = 'text'; modelInp.value = c.model || 'deepseek-chat'; }
    row.appendChild(btn('保存', async () => {
      const cfg = { prompt: $('ap_' + id).value, temperature: parseFloat($('at_' + id).value) || 0.3, maxTokens: parseInt($('am_' + id).value) || 800, enabled: $('ae_' + id).checked, model: $('amd_' + id)?.value || 'deepseek-chat' };
      await PUT('/api/agent-config/' + id, cfg); S.agents[id] = cfg; msg(nm + ' 配置已保存');
    }));
    b.appendChild(row); w.appendChild(b);
  });
  return w;
}

// ═══════════════════════════════════════════════════════
// SCHEDULED TASKS (定时任务) — 完全自定义
// ═══════════════════════════════════════════════════════
const DEFAULT_RHYTHM_ITEMS = [
  { key: 'morning', label: '晨检推送', desc: '每日发送门店晨检提醒', enabled: true },
  { key: 'patrol_am', label: '上午巡检', desc: '午市前巡检推送', enabled: true },
  { key: 'patrol_pm', label: '下午巡检', desc: '晚市前巡检推送', enabled: true },
  { key: 'eod', label: '日终报告', desc: '日终运营数据汇总推送', enabled: true },
  { key: 'weekly', label: '周报', desc: '周度运营分析报告', enabled: true },
  { key: 'monthly', label: '月评', desc: '月度绩效评估报告', enabled: true }
];
function viewScheduled() {
  const w = el('div');
  w.appendChild(el('h2', { className: 'text-lg font-bold text-gray-900 mb-4' }, '定时任务与巡检配置 (全部可自定义)'));
  w.appendChild(el('div', { className: 'mb-4 p-3 rounded-lg border border-blue-200 bg-blue-50 text-xs text-blue-900' },
    '使用说明：「任务设定」新增/删除会即时写入数据库，不需要再手动保存。「每日巡检」添加或改完后需点「保存全部修改」。若浏览器界面没变化请强制刷新（Ctrl/Cmd+Shift+R）。'));
  w.appendChild(card('「定时任务」是什么？', (() => {
    const d = el('div', { className: 'text-sm text-gray-600 space-y-2 leading-relaxed' });
    d.appendChild(el('p', {}, '1）任务设定：自定义「类型」名称和说明（例如：试味、专项巡检）。保存后，下面的「类型」下拉里就能选到。'));
    d.appendChild(el('p', {}, '2）每日巡检：按门店/品牌 + 时刻（北京时间）+ 频率执行。选「上午/下午巡检」会跑 BI 检测；新触发的异常会立刻单独通知责任人，并走催办与归档流程。自定义类型主要发飞书提醒。'));
    d.appendChild(el('p', {}, '3）随机抽检：在下面橙色区域配置，按随机间隔发任务卡（与 BI 巡检不同）。'));
    return d;
  })()));
  const cfg = S.schedCfg || {};

  // ── 任务设定 (原节奏引擎, 去掉时间设定, 支持增删) ──
  // 注意：[] 在 JS 中为 truthy，不能用 || 默认；且须拷贝默认项避免污染常量
  const rhythmItems = (Array.isArray(cfg.rhythmItems) && cfg.rhythmItems.length > 0)
    ? cfg.rhythmItems.map((x) => ({ ...x }))
    : DEFAULT_RHYTHM_ITEMS.map((x) => ({ ...x }));
  w.appendChild(card('任务设定', (() => {
    const g = el('div', { className: 'space-y-2' });
    function renderRhythmList() {
      g.innerHTML = '';
      rhythmItems.forEach((it, i) => {
        const r = el('div', { className: 'flex items-center gap-3 py-2 px-3 bg-gray-50 rounded-lg' });
        const ck = el('input', { type: 'checkbox', id: 'rhy_en_' + i, className: 'w-4 h-4 text-indigo-600 rounded' });
        ck.checked = it.enabled !== false && cfg['rhythm_' + it.key] !== false;
        r.appendChild(ck);
        r.appendChild(el('input', { id: 'rhy_label_' + i, value: it.label, className: 'border rounded px-2 py-1 text-sm font-medium w-28' }));
        r.appendChild(el('input', { id: 'rhy_desc_' + i, value: it.desc, className: 'border rounded px-2 py-1 text-xs text-gray-500 flex-1' }));
        r.appendChild(btnDanger('删除', async () => {
          rhythmItems.splice(i, 1);
          try {
            await saveRhythmItems(collectItems(), true);
            msg('已删除并保存');
          } catch (_e) { /* 降级：仅更新 UI */ }
          renderRhythmList();
        }));
        g.appendChild(r);
      });
      // Add new item row
      const addRow = el('div', { className: 'flex items-center gap-3 py-2 px-3 bg-blue-50 rounded-lg border border-blue-100 mt-2' });
      addRow.appendChild(el('input', { id: 'rhy_new_label', placeholder: '任务名称', className: 'border rounded px-2 py-1 text-sm font-medium w-28' }));
      addRow.appendChild(el('input', { id: 'rhy_new_desc', placeholder: '任务描述', className: 'border rounded px-2 py-1 text-xs text-gray-500 flex-1' }));
      // 收集当前列表（含最新的 label/desc 编辑值）
      function collectItems() {
        return rhythmItems.map((it, i) => ({
          key: it.key,
          label: $('rhy_label_' + i)?.value || it.label,
          desc: $('rhy_desc_' + i)?.value || it.desc,
          enabled: $('rhy_en_' + i)?.checked !== false
        }));
      }
      async function saveRhythmItems(items, silent) {
        const res = await PUT('/api/config/rhythm_schedule', { config_value: { rhythmItems: items }, description: '任务设定配置' });
        if (!res?.ok) throw new Error(res?.error || '保存失败');
        S.schedCfg = S.schedCfg || {};
        S.schedCfg.rhythmItems = items;
        if (!silent) msg('任务设定已保存（已写入数据库）');
      }

      addRow.appendChild(btn('+ 新增并保存', async () => {
        const label = ($('rhy_new_label')?.value || '').trim();
        const desc = ($('rhy_new_desc')?.value || '').trim();
        if (!label) { msg('请填写任务名称', true); return; }
        const key = 'custom_' + Date.now();
        const prevItems = collectItems();
        const newItems = [...prevItems, { key, label, desc, enabled: true }];
        try {
          await saveRhythmItems(newItems, true);
          msg('✅ 任务「' + label + '」已新增并写入数据库');
          await go('scheduled'); // 刷新整页，类型下拉立即能选到
        } catch (e) {
          msg('新增失败：' + (e?.message || e), true);
        }
      }, 'bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700 font-medium'));
      g.appendChild(addRow);
      // Save button（保存已存在项的 label/desc/enabled 修改）
      g.appendChild(btn('保存任务设定修改', async () => {
        try {
          const items = collectItems();
          await saveRhythmItems(items);
          await go('scheduled');
        } catch (e) {
          msg('保存失败：' + (e?.message || e) + '（若只读：去掉 .env 中 ENABLE_DB_READ_ONLY=true / ENABLE_DB_WRITE=false，pm2 restart）', true);
        }
      }, 'mt-3 bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700'));
    }
    renderRhythmList();
    return g;
  })()));

  // ── Daily inspections (full CRUD) — 门店/品牌用下拉, 增加发送对象 ──
  const daily = cfg.dailyInspections || [];
  let _stores = S.storesList || [];
  let _brands = S.brandsList || [];
  // Auto-retry: if stores data wasn't loaded, fetch it now and re-render once
  if (!_stores.length && !S._storesRetried) {
    S._storesRetried = true;
    G('/api/stores-brands').then(sb => {
      if (sb?.stores?.length) { S.storesList = sb.stores; S.brandsList = sb.brands || []; go('scheduled'); }
    }).catch(e => console.error('[stores-brands] retry failed:', e));
  }
  const ROLE_LABELS = { store_manager: '店长', store_production_manager: '出品经理' };
  function makeStoreSel(id, val) {
    const s = el('select', { id, className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm w-full' });
    s.appendChild(el('option', { value: '' }, '-- 选择门店 --'));
    _stores.forEach(st => { const o = el('option', { value: st }, st); if (st === val) o.selected = true; s.appendChild(o); });
    return s;
  }
  function makeBrandSel(id, val) {
    const s = el('select', { id, className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm w-full' });
    s.appendChild(el('option', { value: '' }, '-- 选择品牌 --'));
    _brands.forEach(b => { const o = el('option', { value: b }, b); if (b === val) o.selected = true; s.appendChild(o); });
    return s;
  }
  function makeRoleSel(id, vals) {
    const wrap = el('div', { className: 'flex gap-2' });
    const selected = Array.isArray(vals) ? vals : ['store_manager'];
    Object.entries(ROLE_LABELS).forEach(([role, label]) => {
      const ck = el('input', { type: 'checkbox', id: id + '_' + role, className: 'w-4 h-4 text-indigo-600 rounded' });
      ck.checked = selected.includes(role);
      const lb = el('label', { className: 'flex items-center gap-1 text-xs' }); lb.appendChild(ck); lb.appendChild(el('span', {}, label));
      wrap.appendChild(lb);
    });
    return wrap;
  }
  function readRoles(id) {
    return Object.keys(ROLE_LABELS).filter(role => $(id + '_' + role)?.checked);
  }
  w.appendChild(card('每日巡检任务 (可增删改)', (() => {
    const g = el('div');
    g.appendChild(el('p', { className: 'text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-3' },
      '后台按上海时区每分钟匹配「时间+频率」执行（请用北京时间填写时刻）；修改下方表格后务必点「保存全部修改」。类型来自上方「任务设定」。右侧可一键测试执行。'));
    g.appendChild(el('div', { className: 'flex justify-end mb-2' }, [
      btn('立即执行全部每日巡检(测试)', async () => {
        try {
          const r = await POST('/api/rhythm/daily-inspection-run', {});
          msg('已执行：' + JSON.stringify(r?.result || r).slice(0, 280));
        } catch (e) { msg('执行失败: ' + (e?.message || e), true); }
      }, 'bg-amber-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-amber-700')
    ]));
    // Add new item form
    const addRow = el('div', { className: 'grid grid-cols-7 gap-2 mb-3 p-3 bg-blue-50 rounded-lg border border-blue-100' });
    addRow.appendChild(field('门店', makeStoreSel('ndi_store', '')));
    addRow.appendChild(field('品牌', makeBrandSel('ndi_brand', '')));
    const typeSel = el('select', { id: 'ndi_type', className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm w-full' });
    const _taskTypes = rhythmItems.map(it => ({ value: it.key, label: it.label }));
    if (!_taskTypes.length) ['opening', 'closing', 'patrol', 'inventory', 'cleaning'].forEach(v => _taskTypes.push({ value: v, label: v }));
    _taskTypes.forEach(v => typeSel.appendChild(el('option', { value: v.value }, v.label)));
    addRow.appendChild(field('类型', typeSel));
    addRow.appendChild(field('时间', inp('ndi_time', '10:00', 'time')));
    const freqSel = el('select', { id: 'ndi_freq', className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm w-full' });
    ['daily', 'weekly', 'biweekly', 'monthly'].forEach(v => freqSel.appendChild(el('option', { value: v }, v)));
    addRow.appendChild(field('频率', freqSel));
    addRow.appendChild(field('发送对象', makeRoleSel('ndi_roles', ['store_manager'])));
    addRow.appendChild(el('div', { className: 'flex items-end' }, [btn('+ 添加', async () => {
      const item = { store: $('ndi_store')?.value?.trim(), brand: $('ndi_brand')?.value?.trim(), type: $('ndi_type')?.value, time: $('ndi_time')?.value, frequency: $('ndi_freq')?.value, assigneeRoles: readRoles('ndi_roles') };
      if (!item.store && !item.brand) { msg('请选择门店或品牌', true); return; }
      if (!item.assigneeRoles.length) { msg('请选择发送对象', true); return; }
      daily.push(item);
      await PUT('/api/config/daily_inspections', { config_value: daily, description: '每日巡检任务配置' });
      msg('巡检项已添加'); go('scheduled');
    }, 'bg-blue-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-blue-700')]));
    g.appendChild(addRow);
    // Existing items table
    if (daily.length) {
      const tbl = el('table', { className: 'w-full text-sm' });
      const th = el('tr'); ['门店', '品牌', '类型', '时间', '频率', '发送对象', '操作'].forEach(x => th.appendChild(el('th', { className: 'text-left p-2 border-b-2 text-gray-600 font-medium text-xs' }, x)));
      tbl.appendChild(th);
      daily.forEach((d, i) => {
        const tr = el('tr', { className: 'hover:bg-gray-50' });
        tr.appendChild(el('td', { className: 'p-2 border-b' }, makeStoreSel('di_store_' + i, d.store || '')));
        tr.appendChild(el('td', { className: 'p-2 border-b' }, makeBrandSel('di_brand_' + i, d.brand || '')));
        const ts = el('select', { id: 'di_type_' + i, className: 'border rounded px-2 py-1 text-xs' });
        _taskTypes.forEach(v => { const o = el('option', { value: v.value }, v.label); if (v.value === d.type) o.selected = true; ts.appendChild(o); });
        tr.appendChild(el('td', { className: 'p-2 border-b' }, ts));
        tr.appendChild(el('td', { className: 'p-2 border-b' }, el('input', { type: 'time', id: 'di_time_' + i, value: d.time || '10:00', className: 'border rounded px-2 py-1 text-xs' })));
        const fs = el('select', { id: 'di_freq_' + i, className: 'border rounded px-2 py-1 text-xs' });
        ['daily', 'weekly', 'biweekly', 'monthly'].forEach(v => { const o = el('option', { value: v }, v); if (v === (d.frequency || 'daily')) o.selected = true; fs.appendChild(o); });
        tr.appendChild(el('td', { className: 'p-2 border-b' }, fs));
        tr.appendChild(el('td', { className: 'p-2 border-b' }, makeRoleSel('di_roles_' + i, d.assigneeRoles || ['store_manager'])));
        tr.appendChild(el('td', { className: 'p-2 border-b' }, btnDanger('删除', async () => {
          daily.splice(i, 1);
          await PUT('/api/config/daily_inspections', { config_value: daily, description: '每日巡检任务配置' });
          msg('已删除'); go('scheduled');
        })));
        tbl.appendChild(tr);
      });
      g.appendChild(tbl);
      g.appendChild(btn('保存全部修改', async () => {
        const items = daily.map((d, i) => ({
          store: $('di_store_' + i)?.value || d.store, brand: $('di_brand_' + i)?.value || d.brand,
          type: $('di_type_' + i)?.value || d.type, time: $('di_time_' + i)?.value || d.time,
          frequency: $('di_freq_' + i)?.value || d.frequency || 'daily',
          assigneeRoles: readRoles('di_roles_' + i)
        }));
        await PUT('/api/config/daily_inspections', { config_value: items, description: '每日巡检任务配置' });
        msg('巡检配置已保存'); go('scheduled');
      }, 'mt-3 bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700'));
    } else {
      g.appendChild(el('p', { className: 'text-sm text-gray-500 py-3' }, '暂无巡检任务，请使用上方表单添加'));
    }
    return g;
  })()));

  // ── Random inspections (full CRUD) ──
  const random = cfg.randomInspections || [];
  w.appendChild(card('随机抽检配置 (可增删改)', (() => {
    const g = el('div');
    // Add new
    const addRow = el('div', { className: 'grid grid-cols-1 md:grid-cols-6 gap-2 mb-3 p-3 bg-orange-50 rounded-lg border border-orange-100' });
    addRow.appendChild(field('检查项名称', inp('nri_type', '如: 海鲜池水温')));
    addRow.appendChild(field('描述', inp('nri_desc', '拍摄海鲜池照片')));
    addRow.appendChild(field('限时(分)', inp('nri_tw', '15', 'number')));
    addRow.appendChild(field('最小间隔(h)', inp('nri_min', '2', 'number')));
    addRow.appendChild(field('最大间隔(h)', inp('nri_max', '4', 'number')));
    addRow.appendChild(field('发送对象（绩效归属）', makeRoleSel('nri_roles', ['store_production_manager'])));
    addRow.appendChild(el('div', { className: 'md:col-span-6 flex justify-end' }, [
      btn('+ 添加', async () => {
        const roles = readRoles('nri_roles');
        if (!roles.length) { msg('请至少勾选一名接收人（店长或出品经理）', true); return; }
        const item = { type: $('nri_type')?.value?.trim(), description: $('nri_desc')?.value?.trim(),
          timeWindow: parseInt($('nri_tw')?.value) || 15, intervalMinHours: parseInt($('nri_min')?.value) || 2, intervalMaxHours: parseInt($('nri_max')?.value) || 4,
          assigneeRoles: roles };
        if (!item.type) { msg('请填写检查项名称', true); return; }
        random.push(item);
        await PUT('/api/config/random_inspections', { config_value: random, description: '随机抽检配置' });
        msg('抽检项已添加'); go('scheduled');
      }, 'bg-orange-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-orange-700')
    ]));
    g.appendChild(addRow);
    // Existing items
    random.forEach((r, i) => {
      const row = el('div', { className: 'bg-gray-50 rounded-lg p-3 mb-2 flex flex-wrap gap-3 items-end' });
      row.appendChild(el('input', { id: 'ri_type_' + i, value: r.type, className: 'border rounded px-2 py-1 text-sm font-medium w-32' }));
      row.appendChild(el('input', { id: 'ri_desc_' + i, value: r.description || '', className: 'border rounded px-2 py-1 text-xs flex-1 min-w-[120px]' }));
      const tw = el('div', { className: 'flex items-center gap-1' }); tw.appendChild(lbl('限时(分)')); tw.appendChild(el('input', { type: 'number', value: String(r.timeWindow), id: 'ri_tw_' + i, className: 'border rounded px-2 py-1 text-xs w-16' })); row.appendChild(tw);
      const iv = el('div', { className: 'flex items-center gap-1' }); iv.appendChild(lbl('间隔(h)')); iv.appendChild(el('input', { type: 'number', value: String(r.intervalMinHours), id: 'ri_min_' + i, className: 'border rounded px-2 py-1 text-xs w-14' })); iv.appendChild(el('span', {}, '~')); iv.appendChild(el('input', { type: 'number', value: String(r.intervalMaxHours), id: 'ri_max_' + i, className: 'border rounded px-2 py-1 text-xs w-14' })); row.appendChild(iv);
      row.appendChild(field('发送对象', makeRoleSel('ri_roles_' + i, r.assigneeRoles && r.assigneeRoles.length ? r.assigneeRoles : ['store_manager', 'store_production_manager'])));
      row.appendChild(btnDanger('删除', async () => {
        random.splice(i, 1);
        await PUT('/api/config/random_inspections', { config_value: random, description: '随机抽检配置' });
        msg('已删除'); go('scheduled');
      }));
      g.appendChild(row);
    });
    if (random.length) {
      const btnRow = el('div', { className: 'mt-3 flex flex-wrap gap-3 items-center' });
      btnRow.appendChild(btn('保存全部修改', async () => {
        const items = random.map((r, i) => {
          const ar = readRoles('ri_roles_' + i);
          return {
            type: $('ri_type_' + i)?.value || r.type, description: $('ri_desc_' + i)?.value || r.description,
            timeWindow: parseInt($('ri_tw_' + i)?.value) || r.timeWindow,
            intervalMinHours: parseInt($('ri_min_' + i)?.value) || r.intervalMinHours,
            intervalMaxHours: parseInt($('ri_max_' + i)?.value) || r.intervalMaxHours,
            assigneeRoles: ar.length ? ar : (r.assigneeRoles || ['store_manager', 'store_production_manager'])
          };
        });
        await PUT('/api/config/random_inspections', { config_value: items, description: '随机抽检配置' });
        msg('抽检配置已保存'); go('scheduled');
      }, 'bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700'));
      btnRow.appendChild(btn('▶ 立即触发第一条(测试)', async () => {
        try {
          await POST('/api/inspection/trigger', random[0]);
          msg('✅ 已立即触发「' + (random[0]?.type || '随机抽检') + '」，请查看飞书');
        } catch (e) { msg('触发失败：' + (e?.message || e), true); }
      }, 'bg-orange-500 text-white text-sm px-4 py-2 rounded-lg hover:bg-orange-600'));
      btnRow.appendChild(btn('🔄 重启抽检调度(读取新配置)', async () => {
        try {
          const r = await POST('/api/inspection/restart', {});
          msg('调度已重启，活跃定时器：' + (r?.status?.activeTimers || 0));
        } catch (e) { msg('重启失败：' + (e?.message || e), true); }
      }, 'bg-gray-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-gray-700'));
      g.appendChild(btnRow);
    }
    return g;
  })()));
  return w;
}

// ═══════════════════════════════════════════════════════
// ANOMALY THRESHOLDS (异常阈值)
// ═══════════════════════════════════════════════════════
function viewAnomaly() {
  const w = el('div');
  w.appendChild(el('h2', { className: 'text-lg font-bold text-gray-900 mb-4' }, '异常检测阈值配置'));
  const cfg = S.anomalyCfg || {};
  const global = cfg.global || {};
  const thresholds = [
    { key: 'revenueGapMedium', label: '营收差距(Medium)', val: global.revenueGapMedium ?? 0.10, unit: '比率' },
    { key: 'revenueGapHigh', label: '营收差距(High)', val: global.revenueGapHigh ?? 0.20, unit: '比率' },
    { key: 'efficiencyMedium', label: '人效值(Medium)', val: global.efficiencyMedium ?? 1100, unit: '元/时' },
    { key: 'efficiencyHigh', label: '人效值(High)', val: global.efficiencyHigh ?? 1000, unit: '元/时' },
    { key: 'marginMedium', label: '毛利率(Medium)', val: global.marginMedium ?? 0.69, unit: '比率' },
    { key: 'marginHigh', label: '毛利率(High)', val: global.marginHigh ?? 0.68, unit: '比率' },
    { key: 'tableVisitRatioMedium', label: '桌访占比(Medium)', val: global.tableVisitRatioMedium ?? 0.5, unit: '比率' },
    { key: 'tableVisitRatioHigh', label: '桌访占比(High)', val: global.tableVisitRatioHigh ?? 0.4, unit: '比率' },
    { key: 'badReviewMedium', label: '差评数(Medium)', val: global.badReviewMedium ?? 1, unit: '条' },
    { key: 'badReviewHigh', label: '差评数(High)', val: global.badReviewHigh ?? 2, unit: '条' },
    { key: 'rechargeStreakHighDays', label: '充值连续异常天数', val: global.rechargeStreakHighDays ?? 2, unit: '天' },
  ];

  w.appendChild(card('全局异常阈值', (() => {
    const g = el('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-3' });
    thresholds.forEach(t => {
      const row = el('div', { className: 'flex items-center gap-3 bg-gray-50 rounded-lg px-3 py-2' });
      row.appendChild(el('span', { className: 'text-sm font-medium flex-1 min-w-[160px]' }, t.label));
      row.appendChild(el('input', { type: 'number', step: '0.01', value: String(t.val), id: 'at_' + t.key, className: 'border rounded-lg px-3 py-1.5 text-sm w-24 text-center' }));
      row.appendChild(el('span', { className: 'text-xs text-gray-400 w-12' }, t.unit));
      g.appendChild(row);
    });
    g.appendChild(btn('保存全局阈值', async () => {
      const data = {};
      thresholds.forEach(t => { data[t.key] = parseFloat($('at_' + t.key)?.value) || t.val; });
      await PUT('/api/config/anomaly_thresholds', { config_value: { global: data, storeOverrides: cfg.storeOverrides || {} }, description: '异常检测阈值' });
      msg('异常阈值已保存 → 下次检测生效');
    }, 'mt-4 col-span-2 bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700'));
    return g;
  })()));

  // Store overrides (editable CRUD)
  const overrides = cfg.storeOverrides || {};
  w.appendChild(card('门店特殊阈值覆盖 (可增删改)', (() => {
    const g = el('div');
    // Add new store override
    const addRow = el('div', { className: 'flex gap-2 mb-3 p-3 bg-purple-50 rounded-lg border border-purple-100 items-end' });
    addRow.appendChild(field('门店名称', inp('nso_store', '如: 洪潮大宁久光店')));
    addRow.appendChild(field('阈值Key', inp('nso_key', '如: revenueGapHigh')));
    addRow.appendChild(field('值', inp('nso_val', '0.25', 'number')));
    addRow.appendChild(btn('+ 添加覆盖', async () => {
      const store = $('nso_store')?.value?.trim(), key = $('nso_key')?.value?.trim(), val = parseFloat($('nso_val')?.value);
      if (!store || !key) { msg('请填写门店和阈值Key', true); return; }
      if (!overrides[store]) overrides[store] = {};
      overrides[store][key] = val;
      await PUT('/api/config/anomaly_thresholds', { config_value: { global: cfg.global || {}, storeOverrides: overrides }, description: '异常检测阈值' });
      msg('门店覆盖已添加'); go('anomaly');
    }, 'bg-purple-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-purple-700'));
    g.appendChild(addRow);
    if (!Object.keys(overrides).length) g.appendChild(el('p', { className: 'text-sm text-gray-500' }, '暂无门店特殊配置，使用全局阈值'));
    Object.entries(overrides).forEach(([store, vals]) => {
      const row = el('div', { className: 'bg-gray-50 rounded-lg p-3 mb-2' });
      const hd = el('div', { className: 'flex justify-between items-center mb-2' });
      hd.appendChild(el('div', { className: 'font-medium text-sm' }, '📍 ' + store));
      hd.appendChild(btnDanger('删除此门店覆盖', async () => {
        delete overrides[store];
        await PUT('/api/config/anomaly_thresholds', { config_value: { global: cfg.global || {}, storeOverrides: overrides }, description: '异常检测阈值' });
        msg('已删除'); go('anomaly');
      }));
      row.appendChild(hd);
      const items = el('div', { className: 'flex flex-wrap gap-2' });
      Object.entries(vals).forEach(([k, v]) => {
        const chip = el('div', { className: 'bg-white border rounded px-2 py-1 text-xs flex items-center gap-1' });
        chip.appendChild(el('span', {}, k + ': ' + v));
        chip.appendChild(el('button', { className: 'text-red-500 hover:text-red-700 ml-1 font-bold', onclick: async () => {
          delete overrides[store][k]; if (!Object.keys(overrides[store]).length) delete overrides[store];
          await PUT('/api/config/anomaly_thresholds', { config_value: { global: cfg.global || {}, storeOverrides: overrides }, description: '异常检测阈值' });
          msg('已删除'); go('anomaly');
        } }, '×'));
        items.appendChild(chip);
      });
      row.appendChild(items); g.appendChild(row);
    });
    return g;
  })()));
  return w;
}

// ═══════════════════════════════════════════════════════
// PERFORMANCE EVALUATION (绩效考核标准) — 完全自定义
// ═══════════════════════════════════════════════════════
function viewPerformance() {
  const w = el('div');
  w.appendChild(el('h2', { className: 'text-lg font-bold text-gray-900 mb-4' }, '绩效考核标准设置 (全部可自定义)'));
  w.appendChild(card('周度自动评分（写入 agent_scores / HRMS 同源库）', (() => {
    const d = el('div', { className: 'text-sm text-gray-600 space-y-3' });
    d.appendChild(el('p', {}, '系统按「上周」的 anomaly_triggers 汇总扣分，写入各店店长、出品经理在 feishu_users 中的账号；若未绑定则写入占位账号。默认每周一 08:00（上海）执行（需 ENABLE_AUTOMATIONS 或 ENABLE_WEEKLY_SCORING_CRON）。'));
    d.appendChild(btn('立即执行周度评分', async () => {
      try {
        const r = await POST('/api/scoring/run-weekly', {});
        msg('已执行：' + JSON.stringify(r?.result || r).slice(0, 400));
      } catch (e) { msg('失败：' + (e?.message || e), true); }
    }, 'bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700'));
    return d;
  })()));
  const perfCfg = S.perfCfg || {};

  // ── Deduction rules (full CRUD) ──
  const deductions = perfCfg.deductions || [
    { cat: '桌访占比异常', role: 'store_manager', med: 10, high: 20, freq: 'monthly' },
    { cat: '实收营收异常', role: 'store_manager', med: 20, high: 40, freq: 'monthly' },
    { cat: '人效值异常', role: 'store_manager', med: 10, high: 20, freq: 'monthly' },
    { cat: '充值异常', role: 'store_manager', med: 1, high: 2, freq: 'daily' },
    { cat: '总实收毛利率异常', role: 'store_production_manager', med: 20, high: 40, freq: 'monthly' },
    { cat: '产品差评异常', role: 'store_production_manager', med: 5, high: 10, freq: 'weekly' },
    { cat: '服务差评异常', role: 'store_manager', med: 5, high: 10, freq: 'weekly' },
    { cat: '桌访产品异常（多产品触线分别×5/10分累加）', role: 'store_production_manager', med: 5, high: 10, freq: 'weekly' },
  ];
  const savePerfCfg = async (key, val) => {
    const cur = { ...perfCfg }; cur[key] = val;
    await PUT('/api/config/performance_eval', { config_value: cur, description: '绩效考核全配置' });
    msg(key + ' 已保存');
  };
  w.appendChild(card('异常扣分规则 (可增删改)', (() => {
    const g = el('div');
    // Add new deduction
    const addRow = el('div', { className: 'grid grid-cols-6 gap-2 mb-3 p-3 bg-red-50 rounded-lg border border-red-100' });
    addRow.appendChild(field('异常类型', inp('nded_cat', '如: 充值异常')));
    const roleSel = el('select', { id: 'nded_role', className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm w-full' });
    ['store_manager', 'store_production_manager'].forEach(v => roleSel.appendChild(el('option', { value: v }, v === 'store_manager' ? '店长' : '出品经理')));
    addRow.appendChild(field('责任角色', roleSel));
    addRow.appendChild(field('Medium扣分', inp('nded_med', '5', 'number')));
    addRow.appendChild(field('High扣分', inp('nded_high', '10', 'number')));
    const freqSel = el('select', { id: 'nded_freq', className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm w-full' });
    ['daily', 'weekly', 'monthly'].forEach(v => freqSel.appendChild(el('option', { value: v }, v)));
    addRow.appendChild(field('频率', freqSel));
    addRow.appendChild(el('div', { className: 'flex items-end' }, [btn('+ 添加', async () => {
      const item = { cat: $('nded_cat')?.value?.trim(), role: $('nded_role')?.value, med: parseInt($('nded_med')?.value) || 5, high: parseInt($('nded_high')?.value) || 10, freq: $('nded_freq')?.value };
      if (!item.cat) { msg('请填写异常类型', true); return; }
      deductions.push(item); await savePerfCfg('deductions', deductions); go('performance');
    }, 'bg-red-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-red-700')]));
    g.appendChild(addRow);
    // Existing table
    const tbl = el('table', { className: 'w-full text-sm' });
    const th = el('tr'); ['异常类型', '责任角色', 'Medium扣分', 'High扣分', '频率', '操作'].forEach(x => th.appendChild(el('th', { className: 'text-left p-2 border-b-2 text-gray-600 font-medium text-xs' }, x)));
    tbl.appendChild(th);
    deductions.forEach((d, i) => {
      const tr = el('tr', { className: 'hover:bg-gray-50' });
      tr.appendChild(el('td', { className: 'p-2 border-b' }, el('input', { id: 'ded_cat_' + i, value: d.cat, className: 'border rounded px-2 py-1 text-xs w-full' })));
      const rs = el('select', { id: 'ded_role_' + i, className: 'border rounded px-2 py-1 text-xs' });
      ['store_manager', 'store_production_manager'].forEach(v => { const o = el('option', { value: v }, v === 'store_manager' ? '店长' : '出品经理'); if (v === d.role) o.selected = true; rs.appendChild(o); });
      tr.appendChild(el('td', { className: 'p-2 border-b' }, rs));
      tr.appendChild(el('td', { className: 'p-2 border-b' }, el('input', { type: 'number', value: String(d.med), id: 'ded_m_' + i, className: 'border rounded px-2 py-1 text-xs w-16 text-center' })));
      tr.appendChild(el('td', { className: 'p-2 border-b' }, el('input', { type: 'number', value: String(d.high), id: 'ded_h_' + i, className: 'border rounded px-2 py-1 text-xs w-16 text-center' })));
      const fs = el('select', { id: 'ded_freq_' + i, className: 'border rounded px-2 py-1 text-xs' });
      ['daily', 'weekly', 'monthly'].forEach(v => { const o = el('option', { value: v }, v); if (v === d.freq) o.selected = true; fs.appendChild(o); });
      tr.appendChild(el('td', { className: 'p-2 border-b' }, fs));
      tr.appendChild(el('td', { className: 'p-2 border-b' }, btnDanger('删除', async () => {
        deductions.splice(i, 1); await savePerfCfg('deductions', deductions); go('performance');
      })));
      tbl.appendChild(tr);
    });
    g.appendChild(tbl);
    g.appendChild(btn('保存扣分规则', async () => {
      const data = deductions.map((d, i) => ({ cat: $('ded_cat_' + i)?.value || d.cat, role: $('ded_role_' + i)?.value || d.role, med: parseInt($('ded_m_' + i)?.value) || d.med, high: parseInt($('ded_h_' + i)?.value) || d.high, freq: $('ded_freq_' + i)?.value || d.freq }));
      await savePerfCfg('deductions', data); go('performance');
    }, 'mt-3 bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700'));
    return g;
  })()));

  // ── Store rating criteria (editable) ──
  const ratings = perfCfg.storeRatings || [
    { grade: 'A', condition: '达成率 > 95%', threshold: 95 },
    { grade: 'B', condition: '达成率 > 90%', threshold: 90 },
    { grade: 'C', condition: '达成率 >= 85%', threshold: 85 },
    { grade: 'D', condition: '达成率 < 85%', threshold: 0 }
  ];
  const cls4 = { A: 'bg-green-50 text-green-700 border-green-200', B: 'bg-blue-50 text-blue-700 border-blue-200', C: 'bg-yellow-50 text-yellow-700 border-yellow-200', D: 'bg-red-50 text-red-700 border-red-200' };
  w.appendChild(card('门店评级标准 (可自定义阈值)', (() => {
    const g = el('div', { className: 'space-y-2' });
    ratings.forEach((r, i) => {
      const row = el('div', { className: 'flex items-center gap-3 border rounded-lg px-4 py-2 ' + (cls4[r.grade] || '') });
      row.appendChild(el('span', { className: 'font-bold text-lg w-8' }, r.grade));
      row.appendChild(el('input', { id: 'sr_cond_' + i, value: r.condition, className: 'border rounded px-2 py-1 text-sm flex-1' }));
      row.appendChild(el('span', { className: 'text-xs text-gray-500' }, '阈值%:'));
      row.appendChild(el('input', { id: 'sr_th_' + i, type: 'number', value: String(r.threshold), className: 'border rounded px-2 py-1 text-xs w-16 text-center' }));
      g.appendChild(row);
    });
    g.appendChild(btn('保存评级标准', async () => {
      const data = ratings.map((r, i) => ({ grade: r.grade, condition: $('sr_cond_' + i)?.value || r.condition, threshold: parseInt($('sr_th_' + i)?.value) ?? r.threshold }));
      await savePerfCfg('storeRatings', data); msg('评级标准已保存');
    }, 'mt-3 bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700'));
    return g;
  })()));

  // ── Bonus config (full CRUD for brands) ──
  const bonusCfg = perfCfg.bonusRules || [
    { brand: '马己仙', key: 'mjx', base: 1500, ruleA: '奖金 = 得分/100 × 基础', ruleC: '奖金归零', ruleD: '工资打8折' },
    { brand: '洪潮', key: 'hc', base: 2000, ruleA: '奖金 = 得分/100 × 基础', ruleC: '奖金归零', ruleD: '工资打8折' }
  ];
  w.appendChild(card('奖金计算规则 (可增删改品牌)', (() => {
    const g = el('div');
    // Add new brand
    const addRow = el('div', { className: 'flex gap-2 mb-3 p-3 bg-emerald-50 rounded-lg border border-emerald-100 items-end flex-wrap' });
    addRow.appendChild(field('品牌名', inp('nbonus_brand', '品牌名称')));
    addRow.appendChild(field('Key', inp('nbonus_key', 'brand_key')));
    addRow.appendChild(field('基础奖金(元)', inp('nbonus_base', '1500', 'number')));
    addRow.appendChild(btn('+ 添加品牌', async () => {
      const item = { brand: $('nbonus_brand')?.value?.trim(), key: $('nbonus_key')?.value?.trim(), base: parseInt($('nbonus_base')?.value) || 1500, ruleA: '奖金 = 得分/100 × 基础', ruleC: '奖金归零', ruleD: '工资打8折' };
      if (!item.brand) { msg('请填写品牌名', true); return; }
      bonusCfg.push(item); await savePerfCfg('bonusRules', bonusCfg); go('performance');
    }, 'bg-emerald-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-emerald-700'));
    g.appendChild(addRow);
    // Existing brands
    const row = el('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-4 mb-3' });
    bonusCfg.forEach((b, i) => {
      const c = el('div', { className: 'bg-gray-50 rounded-lg p-4' });
      const hd = el('div', { className: 'flex justify-between items-center mb-3' });
      hd.appendChild(el('input', { id: 'bonus_brand_' + i, value: b.brand, className: 'border rounded px-2 py-1 text-sm font-semibold w-32' }));
      hd.appendChild(btnDanger('删除', async () => { bonusCfg.splice(i, 1); await savePerfCfg('bonusRules', bonusCfg); go('performance'); }));
      c.appendChild(hd);
      const f = el('div', { className: 'flex items-center gap-2 mb-2' });
      f.appendChild(el('span', { className: 'text-xs text-gray-600 w-20' }, '基础奖金:'));
      f.appendChild(el('input', { type: 'number', id: 'bonus_base_' + i, value: String(b.base), className: 'border rounded px-2 py-1 text-sm w-24' }));
      f.appendChild(el('span', { className: 'text-xs text-gray-400' }, '元'));
      c.appendChild(f);
      // Editable rules
      c.appendChild(el('div', { className: 'space-y-1 mt-2' }, [
        el('div', { className: 'flex items-center gap-2' }, [el('span', { className: 'text-xs text-gray-600 w-16' }, 'A/B级:'), el('input', { id: 'bonus_rA_' + i, value: b.ruleA || '', className: 'border rounded px-2 py-1 text-xs flex-1' })]),
        el('div', { className: 'flex items-center gap-2' }, [el('span', { className: 'text-xs text-gray-600 w-16' }, 'C级:'), el('input', { id: 'bonus_rC_' + i, value: b.ruleC || '', className: 'border rounded px-2 py-1 text-xs flex-1' })]),
        el('div', { className: 'flex items-center gap-2' }, [el('span', { className: 'text-xs text-gray-600 w-16' }, 'D级:'), el('input', { id: 'bonus_rD_' + i, value: b.ruleD || '', className: 'border rounded px-2 py-1 text-xs flex-1' })])
      ]));
      row.appendChild(c);
    });
    g.appendChild(row);
    g.appendChild(btn('保存奖金配置', async () => {
      const data = bonusCfg.map((b, i) => ({ brand: $('bonus_brand_' + i)?.value || b.brand, key: b.key, base: parseInt($('bonus_base_' + i)?.value) || b.base, ruleA: $('bonus_rA_' + i)?.value || b.ruleA, ruleC: $('bonus_rC_' + i)?.value || b.ruleC, ruleD: $('bonus_rD_' + i)?.value || b.ruleD }));
      await savePerfCfg('bonusRules', data); msg('奖金配置已保存');
    }, 'bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700'));
    return g;
  })()));

  // ── Execution rating criteria (full CRUD) ──
  const execCriteria = perfCfg.executionRatings || [
    { role: '出品经理(不分品牌)', desc: '收档+开档+收货日报，缺<7次A, <14次B, <21次C, >=21次D' },
    { role: '马己仙店长', desc: '例会报告(每天1次,>=7分), 缺<=2且低分<=2得A, 缺<=4且低分<=4得B, 其余C/D' },
    { role: '洪潮店长', desc: '企微会员新增>=300得A, >=249得B, >=200得C, 其余D' }
  ];
  w.appendChild(card('执行力评级标准 (可增删改)', (() => {
    const g = el('div', { className: 'space-y-3' });
    // Add new
    const addRow = el('div', { className: 'flex gap-2 mb-3 p-3 bg-teal-50 rounded-lg border border-teal-100 items-end' });
    addRow.appendChild(field('角色名', inp('nexec_role', '如: 马己仙店长')));
    addRow.appendChild(el('div', { className: 'flex-1' }, [field('评级规则描述', inp('nexec_desc', '详细描述A/B/C/D评级条件'))]));
    addRow.appendChild(btn('+ 添加', async () => {
      const item = { role: $('nexec_role')?.value?.trim(), desc: $('nexec_desc')?.value?.trim() };
      if (!item.role) { msg('请填写角色名', true); return; }
      execCriteria.push(item); await savePerfCfg('executionRatings', execCriteria); go('performance');
    }, 'bg-teal-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-teal-700'));
    g.appendChild(addRow);
    execCriteria.forEach((c, i) => {
      const row = el('div', { className: 'bg-gray-50 rounded-lg px-4 py-3 flex gap-3 items-start' });
      row.appendChild(el('input', { id: 'exec_role_' + i, value: c.role, className: 'border rounded px-2 py-1 text-sm font-medium w-40' }));
      row.appendChild(el('input', { id: 'exec_desc_' + i, value: c.desc, className: 'border rounded px-2 py-1 text-xs flex-1' }));
      row.appendChild(btnDanger('删除', async () => { execCriteria.splice(i, 1); await savePerfCfg('executionRatings', execCriteria); go('performance'); }));
      g.appendChild(row);
    });
    g.appendChild(btn('保存执行力标准', async () => {
      const data = execCriteria.map((c, i) => ({ role: $('exec_role_' + i)?.value || c.role, desc: $('exec_desc_' + i)?.value || c.desc }));
      await savePerfCfg('executionRatings', data); msg('执行力标准已保存');
    }, 'mt-2 bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700'));
    return g;
  })()));

  // ── Attitude rating (full CRUD) ──
  const attCriteria = perfCfg.attitudeRatings || [
    { desc: '飞书agent任务未完成(提醒3次后仍未完成才计)', gradeA: '<=2次', gradeB: '<=4次', gradeC: '>4次' }
  ];
  w.appendChild(card('工作态度评级 (可增删改)', (() => {
    const g = el('div');
    const addRow = el('div', { className: 'flex gap-2 mb-3 p-3 bg-yellow-50 rounded-lg border border-yellow-100 items-end flex-wrap' });
    addRow.appendChild(field('评判标准', inp('natt_desc', '描述')));
    addRow.appendChild(field('A级条件', inp('natt_a', '<=2次')));
    addRow.appendChild(field('B级条件', inp('natt_b', '<=4次')));
    addRow.appendChild(field('C级条件', inp('natt_c', '>4次')));
    addRow.appendChild(btn('+ 添加', async () => {
      attCriteria.push({ desc: $('natt_desc')?.value?.trim(), gradeA: $('natt_a')?.value?.trim(), gradeB: $('natt_b')?.value?.trim(), gradeC: $('natt_c')?.value?.trim() });
      await savePerfCfg('attitudeRatings', attCriteria); go('performance');
    }, 'bg-yellow-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-yellow-700'));
    g.appendChild(addRow);
    attCriteria.forEach((a, i) => {
      const row = el('div', { className: 'bg-yellow-50 rounded-lg p-3 mb-2 border border-yellow-100' });
      row.appendChild(el('div', { className: 'flex gap-2 mb-2' }, [
        el('input', { id: 'att_desc_' + i, value: a.desc, className: 'border rounded px-2 py-1 text-xs flex-1' }),
        btnDanger('删除', async () => { attCriteria.splice(i, 1); await savePerfCfg('attitudeRatings', attCriteria); go('performance'); })
      ]));
      row.appendChild(el('div', { className: 'grid grid-cols-3 gap-2' }, [
        el('div', { className: 'flex items-center gap-1' }, [el('span', { className: 'text-xs font-bold text-green-600' }, 'A:'), el('input', { id: 'att_a_' + i, value: a.gradeA || '', className: 'border rounded px-2 py-1 text-xs flex-1' })]),
        el('div', { className: 'flex items-center gap-1' }, [el('span', { className: 'text-xs font-bold text-blue-600' }, 'B:'), el('input', { id: 'att_b_' + i, value: a.gradeB || '', className: 'border rounded px-2 py-1 text-xs flex-1' })]),
        el('div', { className: 'flex items-center gap-1' }, [el('span', { className: 'text-xs font-bold text-red-600' }, 'C:'), el('input', { id: 'att_c_' + i, value: a.gradeC || '', className: 'border rounded px-2 py-1 text-xs flex-1' })])
      ]));
      g.appendChild(row);
    });
    g.appendChild(btn('保存态度标准', async () => {
      const data = attCriteria.map((a, i) => ({ desc: $('att_desc_' + i)?.value || a.desc, gradeA: $('att_a_' + i)?.value || a.gradeA, gradeB: $('att_b_' + i)?.value || a.gradeB, gradeC: $('att_c_' + i)?.value || a.gradeC }));
      await savePerfCfg('attitudeRatings', data); msg('态度标准已保存');
    }, 'mt-2 bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700'));
    return g;
  })()));

  // ── Ability rating (full CRUD) ──
  const abilityCriteria = perfCfg.abilityRatings || [
    { role: '出品经理', metric: '毛利率差', gradeA: '>+1点', gradeB: '±1点', gradeC: '-1~-2点', gradeD: '<-2点' },
    { role: '洪潮店长', metric: '大众点评', gradeA: '>=4.6', gradeB: '>=4.5', gradeC: '>=4.3', gradeD: '<4.3' },
    { role: '马己仙店长', metric: '大众点评', gradeA: '>=4.5', gradeB: '>=4.4', gradeC: '>=4.0', gradeD: '<4.0' }
  ];
  w.appendChild(card('工作能力评级 (可增删改)', (() => {
    const g = el('div');
    const addRow = el('div', { className: 'grid grid-cols-7 gap-2 mb-3 p-3 bg-blue-50 rounded-lg border border-blue-100' });
    addRow.appendChild(field('角色', inp('nabi_role', '角色名')));
    addRow.appendChild(field('考核指标', inp('nabi_metric', '指标')));
    addRow.appendChild(field('A级', inp('nabi_a', '>=4.6')));
    addRow.appendChild(field('B级', inp('nabi_b', '>=4.5')));
    addRow.appendChild(field('C级', inp('nabi_c', '>=4.3')));
    addRow.appendChild(field('D级', inp('nabi_d', '<4.3')));
    addRow.appendChild(el('div', { className: 'flex items-end' }, [btn('+ 添加', async () => {
      abilityCriteria.push({ role: $('nabi_role')?.value?.trim(), metric: $('nabi_metric')?.value?.trim(), gradeA: $('nabi_a')?.value?.trim(), gradeB: $('nabi_b')?.value?.trim(), gradeC: $('nabi_c')?.value?.trim(), gradeD: $('nabi_d')?.value?.trim() });
      await savePerfCfg('abilityRatings', abilityCriteria); go('performance');
    }, 'bg-blue-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-blue-700')]));
    g.appendChild(addRow);
    abilityCriteria.forEach((a, i) => {
      const row = el('div', { className: 'bg-blue-50 rounded-lg p-3 mb-2 border border-blue-100' });
      row.appendChild(el('div', { className: 'flex gap-2 mb-2 items-center' }, [
        el('input', { id: 'abi_role_' + i, value: a.role, className: 'border rounded px-2 py-1 text-sm font-medium w-28' }),
        el('input', { id: 'abi_metric_' + i, value: a.metric, className: 'border rounded px-2 py-1 text-xs flex-1' }),
        btnDanger('删除', async () => { abilityCriteria.splice(i, 1); await savePerfCfg('abilityRatings', abilityCriteria); go('performance'); })
      ]));
      row.appendChild(el('div', { className: 'grid grid-cols-4 gap-2' }, [
        el('div', { className: 'flex items-center gap-1' }, [el('span', { className: 'text-xs font-bold text-green-600' }, 'A:'), el('input', { id: 'abi_a_' + i, value: a.gradeA || '', className: 'border rounded px-2 py-1 text-xs flex-1' })]),
        el('div', { className: 'flex items-center gap-1' }, [el('span', { className: 'text-xs font-bold text-blue-600' }, 'B:'), el('input', { id: 'abi_b_' + i, value: a.gradeB || '', className: 'border rounded px-2 py-1 text-xs flex-1' })]),
        el('div', { className: 'flex items-center gap-1' }, [el('span', { className: 'text-xs font-bold text-yellow-600' }, 'C:'), el('input', { id: 'abi_c_' + i, value: a.gradeC || '', className: 'border rounded px-2 py-1 text-xs flex-1' })]),
        el('div', { className: 'flex items-center gap-1' }, [el('span', { className: 'text-xs font-bold text-red-600' }, 'D:'), el('input', { id: 'abi_d_' + i, value: a.gradeD || '', className: 'border rounded px-2 py-1 text-xs flex-1' })])
      ]));
      g.appendChild(row);
    });
    g.appendChild(btn('保存能力标准', async () => {
      const data = abilityCriteria.map((a, i) => ({ role: $('abi_role_' + i)?.value || a.role, metric: $('abi_metric_' + i)?.value || a.metric, gradeA: $('abi_a_' + i)?.value || a.gradeA, gradeB: $('abi_b_' + i)?.value || a.gradeB, gradeC: $('abi_c_' + i)?.value || a.gradeC, gradeD: $('abi_d_' + i)?.value || a.gradeD }));
      await savePerfCfg('abilityRatings', data); msg('能力标准已保存');
    }, 'mt-2 bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700'));
    return g;
  })()));
  return w;
}

// ═══════════════════════════════════════════════════════
// MARKETING (营销管理)
// ═══════════════════════════════════════════════════════
function viewMarketing() {
  const w = el('div');
  w.appendChild(el('h2', { className: 'text-lg font-bold text-gray-900 mb-4' }, '营销管理'));

  // Create campaign form
  w.appendChild(card('创建营销活动', (() => {
    const g = el('div');
    const r1 = el('div', { className: 'grid grid-cols-2 md:grid-cols-4 gap-3 mb-3' });
    r1.appendChild(field('门店', inp('c_store', '选择门店'))); r1.appendChild(field('活动标题', inp('c_title', '活动名称')));
    r1.appendChild(field('开始日期', inp('c_start', '', 'date'))); r1.appendChild(field('结束日期', inp('c_end', '', 'date')));
    g.appendChild(r1);
    const r2 = el('div', { className: 'grid grid-cols-3 gap-3 mb-3' });
    r2.appendChild(field('目标指标', inp('c_metric', '如: revenue'))); r2.appendChild(field('目标值', inp('c_target', '0', 'number'))); r2.appendChild(field('预算', inp('c_budget', '0', 'number')));
    g.appendChild(r2);
    g.appendChild(field('描述', inp('c_desc', '活动详细描述')));
    g.appendChild(btn('创建活动', async () => {
      const d = { store: $('c_store').value, title: $('c_title').value, description: $('c_desc').value, start_date: $('c_start').value, end_date: $('c_end').value, target_metric: $('c_metric').value, target_value: $('c_target').value, budget_amount: $('c_budget').value };
      if (!d.store || !d.title) { msg('请填写门店和标题', true); return; }
      await POST('/api/campaigns', d); msg('活动已创建'); go('marketing');
    }, 'bg-emerald-600 text-white text-sm px-5 py-2 rounded-lg hover:bg-emerald-700 font-medium'));
    return g;
  })()));

  // Campaign list
  if (S.campaigns.length) {
    w.appendChild(card('活动列表 (' + S.campaigns.length + ')', (() => {
      const tbl = el('table', { className: 'w-full text-sm' });
      const th = el('tr'); ['门店', '活动', '状态', '时间', '目标', '实际', '预算', '操作'].forEach(x => th.appendChild(el('th', { className: 'text-left p-2 border-b-2 text-gray-600 text-xs font-medium' }, x)));
      tbl.appendChild(th);
      S.campaigns.forEach(c => {
        const tr = el('tr', { className: 'hover:bg-gray-50' });
        [c.store || '', c.title || '', STS[c.status] || c.status, fmtDate(c.start_date) + '~' + fmtDate(c.end_date), (c.target_metric || '') + '=' + (c.target_value || ''), String(c.actual_value || '-'), '¥' + (c.budget_amount || 0)].forEach(x => tr.appendChild(el('td', { className: 'p-2 border-b text-xs' }, x)));
        const acts = el('td', { className: 'p-2 border-b flex gap-1' });
        if (c.status === 'planned') acts.appendChild(btnGhost('启动', async () => { await PUT('/api/campaigns/' + c.id, { status: 'active' }); msg('已启动'); go('marketing'); }));
        if (c.status === 'active') acts.appendChild(btnGhost('完成', async () => { await PUT('/api/campaigns/' + c.id, { status: 'completed' }); msg('已完成'); go('marketing'); }));
        acts.appendChild(btnDanger('删除', async () => { await DEL('/api/campaigns/' + c.id); msg('已删除'); go('marketing'); }));
        tr.appendChild(acts); tbl.appendChild(tr);
      });
      return tbl;
    })()));
  }

  // Templates
  if (S.templates.length) {
    w.appendChild(card('营销模板库 (' + S.templates.length + ')', (() => {
      const g = el('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-3' });
      S.templates.forEach(t => {
        const c = el('div', { className: 'bg-gray-50 rounded-lg p-4 border border-gray-200' });
        c.appendChild(el('div', { className: 'flex justify-between items-start mb-2' }, [
          el('div', {}, [el('b', { className: 'text-sm' }, t.name), el('span', { className: 'ml-2 text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded' }, t.category)]),
          el('div', { className: 'text-xs text-gray-500' }, 'ROI: ' + (t.expected_roi || '?') + 'x')
        ]));
        c.appendChild(el('p', { className: 'text-xs text-gray-600 mb-2' }, t.description || ''));
        c.appendChild(btnGhost('使用此模板', () => { if ($('c_title')) $('c_title').value = t.name; if ($('c_desc')) $('c_desc').value = t.description || ''; msg('已填充模板: ' + t.name); }));
        g.appendChild(c);
      });
      return g;
    })()));
  }
  return w;
}

// ═══════════════════════════════════════════════════════
// EVALUATION (Agent评估)
// ═══════════════════════════════════════════════════════
function viewEval() {
  const w = el('div');
  w.appendChild(el('div', { className: 'flex justify-between items-center mb-4' }, [
    el('h2', { className: 'text-lg font-bold text-gray-900' }, 'Agent 健康评估'),
    btn('🔄 刷新评估', () => go('evaluation'))
  ]));
  const s = S.evalReport.summary || {};
  const row = el('div', { className: 'grid grid-cols-2 md:grid-cols-4 gap-4 mb-6' });
  row.appendChild(stat(s.avgHealthScore || '-', '平均健康分', s.avgHealthScore >= 70 ? 'text-green-600' : 'text-orange-600'));
  row.appendChild(stat(s.totalAgents || '-', 'Agent总数'));
  row.appendChild(stat(s.totalSuggestions || 0, '优化建议', s.totalSuggestions > 0 ? 'text-orange-600' : 'text-green-600'));
  row.appendChild(stat(s.evaluatedAt ? fmtDate(s.evaluatedAt) : 'N/A', '评估时间'));
  w.appendChild(row);
  const agents = S.evalReport.agents || {};
  Object.entries(agents).forEach(([id, r]) => {
    const c = el('div', { className: 'bg-white rounded-xl shadow-sm border p-4 mb-3 ' + (r.healthScore >= 70 ? 'border-green-200' : r.healthScore >= 40 ? 'border-yellow-200' : 'border-red-200') });
    const hd = el('div', { className: 'flex justify-between items-center mb-2' });
    hd.appendChild(el('div', { className: 'flex items-center gap-2' }, [el('span', { className: 'font-semibold' }, AN[id] || id), el('code', { className: 'text-xs bg-gray-100 px-2 py-0.5 rounded' }, id)]));
    const hc = r.healthScore >= 70 ? 'text-green-600' : r.healthScore >= 40 ? 'text-yellow-600' : 'text-red-600';
    hd.appendChild(el('span', { className: 'text-xl font-bold ' + hc }, r.healthScore + '/100'));
    c.appendChild(hd);
    const meta = el('div', { className: 'grid grid-cols-4 gap-2 text-xs text-gray-500' });
    meta.appendChild(el('div', {}, '成功率: ' + (r.successRate || 0) + '%'));
    meta.appendChild(el('div', {}, '消息数: ' + (r.stats?.messages || 0)));
    meta.appendChild(el('div', {}, '记忆: ' + (r.recentMemories || 0) + '条'));
    meta.appendChild(el('div', {}, '延迟: ' + (r.stats?.avgLatencySeconds || 0) + 's'));
    c.appendChild(meta);
    if (r.suggestions?.length) { const sg = el('div', { className: 'mt-2 text-xs space-y-1' }); r.suggestions.forEach(s => { sg.appendChild(el('div', { className: 'text-orange-600 bg-orange-50 px-2 py-1 rounded' }, '⚠ [' + s.type + '] ' + s.reason)); }); c.appendChild(sg); }
    w.appendChild(c);
  });
  return w;
}

// ═══════════════════════════════════════════════════════
// KNOWLEDGE BASE (知识库管理)
// ═══════════════════════════════════════════════════════
function viewKnowledge() {
  const w = el('div');
  w.appendChild(el('div', { className: 'flex justify-between items-center mb-4' }, [
    el('h2', { className: 'text-lg font-bold text-gray-900' }, '知识库管理 (SOP/培训资料)'),
    el('span', { className: 'text-xs bg-purple-100 text-purple-700 px-3 py-1 rounded-full font-medium' }, S.kbItems.length + ' 条目')
  ]));

  // Add new item form
  w.appendChild(card('新增知识条目', (() => {
    const g = el('div');
    const r1 = el('div', { className: 'grid grid-cols-3 gap-3 mb-3' });
    r1.appendChild(field('标题', inp('kb_title', 'SOP标题/培训课件名')));
    const catSel = el('select', { id: 'kb_cat', className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm w-full focus:ring-2 focus:ring-indigo-200 outline-none' });
    ['sop', 'training', 'procedure', 'policy', 'faq'].forEach(v => catSel.appendChild(el('option', { value: v }, v)));
    r1.appendChild(field('分类', catSel));
    r1.appendChild(el('div'));
    g.appendChild(r1);
    const ta = el('textarea', { id: 'kb_content', className: 'w-full border border-gray-300 rounded-lg p-3 text-sm mb-3 focus:ring-2 focus:ring-indigo-200 outline-none', rows: '4', placeholder: '知识内容/SOP详细步骤...' });
    g.appendChild(ta);
    g.appendChild(btn('添加条目', async () => {
      const title = $('kb_title')?.value?.trim(), content = $('kb_content')?.value?.trim(), category = $('kb_cat')?.value;
      if (!title || !content) { msg('请填写标题和内容', true); return; }
      await POST('/api/knowledge-base', { title, content, category }); msg('知识条目已添加'); go('knowledge');
    }, 'bg-purple-600 text-white text-sm px-5 py-2 rounded-lg hover:bg-purple-700 font-medium'));
    return g;
  })()));

  // List existing items
  if (S.kbItems.length) {
    w.appendChild(card('知识库列表', (() => {
      const tbl = el('table', { className: 'w-full text-sm' });
      const th = el('tr'); ['标题', '分类', '内容长度', '状态', '更新时间', '操作'].forEach(x => th.appendChild(el('th', { className: 'text-left p-2 border-b-2 text-gray-600 text-xs font-medium' }, x)));
      tbl.appendChild(th);
      S.kbItems.forEach(item => {
        const tr = el('tr', { className: 'hover:bg-gray-50' });
        tr.appendChild(el('td', { className: 'p-2 border-b text-xs font-medium max-w-[200px] truncate' }, item.title || ''));
        tr.appendChild(el('td', { className: 'p-2 border-b' }, el('span', { className: 'text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded' }, item.category || 'sop')));
        tr.appendChild(el('td', { className: 'p-2 border-b text-xs text-gray-500' }, (item.content_length || 0) + ' 字'));
        const stEl = el('span', { className: 'text-xs px-2 py-0.5 rounded ' + (item.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500') }, item.enabled ? '启用' : '禁用');
        tr.appendChild(el('td', { className: 'p-2 border-b' }, stEl));
        tr.appendChild(el('td', { className: 'p-2 border-b text-xs text-gray-500' }, fmtDate(item.updated_at)));
        const acts = el('td', { className: 'p-2 border-b flex gap-1' });
        acts.appendChild(btnGhost(item.enabled ? '禁用' : '启用', async () => { await PUT('/api/knowledge-base/' + item.id, { enabled: !item.enabled }); msg(item.enabled ? '已禁用' : '已启用'); go('knowledge'); }));
        acts.appendChild(btnDanger('删除', async () => { if (confirm('确定删除?')) { await DEL('/api/knowledge-base/' + item.id); msg('已删除'); go('knowledge'); } }));
        tr.appendChild(acts); tbl.appendChild(tr);
      });
      return tbl;
    })()));
  }
  return w;
}

// ═══════════════════════════════════════════════════════
// AGENT MEMORY (记忆系统)
// ═══════════════════════════════════════════════════════
/** 记忆页顶部：知识源体检（与下方「单 Agent 记忆流水」不同，见卡片内说明） */
function renderKnowledgeSourcesCard() {
  const ks = S.knowledgeSources;
  const err = S.knowledgeSourcesErr;
  const body = el('div', { className: 'text-sm text-gray-700 space-y-3' });
  if (err) {
    body.appendChild(el('p', { className: 'text-amber-700' }, '体检接口未加载：' + err));
    body.appendChild(btn('重试', () => go('memory'), 'bg-amber-50 text-amber-800 text-sm px-3 py-1.5 rounded-lg border border-amber-200'));
    return card('📡 知识源体检（RAG / Wiki / MemPalace / PG）', body);
  }
  if (!ks) {
    body.appendChild(el('p', { className: 'text-gray-500' }, '正在加载…'));
    return card('📡 知识源体检（RAG / Wiki / MemPalace / PG）', body);
  }
  const kb = ks.knowledgeBaseRag || {};
  const wiki = ks.wikiMd || {};
  const mp = ks.mempalace || {};
  const mem7 = ks.agentMemoryPg || {};
  const kg = ks.knowledgeGraphPg || {};
  const env = ks.envHints || {};
  const grid = el('div', { className: 'grid grid-cols-2 md:grid-cols-4 gap-3' });
  const pill = (label, val, sub) => {
    const d = el('div', { className: 'bg-slate-50 rounded-lg p-3 border border-slate-100' });
    d.appendChild(el('div', { className: 'text-xs text-slate-500' }, label));
    d.appendChild(el('div', { className: 'text-lg font-semibold text-slate-800' }, val));
    if (sub) d.appendChild(el('div', { className: 'text-xs text-slate-400 mt-1' }, sub));
    return d;
  };
  const kbScopes = Array.isArray(kb.byScope) ? kb.byScope.map((x) => (x.scope || '') + ':' + (x.cnt ?? 0)).join(' · ') : '';
  grid.appendChild(pill('knowledge_base', String(kb.totalRows ?? '—'), kbScopes.slice(0, 120)));
  grid.appendChild(pill('Wiki .md', String(wiki.mdCount ?? '—'), wiki.ok ? '目录可读' : '异常'));
  const mpN = mp.inventory && mp.inventory.total != null ? String(mp.inventory.total) : '—';
  grid.appendChild(pill('MemPalace', mp.reachable ? '可达' : '不可达', '条数 ' + mpN + (mp.enabled ? ' · 已启用' : ' · 未启用')));
  grid.appendChild(pill('图谱关系行', String(kg.businessEntityRelationRows ?? (kg.error || '—')), 'business_entity_relations'));
  grid.appendChild(pill('agent_memory(7d)', String(mem7.last7DaysTotal ?? '—'), '全 Agent 近7日'));
  body.appendChild(grid);
  const envRow = el('div', { className: 'flex flex-wrap gap-2 text-xs' });
  envRow.appendChild(el('span', { className: 'px-2 py-0.5 rounded bg-gray-100' }, 'ENABLE_MEMPALACE=' + !!env.ENABLE_MEMPALACE));
  envRow.appendChild(el('span', { className: 'px-2 py-0.5 rounded bg-gray-100' }, 'MEMPALACE_URL=' + !!env.MEMPALACE_URL_SET));
  envRow.appendChild(el('span', { className: 'px-2 py-0.5 rounded bg-gray-100' }, '知识LLM排序=' + !!env.KNOWLEDGE_USE_DEEPSEEK));
  body.appendChild(envRow);
  if (Array.isArray(ks.checklist) && ks.checklist.length) {
    const ol = el('ol', { className: 'list-decimal pl-5 text-xs text-gray-600 space-y-1' });
    ks.checklist.forEach((line) => ol.appendChild(el('li', {}, line)));
    body.appendChild(el('div', { className: 'mt-2' }, [el('div', { className: 'text-xs font-medium text-gray-700 mb-1' }, 'P0 自检要点'), ol]));
  }
  body.appendChild(el('p', { className: 'text-xs text-gray-500 border-t border-gray-100 pt-2 mt-2' },
    '与下方列表的区别：下方是「当前选中 Agent」写入 agent_memory 的流水；本卡片是「全库/全目录」供给面是否健康（与是否选中 data_auditor 无关）。'));
  body.appendChild(btn('刷新体检', async () => {
    try {
      S.knowledgeSources = await G('/api/admin/knowledge-sources');
      S.knowledgeSourcesErr = '';
      msg('已刷新知识源体检');
      render();
    } catch (e) {
      msg(e.message || '刷新失败', true);
    }
  }, 'mt-2 bg-teal-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-teal-700'));
  return card('📡 知识源体检（RAG / Wiki / MemPalace / PG）', body);
}

function viewMemory() {
  const w = el('div');
  w.appendChild(el('h2', { className: 'text-lg font-bold text-gray-900 mb-4' }, '🧠 Agent 记忆系统'));

  w.appendChild(renderKnowledgeSourcesCard());

  // Agent selector
  const selRow = el('div', { className: 'flex items-center gap-3 mb-4' });
  selRow.appendChild(el('span', { className: 'text-sm font-medium text-gray-700' }, '选择Agent:'));
  const sel = el('select', { id: 'mem_agent', className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-200 outline-none' });
  Object.entries(AN).forEach(([id, nm]) => { const o = el('option', { value: id }, nm + ' (' + id + ')'); if (id === S.selectedAgent) o.selected = true; sel.appendChild(o); });
  sel.onchange = async () => { S.selectedAgent = sel.value; await load('memory'); render(); };
  selRow.appendChild(sel);
  selRow.appendChild(btn('刷新', () => go('memory'), 'bg-gray-100 text-gray-700 text-sm px-3 py-2 rounded-lg hover:bg-gray-200 border border-gray-200'));
  w.appendChild(selRow);

  w.appendChild(el('div', { className: 'text-xs text-gray-500 mb-3' }, '当前Agent: ' + (AN[S.selectedAgent] || S.selectedAgent) + ' | 记忆条数: ' + S.memoryItems.length));

  if (!S.memoryItems.length) {
    w.appendChild(card('暂无记忆', el('p', { className: 'text-sm text-gray-500' }, '该Agent尚无记忆记录。记忆会在Agent处理用户消息时自动保存。')));
  } else {
    S.memoryItems.forEach((m, i) => {
      const c = el('div', { className: 'bg-white rounded-xl shadow-sm border border-gray-100 p-4 mb-3' });
      const hd = el('div', { className: 'flex justify-between items-center mb-2' });
      hd.appendChild(el('div', { className: 'flex items-center gap-2' }, [
        el('span', { className: 'text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded' }, m.memory_type || 'response'),
        m.store ? el('span', { className: 'text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded' }, m.store) : null,
        m.outcome_score ? el('span', { className: 'text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded' }, '评分:' + m.outcome_score) : null
      ].filter(Boolean)));
      hd.appendChild(el('span', { className: 'text-xs text-gray-400' }, fmtDate(m.created_at)));
      c.appendChild(hd);
      c.appendChild(el('p', { className: 'text-sm text-gray-700 whitespace-pre-wrap' }, (m.content || '').slice(0, 300) + (m.content?.length > 300 ? '...' : '')));
      if (m.context) {
        const ctx = typeof m.context === 'string' ? m.context : JSON.stringify(m.context);
        c.appendChild(el('div', { className: 'mt-2 text-xs text-gray-400 bg-gray-50 rounded p-2 font-mono' }, 'ctx: ' + ctx.slice(0, 200)));
      }
      w.appendChild(c);
    });
  }
  return w;
}

// ═══════════════════════════════════════════════════════
// FEATURE FLAGS (功能开关)
// ═══════════════════════════════════════════════════════
function viewFlags() {
  const w = el('div');
  w.appendChild(el('h2', { className: 'text-lg font-bold text-gray-900 mb-4' }, '功能开关 (Feature Flags)'));

  const defaultFlags = {
    enable_metric_dictionary: { label: '指标字典', desc: '启用BI指标自动匹配查询', default: true },
    enable_session_state: { label: '会话状态', desc: '跨轮对话上下文记忆', default: true },
    enable_data_executor: { label: 'Data Executor', desc: '确定性数据查询层(替代LLM查数)', default: true },
    enable_business_diagnosis: { label: '经营诊断', desc: 'LLM约束分析层(高级诊断)', default: false },
    enable_rule_engine: { label: '规则引擎路由', desc: '规则引擎强路由(替代LLM路由)', default: true },
    enable_memory_system: { label: '记忆系统', desc: 'Agent记忆持久化(学习历史)', default: true },
    enable_rhythm_engine: { label: '任务设定', desc: '定时任务调度(晨检/巡检/日报)', default: true },
    enable_anomaly_detection: { label: '异常检测', desc: '自动异常触发与扣分', default: true },
    enable_campaign_evaluation: { label: '营销评估', desc: '营销活动自动效果评分', default: true },
    enable_procurement_advisor: { label: '采购建议', desc: '基于消耗数据的智能采购建议', default: true },
    bitable_polling: { label: 'Bitable轮询', desc: '飞书多维表格数据自动同步(每2分钟)', default: true }
  };

  w.appendChild(card('系统功能开关', (() => {
    const g = el('div', { className: 'space-y-3' });
    Object.entries(defaultFlags).forEach(([key, meta]) => {
      const row = el('div', { className: 'flex items-center justify-between py-3 px-4 bg-gray-50 rounded-lg' });
      const left = el('div', { className: 'flex-1' });
      left.appendChild(el('div', { className: 'font-medium text-sm' }, meta.label));
      left.appendChild(el('div', { className: 'text-xs text-gray-500' }, meta.desc));
      row.appendChild(left);
      const toggle = el('label', { className: 'relative inline-flex items-center cursor-pointer' });
      const ck = el('input', { type: 'checkbox', id: 'ff_' + key, className: 'sr-only peer' });
      ck.checked = S.featureFlags[key] !== undefined ? S.featureFlags[key] : meta.default;
      toggle.appendChild(ck);
      toggle.appendChild(el('div', { className: 'w-11 h-6 bg-gray-200 peer-focus:ring-2 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[\'\'] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600' }));
      row.appendChild(toggle);
      g.appendChild(row);
    });
    g.appendChild(btn('保存功能开关', async () => {
      const flags = {};
      Object.keys(defaultFlags).forEach(k => { flags[k] = $('ff_' + k)?.checked || false; });
      await PUT('/api/feature-flags', { flags }); msg('功能开关已保存'); S.featureFlags = flags;
    }, 'mt-4 bg-indigo-600 text-white text-sm px-5 py-2 rounded-lg hover:bg-indigo-700 font-medium'));
    return g;
  })()));

  w.appendChild(el('div', { className: 'mt-3 text-xs text-gray-400' }, '提示: 功能开关变更后,需要重启服务或等待下次请求生效。部分功能(如节奏引擎)可能需要重新加载cron。'));
  return w;
}

// ═══════════════════════════════════════════════════════
// SYSTEM CONFIG (增强版 - 可编辑)
// ═══════════════════════════════════════════════════════
function viewCfgs() {
  const w = el('div');
  w.appendChild(el('div', { className: 'flex justify-between items-center mb-4' }, [
    el('h2', { className: 'text-lg font-bold text-gray-900' }, '系统配置'),
    el('span', { className: 'text-xs bg-gray-100 text-gray-600 px-3 py-1 rounded-full font-medium' }, S.cfgs.length + ' 配置项')
  ]));

  // Add new config
  w.appendChild(card('新增配置项', (() => {
    const g = el('div', { className: 'grid grid-cols-3 gap-3' });
    g.appendChild(field('配置键', inp('nc_key', 'config_key_name')));
    g.appendChild(field('描述', inp('nc_desc', '配置描述')));
    const valTa = el('textarea', { id: 'nc_val', className: 'border border-gray-300 rounded-lg p-3 text-sm font-mono focus:ring-2 focus:ring-indigo-200 outline-none', rows: '2', placeholder: 'JSON值或文本值' });
    g.appendChild(field('值 (JSON)', valTa));
    g.appendChild(btn('添加', async () => {
      const key = $('nc_key')?.value?.trim(), desc = $('nc_desc')?.value?.trim();
      let val = $('nc_val')?.value?.trim();
      if (!key) { msg('请输入配置键', true); return; }
      try { val = JSON.parse(val); } catch (e) { /* keep as string */ }
      await PUT('/api/config/' + key, { config_value: val, description: desc }); msg('配置已添加'); go('configs');
    }));
    return g;
  })()));

  if (!S.cfgs.length) { w.appendChild(el('p', { className: 'text-gray-500' }, '暂无配置项')); return w; }
  S.cfgs.forEach(c => {
    const d = el('div', { className: 'bg-white rounded-xl shadow-sm border p-4 mb-3' });
    const hd = el('div', { className: 'flex justify-between items-center' });
    hd.appendChild(el('div', { className: 'flex items-center gap-2' }, [
      el('code', { className: 'font-mono text-sm font-medium text-indigo-700' }, c.config_key),
      el('span', { className: 'text-xs text-gray-400' }, 'v' + (c.version || 1))
    ]));
    const actions = el('div', { className: 'flex gap-2' });
    actions.appendChild(btnGhost('查看/编辑', async () => {
      const full = await G('/api/config/' + c.config_key).catch(() => ({}));
      const val = full.config_value;
      const valStr = typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val || '');
      const modal = el('div', { className: 'fixed inset-0 bg-black/50 flex items-center justify-center z-50', id: 'cfg_modal' });
      const box = el('div', { className: 'bg-white rounded-2xl shadow-2xl p-6 w-full max-w-2xl max-h-[80vh] overflow-auto' });
      box.appendChild(el('div', { className: 'flex justify-between items-center mb-4' }, [
        el('h3', { className: 'font-bold text-lg' }, c.config_key),
        btn('关闭', () => modal.remove(), 'text-sm text-gray-500 hover:text-red-500 bg-transparent')
      ]));
      const ta = el('textarea', { id: 'cfg_edit_val', className: 'w-full border border-gray-300 rounded-lg p-3 text-sm font-mono focus:ring-2 focus:ring-indigo-200 outline-none', rows: '12' }); ta.value = valStr;
      box.appendChild(ta);
      box.appendChild(el('div', { className: 'flex justify-end gap-2 mt-4' }, [
        btn('保存', async () => {
          let v = $('cfg_edit_val')?.value?.trim();
          try { v = JSON.parse(v); } catch (e) { /* keep as string */ }
          await PUT('/api/config/' + c.config_key, { config_value: v }); msg('配置已更新'); modal.remove(); go('configs');
        }),
        btnDanger('删除此配置', async () => { if (confirm('确定删除 ' + c.config_key + '?')) { await DEL('/api/config/' + c.config_key); msg('已删除'); modal.remove(); go('configs'); } })
      ]));
      modal.appendChild(box); document.body.appendChild(modal);
    }));
    hd.appendChild(actions);
    d.appendChild(hd);
    if (c.description) d.appendChild(el('div', { className: 'text-xs text-gray-500 mt-1' }, c.description));
    d.appendChild(el('div', { className: 'text-xs text-gray-400 mt-1' }, '更新: ' + fmtDate(c.updated_at)));
    w.appendChild(d);
  });
  return w;
}

// ═══════════════════════════════════════════════════════
// CHAIRMAN CONFIG (董事长配置)
// ═══════════════════════════════════════════════════════

const CHAIRMAN_SUBTABS = [
  ['stores', '🏪 门店画像'],
  ['actions', '📋 行动模板'],
  ['training', '🎓 培训联动'],
  ['trends', '📈 趋势阈值'],
];

const ANOMALY_LABELS = {
  revenue_achievement: '营收达成',
  revenue_achievement_monthly: '月营收达成',
  revenue_drop: '营收骤降',
  traffic_decline: '客流下降',
  labor_efficiency: '人效不足',
  gross_margin: '毛利异常',
  bad_review_service: '差评-服务',
  bad_review_product: '差评-出品',
  table_visit_product: '桌访-出品',
  table_visit_ratio: '桌访占比低',
  recharge_zero: '充值异常',
  food_safety: '食品安全',
  weekday_trend: '同日环比趋势',
  meal_balance: '午晚市失衡',
  dish_decline: '菜品衰退',
};

const SCENARIO_LIST = [
  '午市客流不足', '客单价下降', '差评-服务', '差评-出品',
  '毛利异常', '人效不足', '菜品衰退', '午晚市失衡',
  '食品安全', '充值异常', '桌访不足', '营收骤降',
];

function viewChairman() {
  const w = el('div');
  const cfg = S.chairmanCfg || {};
  const subtab = S.chairmanTab || 'stores';

  w.appendChild(el('div', { className: 'flex justify-between items-center mb-4' }, [
    el('h2', { className: 'text-lg font-bold text-gray-900' }, '👔 董事长级配置'),
    el('span', { className: 'text-xs bg-amber-100 text-amber-700 px-3 py-1 rounded-full font-medium' }, '配置后影响晨报诊断、行动计划、培训联动')
  ]));

  // Sub-tabs
  const nav = el('div', { className: 'flex gap-2 mb-4 border-b border-gray-200 pb-2' });
  CHAIRMAN_SUBTABS.forEach(([k, l]) => {
    const active = subtab === k;
    nav.appendChild(el('button', {
      className: 'px-4 py-2 text-sm rounded-lg font-medium transition-colors ' + (active ? 'bg-amber-600 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100'),
      onclick: () => { S.chairmanTab = k; render(); }
    }, l));
  });
  w.appendChild(nav);

  if (subtab === 'stores') w.appendChild(chairmanStoreTab(cfg));
  else if (subtab === 'actions') w.appendChild(chairmanActionTab(cfg));
  else if (subtab === 'training') w.appendChild(chairmanTrainingTab(cfg));
  else if (subtab === 'trends') w.appendChild(chairmanTrendTab(cfg));

  return w;
}

// ── Store Profiles ──
function chairmanStoreTab(cfg) {
  const stores = cfg.stores || {};
  const storeNames = Object.keys(stores);
  const wrap = el('div');

  if (!storeNames.length) {
    wrap.appendChild(el('p', { className: 'text-gray-500 text-sm' }, '暂无门店配置，请先加载默认配置'));
    wrap.appendChild(btn('加载默认配置', async () => {
      await POST('/api/chairman/config', { stores: 'init_defaults' });
      msg('默认配置已加载'); go('chairman');
    }));
    return wrap;
  }

  storeNames.forEach((sn, si) => {
    const s = stores[sn];
    const brand = s.brand || '';
    const isHC = /洪潮/.test(sn);
    const isMJX = /马己仙/.test(sn);

    const storeCard = el('div', { className: 'mb-6' });
    storeCard.appendChild(el('div', { className: 'flex justify-between items-center mb-3' }, [
      el('h3', { className: 'text-base font-bold text-gray-800' }, `🏪 ${sn}（${brand}）`),
      el('span', { className: 'text-xs text-gray-400' }, `${s.cuisine || ''} | 人均${s.avgPrice || '-'}元 | ${s.seats || '-'}餐位`)
    ]));

    // ── Basic info grid ──
    const grid = el('div', { className: 'grid grid-cols-2 md:grid-cols-3 gap-3 mb-4' });
    const basics = [
      ['定位', 'positioning', s.positioning || '', '如: 大众正餐'],
      ['目标客群', 'targetCustomer', s.targetCustomer || '', '如: 周边白领、家庭聚餐'],
      ['核心策略', 'coreStrategy', s.coreStrategy || '', '如: 走量，翻台率是生命线'],
      ['当前瓶颈', 'bottleneck', s.bottleneck || '', '如: 午市客流'],
      ['餐位数', 'seats', s.seats || '', '整数'],
      ['桌数', 'tables', s.tables || '', '整数'],
      ['人均(元)', 'avgPrice', s.avgPrice || '', '整数'],
      ['面积(m²)', 'area', s.area || '', '整数'],
    ];
    basics.forEach(([label, key, val, ph]) => {
      const field = el('div');
      field.appendChild(lbl(label));
      const inp = el('input', { type: key === 'seats' || key === 'tables' || key === 'area' || key === 'avgPrice' ? 'number' : 'text', value: String(val), id: `cs_${si}_${key}`, className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm w-full', placeholder: ph });
      field.appendChild(inp);
      grid.appendChild(field);
    });

    // Peak hours
    grid.appendChild((() => { const f = el('div'); f.appendChild(lbl('高峰时段')); const inp = el('input', { type: 'text', value: (s.peakHours || []).join(', '), id: `cs_${si}_peakHours`, className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm w-full', placeholder: '如: 11:30-13:30, 17:30-20:30' }); f.appendChild(inp); return f; })());
    // New fields the system needs to know
    const extras = [
      ['招牌产品/拳头产品', 'signatureProducts', s.signatureProducts || '', '如: 白切鸡、烧鹅（逗号分隔）'],
      ['竞争优势/差异化', 'competitiveAdvantage', s.competitiveAdvantage || '', '如: 周边唯一正宗粤菜、食材当天到货'],
      ['服务风格', 'serviceStyle', s.serviceStyle || '', '如: 快速翻台型 / 精致服务型'],
      ['包房数', 'privateRooms', s.privateRooms || '', '整数，如0表示无包房'],
      ['厨房产能(同时出菜)', 'kitchenCapacity', s.kitchenCapacity || '', '整数，如60'],
      ['淡季/低谷说明', 'lowSeasonNote', s.lowSeasonNote || '', '如: 周一至周四午市冷清'],
    ];
    extras.forEach(([label, key, val, ph]) => {
      const field = el('div');
      field.appendChild(lbl(label));
      field.appendChild(el('input', { type: 'text', value: String(val), id: `cs_${si}_${key}`, className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm w-full', placeholder: ph }));
      grid.appendChild(field);
    });
    storeCard.appendChild(grid);

    // ── Daily targets: Dine-in ──
    const di = s.target_daily_dineIn || s.target_daily || {};
    const diCard = el('div', { className: 'bg-blue-50 rounded-xl p-4 mb-4' });
    diCard.appendChild(el('h4', { className: 'text-sm font-semibold text-blue-800 mb-3' }, '🍽️ 堂食日均目标'));
    const diGrid = el('div', { className: 'grid grid-cols-2 md:grid-cols-4 gap-3' });
    [
      ['堂食营收(元)', 'revenue', di.revenue || 0],
      ['堂食订单数', 'orders', di.orders || 0],
      ['堂食客单价(元)', 'avgTicket', di.avgTicket || 0],
      ['翻台率', 'turnover', di.turnover || 0],
    ].forEach(([label, key, val]) => {
      diGrid.appendChild(field(label, el('input', { type: 'number', value: String(val), id: `cs_${si}_tgt_di_${key}`, className: 'border border-blue-200 bg-white rounded-lg px-3 py-2 text-sm w-full', step: key === 'turnover' ? '0.1' : '1' })));
    });

    // Has takeout toggle
    const hasTakeout = s.hasTakeout !== false && (s.target_daily_takeout?.revenue > 0 || s.target_daily_takeout?.orders > 0);
    const takeoutToggle = el('div', { className: 'flex items-center gap-2 mt-3' });
    takeoutToggle.appendChild(el('label', { className: 'text-sm text-gray-700 font-medium' }, '有外卖业务：'));
    const toggleCb = el('input', { type: 'checkbox', id: `cs_${si}_hasTakeout`, checked: hasTakeout, className: 'w-4 h-4' });
    takeoutToggle.appendChild(toggleCb);
    diCard.appendChild(diGrid);
    diCard.appendChild(takeoutToggle);
    storeCard.appendChild(diCard);

    // ── Daily targets: Takeout ──
    const to = s.target_daily_takeout || {};
    const toCard = el('div', { className: 'bg-orange-50 rounded-xl p-4 mb-4', id: `cs_${si}_takeout_card` });
    toCard.appendChild(el('h4', { className: 'text-sm font-semibold text-orange-800 mb-3' }, '🛵 外卖日均目标'));
    const toGrid = el('div', { className: 'grid grid-cols-2 md:grid-cols-3 gap-3' });
    [
      ['外卖营收(元)', 'revenue', to.revenue || 0],
      ['外卖订单数', 'orders', to.orders || 0],
      ['外卖客单价(元)', 'avgTicket', to.avgTicket || 0],
    ].forEach(([label, key, val]) => {
      toGrid.appendChild(field(label, el('input', { type: 'number', value: String(val), id: `cs_${si}_tgt_to_${key}`, className: 'border border-orange-200 bg-white rounded-lg px-3 py-2 text-sm w-full', step: '1' })));
    });
    toCard.appendChild(toGrid);
    storeCard.appendChild(toCard);

    // Toggle takeout card visibility
    const updateTakeoutVisibility = () => {
      const show = toggleCb.checked;
      toCard.style.display = show ? '' : 'none';
      if (!show) {
        ['revenue', 'orders', 'avgTicket'].forEach(k => { const inp = $(`cs_${si}_tgt_to_${k}`); if (inp) inp.value = '0'; });
      }
    };
    toggleCb.addEventListener('change', updateTakeoutVisibility);
    updateTakeoutVisibility();

    // ── Cost structure ──
    const cs = s.cost_structure || {};
    const csCard = el('div', { className: 'bg-green-50 rounded-xl p-4 mb-4' });
    csCard.appendChild(el('h4', { className: 'text-sm font-semibold text-green-800 mb-3' }, '💰 成本结构（比率填小数，如0.35表示35%）'));
    const csGrid = el('div', { className: 'grid grid-cols-2 md:grid-cols-4 gap-3' });
    [
      ['食材成本率', 'foodCostRate', cs.foodCostRate || 0],
      ['人力成本率', 'laborCostRate', cs.laborCostRate || 0],
      ['租金成本率', 'rentCostRate', cs.rentCostRate || 0],
      ['目标利润率', 'targetProfitRate', cs.targetProfitRate || 0],
    ].forEach(([label, key, val]) => {
      csGrid.appendChild(field(label + ' (' + Math.round((val || 0) * 100) + '%)', el('input', { type: 'number', step: '0.01', value: String(val), id: `cs_${si}_cs_${key}`, className: 'border border-green-200 bg-white rounded-lg px-3 py-2 text-sm w-full' })));
    });
    csCard.appendChild(csGrid);
    storeCard.appendChild(csCard);

    // ── Top dishes ──
    const dishes = s.topDishes || [];
    const dishCard = el('div', { className: 'bg-amber-50 rounded-xl p-4 mb-4' });
    dishCard.appendChild(el('h4', { className: 'text-sm font-semibold text-amber-800 mb-3' }, '🔥 高毛利招牌菜（填你店里真实菜品、价格、毛利率）'));
    const dishList = el('div', { id: `cs_${si}_dishes` });
    dishes.forEach((d, di) => {
      dishList.appendChild(chairmanDishRow(si, di, d, false));
    });
    dishCard.appendChild(dishList);
    const addDishBtn = btn('+ 添加招牌菜', () => {
      const list = $(`cs_${si}_dishes`);
      const newDi = list.children.length;
      list.appendChild(chairmanDishRow(si, newDi, {}, true));
    }, 'bg-amber-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-amber-700 mt-2');
    dishCard.appendChild(addDishBtn);
    storeCard.appendChild(dishCard);

    // ── Problem dishes ──
    const probs = s.problemDishes || [];
    const probCard = el('div', { className: 'bg-red-50 rounded-xl p-4 mb-4' });
    probCard.appendChild(el('h4', { className: 'text-sm font-semibold text-red-800 mb-3' }, '⚠️ 需关注菜品（低毛利或差评多的菜品）'));
    const probList = el('div', { id: `cs_${si}_probs` });
    probs.forEach((d, di) => {
      probList.appendChild(chairmanProbRow(si, di, d, false));
    });
    probCard.appendChild(probList);
    const addProbBtn = btn('+ 添加关注菜品', () => {
      const list = $(`cs_${si}_probs`);
      const newDi = list.children.length;
      list.appendChild(chairmanProbRow(si, newDi, {}, true));
    }, 'bg-red-500 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-red-600 mt-2');
    probCard.appendChild(addProbBtn);
    storeCard.appendChild(probCard);

    wrap.appendChild(card(sn, [storeCard]));
  });

  // Save button
  wrap.appendChild(el('div', { className: 'flex justify-end gap-3 mt-4' }, [
    btn('💾 保存门店画像配置', async () => {
      const stores = cfg.stores || {};
      const update = { stores: {} };
      Object.keys(stores).forEach((sn, si) => {
        const s = stores[sn];
        const g = id => $(id)?.value;
        const tgtDI = {
          revenue: Number(g(`cs_${si}_tgt_di_revenue`)) || s.target_daily_dineIn?.revenue || s.target_daily?.revenue || 0,
          orders: Number(g(`cs_${si}_tgt_di_orders`)) || s.target_daily_dineIn?.orders || s.target_daily?.orders || 0,
          avgTicket: Number(g(`cs_${si}_tgt_di_avgTicket`)) || s.target_daily_dineIn?.avgTicket || s.target_daily?.avgTicket || 0,
          turnover: Number(g(`cs_${si}_tgt_di_turnover`)) || s.target_daily_dineIn?.turnover || s.target_daily?.turnover || 0,
        };
        const hasTO = $(`cs_${si}_hasTakeout`)?.checked;
        const tgtTO = {
          revenue: Number(g(`cs_${si}_tgt_to_revenue`)) || s.target_daily_takeout?.revenue || 0,
          orders: Number(g(`cs_${si}_tgt_to_orders`)) || s.target_daily_takeout?.orders || 0,
          avgTicket: Number(g(`cs_${si}_tgt_to_avgTicket`)) || s.target_daily_takeout?.avgTicket || 0,
        };
        const cs = {
          foodCostRate: Number(g(`cs_${si}_cs_foodCostRate`)) || s.cost_structure?.foodCostRate || 0,
          laborCostRate: Number(g(`cs_${si}_cs_laborCostRate`)) || s.cost_structure?.laborCostRate || 0,
          rentCostRate: Number(g(`cs_${si}_cs_rentCostRate`)) || s.cost_structure?.rentCostRate || 0,
          targetProfitRate: Number(g(`cs_${si}_cs_targetProfitRate`)) || s.cost_structure?.targetProfitRate || 0,
        };
        const peakHoursVal = (g(`cs_${si}_peakHours`) || '').split(/[,，]/).map(x => x.trim()).filter(Boolean);
        const dishes = chairmanCollectDishes(si);
        const probs = chairmanCollectProbs(si);
        update.stores[sn] = {
          brand: s.brand, cuisine: s.cuisine,
          positioning: g(`cs_${si}_positioning`) || s.positioning || '',
          targetCustomer: g(`cs_${si}_targetCustomer`) || s.targetCustomer || '',
          area: Number(g(`cs_${si}_area`)) || s.area || 0,
          seats: Number(g(`cs_${si}_seats`)) || s.seats || 0,
          tables: Number(g(`cs_${si}_tables`)) || s.tables || 0,
          avgPrice: Number(g(`cs_${si}_avgPrice`)) || s.avgPrice || 0,
          peakHours: peakHoursVal.length ? peakHoursVal : (s.peakHours || []),
          hasTakeout: hasTO,
          target_daily_dineIn: tgtDI,
          target_daily_takeout: hasTO ? tgtTO : { revenue: 0, orders: 0, avgTicket: 0 },
          cost_structure: cs,
          coreStrategy: g(`cs_${si}_coreStrategy`) || s.coreStrategy || '',
          bottleneck: g(`cs_${si}_bottleneck`) || s.bottleneck || '',
          signatureProducts: g(`cs_${si}_signatureProducts`) || s.signatureProducts || '',
          competitiveAdvantage: g(`cs_${si}_competitiveAdvantage`) || s.competitiveAdvantage || '',
          serviceStyle: g(`cs_${si}_serviceStyle`) || s.serviceStyle || '',
          privateRooms: Number(g(`cs_${si}_privateRooms`)) || 0,
          kitchenCapacity: Number(g(`cs_${si}_kitchenCapacity`)) || 0,
          lowSeasonNote: g(`cs_${si}_lowSeasonNote`) || s.lowSeasonNote || '',
          topDishes: dishes, problemDishes: probs,
        };
      });
      await POST('/api/chairman/config', update);
      msg('门店画像配置已保存');
      go('chairman');
    }, 'bg-amber-600 text-white text-sm px-6 py-3 rounded-lg hover:bg-amber-700 font-semibold shadow-sm')
  ]));

  return wrap;
}

function chairmanDishRow(si, di, d, isNew) {
  const row = el('div', { className: 'flex gap-2 mb-2 items-center' });
  row.appendChild(el('input', { type: 'text', value: String(isNew ? '' : (d.name || '')), id: `cs_${si}_dish_${di}_name`, className: 'border border-amber-200 bg-white rounded-lg px-2 py-1.5 text-sm flex-1', placeholder: '菜名' }));
  row.appendChild(el('input', { type: 'number', value: String(isNew ? '' : (d.price || '')), id: `cs_${si}_dish_${di}_price`, className: 'border border-amber-200 bg-white rounded-lg px-2 py-1.5 text-sm w-20', placeholder: '价格' }));
  row.appendChild(el('input', { type: 'number', step: '0.01', value: String(isNew ? '' : (d.margin || '')), id: `cs_${si}_dish_${di}_margin`, className: 'border border-amber-200 bg-white rounded-lg px-2 py-1.5 text-sm w-20', placeholder: '毛利0.68' }));
  row.appendChild(el('button', { className: 'text-red-400 hover:text-red-600 text-lg font-bold px-1', onclick: () => row.remove() }, '✕'));
  return row;
}

function chairmanCollectDishes(si) {
  const dishes = [];
  let di = 0;
  while (true) {
    const name = $(`cs_${si}_dish_${di}_name`)?.value?.trim();
    if (!name) { di++; if (di > 50) break; continue; }
    dishes.push({
      name,
      price: Number($(`cs_${si}_dish_${di}_price`)?.value) || 0,
      margin: Number($(`cs_${si}_dish_${di}_margin`)?.value) || 0,
    });
    di++;
    if (di > 50) break;
  }
  return dishes;
}

function chairmanProbRow(si, di, d, isNew) {
  const row = el('div', { className: 'flex gap-2 mb-2 items-center' });
  row.appendChild(el('input', { type: 'text', value: String(isNew ? '' : (d.name || '')), id: `cs_${si}_prob_${di}_name`, className: 'border border-red-200 bg-white rounded-lg px-2 py-1.5 text-sm flex-1', placeholder: '菜品名' }));
  row.appendChild(el('input', { type: 'text', value: String(isNew ? '' : (d.reason || '')), id: `cs_${si}_prob_${di}_reason`, className: 'border border-red-200 bg-white rounded-lg px-2 py-1.5 text-sm flex-1', placeholder: '原因（如：毛利低、差评多）' }));
  row.appendChild(el('button', { className: 'text-red-400 hover:text-red-600 text-lg font-bold px-1', onclick: () => row.remove() }, '✕'));
  return row;
}

function chairmanCollectProbs(si) {
  const probs = [];
  let di = 0;
  while (true) {
    const name = $(`cs_${si}_prob_${di}_name`)?.value?.trim();
    if (!name) { di++; if (di > 50) break; continue; }
    probs.push({
      name,
      reason: $(`cs_${si}_prob_${di}_reason`)?.value?.trim() || '',
    });
    di++;
    if (di > 50) break;
  }
  return probs;
}

// ── Action Templates ──
function chairmanActionTab(cfg) {
  const templates = cfg.action_templates || [];
  const wrap = el('div');
  const brands = ['马己仙', '洪潮'];

  wrap.appendChild(el('p', { className: 'text-sm text-gray-600 mb-4 bg-amber-50 p-3 rounded-lg' },
    '📋 行动模板是验证过的最佳实践方案。当异常触发时，系统会自动匹配模板并推送给店长选择。每个方案需包含具体的菜品名、定价、话术和可量化的验收标准。'
  ));

  // Show existing templates grouped by brand
  brands.forEach(brand => {
    const brandTemplates = templates.filter(t => t.brand === brand);
    const brandCard = el('div', { className: 'mb-6' });
    brandCard.appendChild(el('h3', { className: 'text-base font-bold text-gray-800 mb-3' }, `${brand === '马己仙' ? '🍛' : '🍲'} ${brand}模板 (${brandTemplates.length}个)`));

    brandTemplates.forEach((t, ti) => {
      const globalTi = templates.indexOf(t);
      const tCard = el('div', { className: 'bg-white rounded-lg border border-gray-200 p-4 mb-3' });
      tCard.appendChild(el('div', { className: 'flex justify-between items-center mb-2' }, [
        el('span', { className: 'font-medium text-sm text-gray-900' }, `场景: ${t.scenario}`),
        el('button', { className: 'text-red-400 hover:text-red-600 text-sm', onclick: () => {
          templates.splice(globalTi, 1);
          POST('/api/chairman/config', { action_templates: templates }).then(() => { msg('模板已删除'); go('chairman'); });
        }}, '删除')
      ]));

      (t.options || []).forEach((opt, oi) => {
        tCard.appendChild(el('div', { className: 'bg-gray-50 rounded-lg p-3 mb-2' }, [
          el('div', { className: 'font-medium text-sm text-gray-800' }, `${String.fromCharCode(65 + oi)}. ${opt.title}`),
          el('div', { className: 'text-xs text-gray-600 mt-1' }, opt.description),
          el('div', { className: 'text-xs text-indigo-600 mt-1' }, `验收: ${opt.success_metric}`),
          el('div', { className: 'text-xs text-gray-500' }, `负责: ${opt.assignee === 'store_production_manager' ? '厨师长' : '店长'} | 截止: ${opt.deadline}`),
        ]));
      });
      brandCard.appendChild(tCard);
    });

    // Add new template form
    const addForm = el('div', { className: 'bg-amber-50 rounded-lg p-4 border border-amber-200' });
    addForm.appendChild(el('h4', { className: 'text-sm font-semibold text-amber-800 mb-2' }, '+ 新增模板'));
    const formGrid = el('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-3' });
    const scSel = el('select', { id: `nat_scenario_${brand}`, className: 'border border-amber-200 rounded-lg px-3 py-2 text-sm w-full bg-white' });
    SCENARIO_LIST.forEach(s => scSel.appendChild(el('option', { value: s }, s)));
    formGrid.appendChild(field('异常场景', scSel));

    const titleInp = el('input', { type: 'text', id: `nat_title_${brand}`, className: 'border border-amber-200 rounded-lg px-3 py-2 text-sm w-full bg-white', placeholder: '如: 午市双人套餐引流' });
    formGrid.appendChild(field('方案标题', titleInp));

    const descInp = el('textarea', { id: `nat_desc_${brand}`, className: 'border border-amber-200 rounded-lg px-3 py-2 text-sm w-full bg-white', rows: '3', placeholder: '详细描述，包含具体菜品名、定价、话术。如：推98元双人餐（白切鸡+干炒牛河+老火靓汤+米饭），毛利率约62%...' });
    formGrid.appendChild(field('方案描述（含菜品、定价、话术）', descInp));

    const metInp = el('input', { type: 'text', id: `nat_metric_${brand}`, className: 'border border-amber-200 rounded-lg px-3 py-2 text-sm w-full bg-white', placeholder: '如: 午市订单≥45单/日，套餐点单率≥20%' });
    formGrid.appendChild(field('验收标准（可量化的）', metInp));

    const assSel = el('select', { id: `nat_assignee_${brand}`, className: 'border border-amber-200 rounded-lg px-3 py-2 text-sm w-full bg-white' });
    assSel.appendChild(el('option', { value: 'store_manager' }, '店长'));
    assSel.appendChild(el('option', { value: 'store_production_manager' }, '厨师长'));
    formGrid.appendChild(field('负责人', assSel));

    const dlInp = el('input', { type: 'text', id: `nat_deadline_${brand}`, className: 'border border-amber-200 rounded-lg px-3 py-2 text-sm w-full bg-white', placeholder: '如: 明午市前 / 3天内' });
    formGrid.appendChild(field('截止时间', dlInp));

    addForm.appendChild(formGrid);
    addForm.appendChild(btn('添加模板', async () => {
      const scenario = $(`nat_scenario_${brand}`)?.value;
      const title = $(`nat_title_${brand}`)?.value?.trim();
      const desc = $(`nat_desc_${brand}`)?.value?.trim();
      const metric = $(`nat_metric_${brand}`)?.value?.trim();
      const assignee = $(`nat_assignee_${brand}`)?.value;
      const deadline = $(`nat_deadline_${brand}`)?.value?.trim();
      if (!scenario || !title) { msg('场景和标题必填', true); return; }
      const newTemplates = [...templates, {
        scenario, brand, priority: 1,
        options: [{ title, description: desc || '', success_metric: metric || '', assignee: assignee || 'store_manager', deadline: deadline || '3天内' }]
      }];
      await POST('/api/chairman/config', { action_templates: newTemplates });
      msg('模板已添加');
      go('chairman');
    }, 'bg-amber-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-amber-700 mt-3'));
    brandCard.appendChild(addForm);
    wrap.appendChild(card(`${brand}行动模板`, [brandCard]));
  });

  return wrap;
}

// ── Training Trigger Rules ──
function chairmanTrainingTab(cfg) {
  const trainingMap = cfg.training_map || {};
  const wrap = el('div');
  const brands = ['马己仙', '洪潮'];
  const audienceOptions = ['新入职员工', '新员工(3个月内)', '老员工', '店长', '厨师长', '前厅主管', '全部员工'];
  const LEVEL_LABELS = { low: 'low仅', medium: 'medium+' };
  const SEVERITY_OPTS = ['low', 'medium', 'high'];

  wrap.appendChild(el('p', { className: 'text-sm text-gray-600 mb-4 bg-blue-50 p-3 rounded-lg' },
    '🎓 当异常触发时，系统可能自动创建培训任务。配置决定：哪种异常→哪些品牌→什么培训→培训谁→考核标准→冷却期。'
  ));

  // Group training entries by anomaly key, then by brand
  const allKeys = [...new Set([...Object.keys(ANOMALY_LABELS), ...Object.keys(trainingMap)])];

  allKeys.forEach(key => {
    const entry = trainingMap[key] || {};
    const label = ANOMALY_LABELS[key] || key;
    const isConfigured = entry.course || (entry.brands && entry.brands.length > 0);

    const cardEl = el('div', { className: 'bg-white rounded-xl shadow-sm border p-4 mb-3' });
    cardEl.appendChild(el('div', { className: 'flex justify-between items-center mb-3' }, [
      el('span', { className: 'font-semibold text-sm text-gray-900' }, `${key} → ${label}`),
      el('span', { className: 'text-xs ' + (isConfigured ? 'text-green-600' : 'text-gray-400') }, isConfigured ? '已配置' : '未配置')
    ]));

    // Check if this is a brand-differentiated config
    const hasBrandConfig = entry.brands && Array.isArray(entry.brands);

    if (hasBrandConfig) {
      // Brand-differentiated mode
      brands.forEach(brand => {
        const brandCfg = entry.brands.find(b => b.brand === brand) || {};
        const bDiv = el('div', { className: 'bg-gray-50 rounded-lg p-3 mb-2' });
        bDiv.appendChild(el('div', { className: 'font-medium text-sm text-gray-800 mb-2' }, `${brand === '马己仙' ? '🍛' : '🍲'} ${brand}`));
        const g = el('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-2' });
        g.appendChild(field('课程名', el('input', { type: 'text', value: String(brandCfg.course || ''), id: `tr_${key}_${brand}_course`, className: 'border border-blue-200 rounded-lg px-2 py-1.5 text-sm w-full', placeholder: '课程名' })));
        g.appendChild(field('培训内容', el('input', { type: 'text', value: String(brandCfg.content || ''), id: `tr_${key}_${brand}_content`, className: 'border border-blue-200 rounded-lg px-2 py-1.5 text-sm w-full', placeholder: '培训内容' })));
        g.appendChild(field('考核标准', el('input', { type: 'text', value: String(brandCfg.examPass || ''), id: `tr_${key}_${brand}_exam`, className: 'border border-blue-200 rounded-lg px-2 py-1.5 text-sm w-full', placeholder: '如: 考试≥90分' })));
        // Target audience multi-select
        const audDiv = el('div');
        audDiv.appendChild(lbl('培训对象'));
        const audWrap = el('div', { className: 'flex flex-wrap gap-1' });
        const selAud = (brandCfg.targetAudience || []).reduce((m, a) => { m[a] = true; return m; }, {});
        audienceOptions.forEach(ao => {
          const cb = el('input', { type: 'checkbox', id: `tr_${key}_${brand}_aud_${ao}`, checked: !!selAud[ao], className: 'mr-1' });
          const lab = el('label', { className: 'text-xs text-gray-700 cursor-pointer mr-2' });
          lab.appendChild(cb); lab.appendChild(document.createTextNode(' ' + ao));
          audWrap.appendChild(lab);
        });
        audDiv.appendChild(audWrap);
        g.appendChild(audDiv);
        g.appendChild(field('冷却天数', el('input', { type: 'number', value: String(brandCfg.cooldownDays ?? entry.cooldownDays ?? 14), id: `tr_${key}_${brand}_cooldown`, className: 'border border-blue-200 rounded-lg px-2 py-1.5 text-sm w-full', min: '1', max: '90' })));
        // Severity threshold
        const sevDiv = el('div');
        sevDiv.appendChild(lbl('最低严重度'));
        const sevSel = el('select', { id: `tr_${key}_${brand}_severity`, className: 'border border-blue-200 rounded-lg px-2 py-1.5 text-sm w-full' });
        SEVERITY_OPTS.forEach(sv => sevSel.appendChild(el('option', { value: sv, selected: (brandCfg.minSeverity || entry.minSeverity || 'medium') === sv }, sv + (sv === 'low' ? '(低也触发)' : sv === 'medium' ? '(中及以上)' : '(仅高)'))));
        sevDiv.appendChild(sevSel);
        g.appendChild(sevDiv);
        bDiv.appendChild(g);
        cardEl.appendChild(bDiv);
      });
    } else {
      // Simple mode (shared config for all brands)
      const grid = el('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-3' });
      grid.appendChild(field('培训课程名', el('input', { type: 'text', value: String(entry.course || ''), id: `tr_${key}_course`, className: 'border border-blue-200 rounded-lg px-3 py-2 text-sm w-full', placeholder: '如: 服务流程SOP' })));
      grid.appendChild(field('培训内容', el('input', { type: 'text', value: String(entry.content || ''), id: `tr_${key}_content`, className: 'border border-blue-200 rounded-lg px-3 py-2 text-sm w-full', placeholder: '如: 迎宾→入座→点餐→上菜→结账全流程' })));
      grid.appendChild(field('考核标准', el('input', { type: 'text', value: String(entry.examPass || ''), id: `tr_${key}_exam`, className: 'border border-blue-200 rounded-lg px-3 py-2 text-sm w-full', placeholder: '如: 考试≥90分 / 出品合格率≥95%' })));
      // Target audience
      const audDiv = el('div');
      audDiv.appendChild(lbl('培训对象（勾选）'));
      const audWrap = el('div', { className: 'flex flex-wrap gap-1' });
      const selAud = (entry.targetAudience || []).reduce((m, a) => { m[a] = true; return m; }, {});
      audienceOptions.forEach(ao => {
        const cb = el('input', { type: 'checkbox', id: `tr_${key}_aud_${ao}`, checked: !!selAud[ao], className: 'mr-1' });
        const lab = el('label', { className: 'text-xs text-gray-700 cursor-pointer mr-2' });
        lab.appendChild(cb); lab.appendChild(document.createTextNode(' ' + ao));
        audWrap.appendChild(lab);
      });
      audDiv.appendChild(audWrap);
      grid.appendChild(audDiv);
      grid.appendChild(field('冷却天数', el('input', { type: 'number', value: String(entry.cooldownDays ?? 14), id: `tr_${key}_cooldown`, className: 'border border-blue-200 rounded-lg px-3 py-2 text-sm w-full', min: '1', max: '90' })));
      const sevDiv = el('div');
      sevDiv.appendChild(lbl('最低严重度'));
      const sevSel = el('select', { id: `tr_${key}_severity`, className: 'border border-blue-200 rounded-lg px-3 py-2 text-sm w-full' });
      SEVERITY_OPTS.forEach(sv => sevSel.appendChild(el('option', { value: sv, selected: (entry.minSeverity || 'medium') === sv }, sv + (sv === 'low' ? '(低也触发)' : sv === 'medium' ? '(中及以上)' : '(仅高)'))));
      sevDiv.appendChild(sevSel);
      grid.appendChild(sevDiv);
      cardEl.appendChild(grid);
    }
    wrap.appendChild(cardEl);
  });

  // Custom mapping
  const customCard = el('div', { className: 'bg-gray-50 rounded-xl p-4 mb-3 border border-dashed border-gray-300' });
  customCard.appendChild(el('h4', { className: 'text-sm font-semibold text-gray-700 mb-2' }, '+ 自定义异常→培训映射'));
  const customGrid = el('div', { className: 'grid grid-cols-2 md:grid-cols-4 gap-3' });
  customGrid.appendChild(field('异常Key', el('input', { type: 'text', id: 'tr_custom_key', className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm w-full', placeholder: '如: custom_issue' })));
  customGrid.appendChild(field('培训课程名', el('input', { type: 'text', id: 'tr_custom_course', className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm w-full', placeholder: '课程名' })));
  customGrid.appendChild(field('培训内容', el('input', { type: 'text', id: 'tr_custom_content', className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm w-full', placeholder: '培训内容' })));
  customGrid.appendChild(field('考核标准', el('input', { type: 'text', id: 'tr_custom_exam', className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm w-full', placeholder: '考核标准' })));
  customCard.appendChild(customGrid);
  wrap.appendChild(customCard);

  wrap.appendChild(el('div', { className: 'flex justify-end mt-4' }, [
    btn('💾 保存培训联动配置', async () => {
      const newMap = {};
      allKeys.forEach(key => {
        const existing = trainingMap[key] || {};
        const hasBrands = existing.brands && Array.isArray(existing.brands);
        if (hasBrands) {
          // Save brand-differentiated config
          const brandConfigs = [];
          brands.forEach(brand => {
            const course = $(`tr_${key}_${brand}_course`)?.value?.trim();
            if (!course) return;
            const aud = [];
            audienceOptions.forEach(ao => { if ($(`tr_${key}_${brand}_aud_${ao}`)?.checked) aud.push(ao); });
            brandConfigs.push({
              brand,
              course,
              content: $(`tr_${key}_${brand}_content`)?.value?.trim() || '',
              examPass: $(`tr_${key}_${brand}_exam`)?.value?.trim() || '',
              targetAudience: aud,
              cooldownDays: Number($(`tr_${key}_${brand}_cooldown`)?.value) || 14,
              minSeverity: $(`tr_${key}_${brand}_severity`)?.value || 'medium',
            });
          });
          if (brandConfigs.length) {
            newMap[key] = { brands: brandConfigs, cooldownDays: Number($(`tr_${key}_${brands[0]}_cooldown`)?.value) || 14, minSeverity: $(`tr_${key}_${brands[0]}_severity`)?.value || 'medium' };
          }
        } else {
          // Save simple config
          const course = $(`tr_${key}_course`)?.value?.trim();
          if (!course) return;
          const aud = [];
          audienceOptions.forEach(ao => { if ($(`tr_${key}_aud_${ao}`)?.checked) aud.push(ao); });
          newMap[key] = {
            course,
            content: $(`tr_${key}_content`)?.value?.trim() || '',
            examPass: $(`tr_${key}_exam`)?.value?.trim() || '',
            targetAudience: aud,
            cooldownDays: Number($(`tr_${key}_cooldown`)?.value) || existing.cooldownDays || 14,
            minSeverity: $(`tr_${key}_severity`)?.value || existing.minSeverity || 'medium',
          };
        }
      });
      const customKey = $('tr_custom_key')?.value?.trim();
      if (customKey) {
        const aud = [];
        audienceOptions.forEach(ao => { if ($(`tr_${customKey}_aud_${ao}`)?.checked) aud.push(ao); });
        newMap[customKey] = {
          course: $('tr_custom_course')?.value?.trim() || '',
          content: $('tr_custom_content')?.value?.trim() || '',
          examPass: $('tr_custom_exam')?.value?.trim() || '',
          targetAudience: aud,
          cooldownDays: 14, minSeverity: 'medium',
        };
      }
      await POST('/api/chairman/config', { training_map: newMap });
      msg('培训联动配置已保存');
      go('chairman');
    }, 'bg-blue-600 text-white text-sm px-6 py-3 rounded-lg hover:bg-blue-700 font-semibold shadow-sm')
  ]));

  return wrap;
}

// ── Trend Thresholds ──
function chairmanTrendTab(cfg) {
  const tr = cfg.trend_rules || {};
  const storeOverrides = tr.storeOverrides || {};
  const stores = Object.keys(cfg.stores || {});
  const wrap = el('div');

  wrap.appendChild(el('p', { className: 'text-sm text-gray-600 mb-4 bg-purple-50 p-3 rounded-lg' },
    '📈 趋势检测规则阈值配置。全局阈值对所有门店生效，门店覆盖优先于全局。不同品牌/门店的阈值可以不同。'
  ));

  const cards = [];

  // Global thresholds
  { const g = el('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-4' });
    g.appendChild(el('div', { className: 'bg-purple-50 rounded-lg p-3' }, [
      el('div', { className: 'text-sm font-medium text-purple-900 mb-1' }, '连续下降周数阈值'),
      el('div', { className: 'text-xs text-gray-500 mb-2' }, '同一weekday连续N周下降触发异常'),
      field('中等级(medium)', el('input', { type: 'number', value: String(tr.weekday_trend_consecutive_weeks ?? 3), id: 'tr_wd_weeks', className: 'border border-purple-200 bg-white rounded-lg px-3 py-2 text-sm w-24', min: '2', max: '8' })),
    ]));
    g.appendChild(el('div', { className: 'text-xs text-gray-500 p-3' }, '说明：3表示连续3周同一weekday营收/客流下降触发medium，4周则升级为high。数字越大越不敏感。'));
    cards.push(card('📅 同日环比趋势（规则12）— 全局阈值', g));
  }

  { const g = el('div', { className: 'grid grid-cols-1 md:grid-cols-3 gap-4' });
    g.appendChild(field('medium阈值(午市占比)', el('input', { type: 'number', step: '0.01', value: String(tr.meal_balance_threshold_medium ?? 0.30), id: 'tr_mb_med', className: 'border border-purple-200 bg-white rounded-lg px-3 py-2 text-sm w-full', placeholder: '0.30' })));
    g.appendChild(field('high阈值(午市占比)', el('input', { type: 'number', step: '0.01', value: String(tr.meal_balance_threshold_high ?? 0.25), id: 'tr_mb_high', className: 'border border-purple-200 bg-white rounded-lg px-3 py-2 text-sm w-full', placeholder: '0.25' })));
    g.appendChild(field('观察窗口(天)', el('input', { type: 'number', value: String(tr.meal_balance_window_days ?? 5), id: 'tr_mb_days', className: 'border border-purple-200 bg-white rounded-lg px-3 py-2 text-sm w-full', min: '3', max: '14' })));
    g.appendChild(el('div', { className: 'col-span-3 text-xs text-gray-500' }, '说明：近N天午市营收占比低于阈值时触发。0.30=30%。数字越低越容易触发。'));
    cards.push(card('🍽️ 午晚市占比失衡（规则13）— 全局阈值', g));
  }

  { const g = el('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-4' });
    g.appendChild(field('跌幅阈值(比率)', el('input', { type: 'number', step: '0.01', value: String(tr.dish_decline_drop_pct ?? 0.20), id: 'tr_dd_drop', className: 'border border-purple-200 bg-white rounded-lg px-3 py-2 text-sm w-full', placeholder: '0.20' })));
    g.appendChild(field('连续下降周数', el('input', { type: 'number', value: String(tr.dish_decline_consecutive_weeks ?? 2), id: 'tr_dd_weeks', className: 'border border-purple-200 bg-white rounded-lg px-3 py-2 text-sm w-full', min: '1', max: '4' })));
    g.appendChild(el('div', { className: 'col-span-2 text-xs text-gray-500' }, '说明：菜品周销量跌幅超过此比率且连续N周下降时触发。0.20=跌幅20%。'));
    cards.push(card('📉 菜品衰退（规则14）— 全局阈值', g));
  }

  cards.forEach(c => wrap.appendChild(c));

  // Per-store overrides
  wrap.appendChild(el('div', { className: 'flex justify-between items-center mb-3 mt-4' }, [
    el('h3', { className: 'text-base font-bold text-gray-900' }, '🏪 门店级阈值覆盖（优先于全局）'),
    el('span', { className: 'text-xs text-gray-500' }, '留空则使用全局默认值')
  ]));

  stores.forEach((sn, si) => {
    const so = storeOverrides[sn] || {};
    const brand = cfg.stores?.[sn]?.brand || '';
    const storeCard = el('div', { className: 'bg-white rounded-xl shadow-sm border p-4 mb-3' });
    storeCard.appendChild(el('div', { className: 'font-semibold text-sm text-gray-900 mb-3' }, `${brand ? brand + ' · ' : ''}${sn}`));
    const g = el('div', { className: 'grid grid-cols-2 md:grid-cols-3 gap-3' });
    g.appendChild(field('连续下降周数', el('input', { type: 'number', value: String(so.weekday_trend_consecutive_weeks ?? ''), id: `trso_${si}_wd_weeks`, className: 'border border-purple-200 rounded-lg px-3 py-2 text-sm w-full', placeholder: '全局默认', min: '2', max: '8' })));
    g.appendChild(field('午市占比medium', el('input', { type: 'number', step: '0.01', value: String(so.meal_balance_threshold_medium ?? ''), id: `trso_${si}_mb_med`, className: 'border border-purple-200 rounded-lg px-3 py-2 text-sm w-full', placeholder: '全局默认' })));
    g.appendChild(field('午市占比high', el('input', { type: 'number', step: '0.01', value: String(so.meal_balance_threshold_high ?? ''), id: `trso_${si}_mb_high`, className: 'border border-purple-200 rounded-lg px-3 py-2 text-sm w-full', placeholder: '全局默认' })));
    g.appendChild(field('午市观察天数', el('input', { type: 'number', value: String(so.meal_balance_window_days ?? ''), id: `trso_${si}_mb_days`, className: 'border border-purple-200 rounded-lg px-3 py-2 text-sm w-full', placeholder: '全局默认', min: '3', max: '14' })));
    g.appendChild(field('菜品跌幅阈值', el('input', { type: 'number', step: '0.01', value: String(so.dish_decline_drop_pct ?? ''), id: `trso_${si}_dd_drop`, className: 'border border-purple-200 rounded-lg px-3 py-2 text-sm w-full', placeholder: '全局默认' })));
    g.appendChild(field('菜品连续下降周数', el('input', { type: 'number', value: String(so.dish_decline_consecutive_weeks ?? ''), id: `trso_${si}_dd_weeks`, className: 'border border-purple-200 rounded-lg px-3 py-2 text-sm w-full', placeholder: '全局默认', min: '1', max: '4' })));
    storeCard.appendChild(g);
    wrap.appendChild(storeCard);
  });

  wrap.appendChild(el('div', { className: 'flex justify-end mt-4' }, [
    btn('💾 保存趋势阈值配置', async () => {
      const trend_rules = {
        weekday_trend_consecutive_weeks: Number($('tr_wd_weeks')?.value) || 3,
        meal_balance_threshold_medium: Number($('tr_mb_med')?.value) || 0.30,
        meal_balance_threshold_high: Number($('tr_mb_high')?.value) || 0.25,
        meal_balance_window_days: Number($('tr_mb_days')?.value) || 5,
        dish_decline_drop_pct: Number($('tr_dd_drop')?.value) || 0.20,
        dish_decline_consecutive_weeks: Number($('tr_dd_weeks')?.value) || 2,
        storeOverrides: {},
      };
      stores.forEach((sn, si) => {
        const override = {};
        const wd = $('trso_' + si + '_wd_weeks')?.value;
        if (wd) override.weekday_trend_consecutive_weeks = Number(wd);
        const mbm = $('trso_' + si + '_mb_med')?.value;
        if (mbm) override.meal_balance_threshold_medium = Number(mbm);
        const mbh = $('trso_' + si + '_mb_high')?.value;
        if (mbh) override.meal_balance_threshold_high = Number(mbh);
        const mbd = $('trso_' + si + '_mb_days')?.value;
        if (mbd) override.meal_balance_window_days = Number(mbd);
        const ddd = $('trso_' + si + '_dd_drop')?.value;
        if (ddd) override.dish_decline_drop_pct = Number(ddd);
        const ddw = $('trso_' + si + '_dd_weeks')?.value;
        if (ddw) override.dish_decline_consecutive_weeks = Number(ddw);
        if (Object.keys(override).length) trend_rules.storeOverrides[sn] = override;
      });
      await POST('/api/chairman/config', { trend_rules });
      msg('趋势阈值配置已保存');
      go('chairman');
    }, 'bg-purple-600 text-white text-sm px-6 py-3 rounded-lg hover:bg-purple-700 font-semibold shadow-sm')
  ]));

  return wrap;
}

// ═══════════════════════════════════════════════════════
function viewAudit() {
  const w = el('div');
  w.appendChild(el('div', { className: 'flex justify-between items-center mb-4' }, [
    el('h2', { className: 'text-lg font-bold text-gray-900' }, '操作审计日志'),
    el('span', { className: 'text-xs bg-gray-100 text-gray-600 px-3 py-1 rounded-full font-medium' }, S.auditItems.length + ' 条记录')
  ]));
  if (!S.auditItems.length) { w.appendChild(card('暂无审计记录', el('p', { className: 'text-sm text-gray-500' }, '系统配置变更后会自动记录审计日志。'))); return w; }
  const tbl = el('table', { className: 'w-full text-sm bg-white rounded-xl shadow-sm border' });
  const th = el('tr'); ['时间', '配置项', '操作', '操作人', '详情'].forEach(x => th.appendChild(el('th', { className: 'text-left p-3 border-b-2 text-gray-600 text-xs font-medium' }, x)));
  tbl.appendChild(th);
  S.auditItems.forEach(a => {
    const tr = el('tr', { className: 'hover:bg-gray-50' });
    const ts = a.changed_at ? new Date(a.changed_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
    tr.appendChild(el('td', { className: 'p-3 border-b text-xs text-gray-500 whitespace-nowrap' }, ts));
    tr.appendChild(el('td', { className: 'p-3 border-b' }, el('code', { className: 'text-xs bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded font-mono' }, a.config_key || '')));
    const actionCls = a.action === 'delete' ? 'bg-red-100 text-red-700' : a.action === 'create' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700';
    tr.appendChild(el('td', { className: 'p-3 border-b' }, el('span', { className: 'text-xs px-2 py-0.5 rounded ' + actionCls }, a.action || 'update')));
    tr.appendChild(el('td', { className: 'p-3 border-b text-xs' }, a.changed_by || 'system'));
    const detBtn = btnGhost('查看', () => {
      const val = a.new_value || a.old_value || '(无详情)';
      const valStr = typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val);
      const modal = el('div', { className: 'fixed inset-0 bg-black/50 flex items-center justify-center z-50' });
      const box = el('div', { className: 'bg-white rounded-2xl shadow-2xl p-6 w-full max-w-lg max-h-[60vh] overflow-auto' });
      box.appendChild(el('div', { className: 'flex justify-between items-center mb-3' }, [
        el('h3', { className: 'font-bold text-sm' }, (a.config_key || '') + ' — ' + (a.action || 'update')),
        btn('关闭', () => modal.remove(), 'text-sm text-gray-500 hover:text-red-500 bg-transparent')
      ]));
      box.appendChild(el('pre', { className: 'text-xs bg-gray-50 rounded-lg p-3 overflow-auto max-h-[40vh] font-mono' }, valStr.slice(0, 2000)));
      modal.appendChild(box); document.body.appendChild(modal);
    });
    tr.appendChild(el('td', { className: 'p-3 border-b' }, detBtn));
    tbl.appendChild(tr);
  });
  w.appendChild(tbl);
  return w;
}

// ═══════════════════════════════════════════════════════
// DATA SOURCES (飞书多维表格轮询)
// ═══════════════════════════════════════════════════════
function viewDataSources() {
  const w = el('div');
  const bs = S.bitableStatus || {};
  w.appendChild(el('div', { className: 'flex justify-between items-center mb-6' }, [
    el('h2', { className: 'text-lg font-bold text-gray-900' }, '📡 数据源管理 (飞书多维表格)'),
    el('div', { className: 'flex items-center gap-2' }, [
      el('span', { className: 'text-xs px-2 py-1 rounded-full font-medium ' + (bs.polling ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700') }, bs.polling ? '🟢 轮询中' : '🔴 已停止'),
      btn('🔄 立即轮询', async () => { await POST('/api/bitable-poll', {}); msg('轮询已触发'); setTimeout(() => go('datasources'), 3000); }, 'bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700 font-medium'),
      btn('刷新', () => go('datasources'), 'bg-gray-100 text-gray-700 text-sm px-3 py-2 rounded-lg hover:bg-gray-200 font-medium')
    ])
  ]));

  // Summary stats
  const sumRow = el('div', { className: 'grid grid-cols-2 md:grid-cols-4 gap-4 mb-6' });
  sumRow.appendChild(stat((bs.configs || []).length, '数据源数量', 'text-indigo-600'));
  sumRow.appendChild(stat((bs.configs || []).filter(c => c.hasCredentials).length, '已配置凭证', 'text-green-600'));
  sumRow.appendChild(stat(bs.processedCount || 0, '已处理记录(内存)', 'text-blue-600'));
  sumRow.appendChild(stat(bs.recentRecords24h || 0, '24h新增记录', 'text-purple-600'));
  w.appendChild(sumRow);

  // Config table
  const configs = bs.configs || [];
  if (configs.length > 0) {
    w.appendChild(card('数据源配置', (() => {
      const tbl = el('table', { className: 'w-full text-sm' });
      const thead = el('thead'); const hr = el('tr', { className: 'bg-gray-50' });
      ['名称', '类型', 'Table ID', '凭证状态', '配置键'].forEach(h => hr.appendChild(el('th', { className: 'p-3 text-left text-xs font-semibold text-gray-600' }, h)));
      thead.appendChild(hr); tbl.appendChild(thead);
      const tbody = el('tbody');
      configs.forEach(c => {
        const tr = el('tr', { className: 'border-b border-gray-100 hover:bg-gray-50' });
        tr.appendChild(el('td', { className: 'p-3 text-sm font-medium text-gray-900' }, c.name || '-'));
        tr.appendChild(el('td', { className: 'p-3' }, el('span', { className: 'text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full' }, c.type || '-')));
        tr.appendChild(el('td', { className: 'p-3 text-xs font-mono text-gray-500' }, c.tableId || '-'));
        const credBadge = c.hasCredentials
          ? el('span', { className: 'text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium' }, '✅ 已配置')
          : el('span', { className: 'text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium' }, '❌ 缺失');
        tr.appendChild(el('td', { className: 'p-3' }, credBadge));
        tr.appendChild(el('td', { className: 'p-3 text-xs font-mono text-gray-400' }, c.key || '-'));
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      return tbl;
    })()));
  }

  w.appendChild(card('说明', el('div', { className: 'text-sm text-gray-600 space-y-2' }, [
    el('p', {}, '• 系统每2分钟自动轮询飞书多维表格,获取最新数据(运营检查/桌访/差评/收档/开档/例会/原料收货/报损)'),
    el('p', {}, '• 数据同步到 feishu_generic_records 表和 agent_messages 表（含实际毛利率表 actual_gross_margin）,供Agent查询使用'),
    el('p', {}, '• 如需修改轮询凭证,请在服务器 /opt/agents-service-v2/.env 中更新对应的 BITABLE_* 环境变量'),
    el('p', {}, '• 可通过功能开关页面的 bitable_polling 标志启停轮询')
  ])));

  return w;
}

// ═══════════════════════════════════════════════════════
// DATA LOADER
// ═══════════════════════════════════════════════════════
async function load(t) {
  try {
    if (t === 'dashboard') { [S.hl, S.st, S.fs] = await Promise.all([G('/health').catch(e => { catchNonAuth(e); return {}; }), G('/api/system-stats').catch(e => { catchNonAuth(e); return { tasks: [], messages24h: 0, anomaliesToday: 0 }; }), G('/api/feishu/status').catch(e => { catchNonAuth(e); return {}; })]); }
    if (t === 'agents') { S.agents = (await G('/api/agent-config').catch(e => { catchNonAuth(e); return { agents: {} }; })).agents || {}; }
    if (t === 'scheduled') {
      const [di, ri, rhy, sb] = await Promise.all([G('/api/config/daily_inspections').catch(catchNonAuth), G('/api/config/random_inspections').catch(catchNonAuth), G('/api/config/rhythm_schedule').catch(catchNonAuth), G('/api/stores-brands').catch(catchNonAuth)]);
      let rhyMerged = {};
      const raw = rhy?.config_value;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) rhyMerged = raw;
      else if (typeof raw === 'string') {
        try { rhyMerged = JSON.parse(raw); } catch (_e) { rhyMerged = {}; }
      }
      // 旧格式迁移：如果 DB 里的 rhythm_schedule 是 {patrol_wave1: ..., end_of_day: ...}（旧节奏引擎格式）而非 {rhythmItems: [...]}
      // 则在前端自动使用 DEFAULT_RHYTHM_ITEMS（加载时透明兼容，保存时写新格式）
      const hasRhythmItems = Array.isArray(rhyMerged.rhythmItems) && rhyMerged.rhythmItems.length > 0;
      S.schedCfg = {
        dailyInspections: Array.isArray(di?.config_value) ? di.config_value : [],
        randomInspections: Array.isArray(ri?.config_value) ? ri.config_value : [],
        rhythmItems: hasRhythmItems ? rhyMerged.rhythmItems : null, // null → viewScheduled 用 DEFAULT_RHYTHM_ITEMS
        ...rhyMerged
      };
      S.storesList = sb?.stores || []; S.brandsList = sb?.brands || [];
      S._storesRetried = false;
    }
    if (t === 'anomaly') { const r = await G('/api/config/anomaly_thresholds').catch(catchNonAuth); S.anomalyCfg = r?.config_value || {}; }
    if (t === 'performance') {
      const [perf, scores] = await Promise.all([G('/api/config/performance_eval').catch(catchNonAuth), G('/api/scoring-rules').catch(e => { catchNonAuth(e); return { rules: {} }; })]);
      S.perfCfg = perf?.config_value || {}; S.scores = scores.rules || {};
    }
    if (t === 'marketing') { [S.campaigns, S.templates] = await Promise.all([(G('/api/campaigns').catch(e => { catchNonAuth(e); return { campaigns: [] }; })).then(r => r.campaigns || []), (G('/api/templates').catch(e => { catchNonAuth(e); return { templates: [] }; })).then(r => r.templates || [])]); }
    if (t === 'evaluation') { S.evalReport = await G('/api/agent-evaluation').catch(e => { catchNonAuth(e); return {}; }); }
    if (t === 'knowledge') { S.kbItems = (await G('/api/knowledge-base').catch(e => { catchNonAuth(e); return { items: [] }; })).items || []; }
    if (t === 'memory') {
      const [memRes, ksRes] = await Promise.all([
        G('/api/agent-memory/' + S.selectedAgent).catch(e => { catchNonAuth(e); return { memories: [] }; }),
        G('/api/admin/knowledge-sources').catch((e) => {
          if (e?.message === 'auth') return { _err: 'auth' };
          return { _err: e?.message || String(e) };
        })
      ]);
      S.memoryItems = memRes.memories || [];
      if (ksRes && ksRes._err) {
        S.knowledgeSources = null;
        S.knowledgeSourcesErr =
          ksRes._err === 'auth'
            ? '未登录或 token 失效'
            : ksRes._err === 'Forbidden' || String(ksRes._err).includes('403')
              ? '当前账号无权限（需 admin / hq_manager）'
              : String(ksRes._err);
      } else if (ksRes && ksRes.error) {
        S.knowledgeSources = null;
        S.knowledgeSourcesErr = String(ksRes.error);
      } else {
        S.knowledgeSources = ksRes;
        S.knowledgeSourcesErr = '';
      }
    }
    if (t === 'flags') { S.featureFlags = (await G('/api/feature-flags').catch(e => { catchNonAuth(e); return { flags: {} }; })).flags || {}; }
    if (t === 'configs') { S.cfgs = (await G('/api/config').catch(e => { catchNonAuth(e); return { configs: [] }; })).configs || []; }
    if (t === 'audit') { S.auditItems = (await G('/api/audit-log?limit=50').catch(e => { catchNonAuth(e); return { log: [] }; })).log || []; }
    if (t === 'activity') { S.activity = await G('/api/agent-activity?date=' + S.activityDate).catch(e => { catchNonAuth(e); return {}; }); }
    if (t === 'datasources') { S.bitableStatus = await G('/api/bitable-status').catch(e => { catchNonAuth(e); return {}; }); }
    if (t === 'chairman') { S.chairmanCfg = (await G('/api/chairman/config').catch(e => { catchNonAuth(e); return { ok: true, config: {} }; })).config || {}; }
  } catch (e) { if (e.message === 'auth') { localStorage.removeItem('aat'); renderLogin(); return 'auth'; } }
}

// ═══════════════════════════════════════════════════════
// TABS & ROUTER（单行扁平导航，与数据中心改版解耦）
// ═══════════════════════════════════════════════════════
const TABS = [
  ['dashboard', '📊 仪表盘'],
  ['activity', '📋 Agent活动'],
  ['datasources', '📡 数据源'],
  ['agents', '🤖 Agent配置'],
  ['scheduled', '⏰ 定时任务'],
  ['anomaly', '🚨 异常阈值'],
  ['performance', '📋 绩效考核'],
  ['marketing', '📢 营销管理'],
  ['evaluation', '🔍 Agent评估'],
  ['knowledge', '📚 知识库'],
  ['memory', '🧠 记忆'],
  ['flags', '🚩 开关'],
  ['configs', '⚙️ 配置'],
  ['chairman', '👔 董事长配置'],
  ['audit', '📝 审计']
];
const VW = { dashboard: viewDash, activity: viewActivity, datasources: viewDataSources, agents: viewAgents, scheduled: viewScheduled, anomaly: viewAnomaly, performance: viewPerformance, marketing: viewMarketing, evaluation: viewEval, knowledge: viewKnowledge, memory: viewMemory, flags: viewFlags, configs: viewCfgs, chairman: viewChairman, audit: viewAudit };

function render() {
  const a = $('app');
  if (!localStorage.getItem('aat')) { renderLogin(); return; }
  syncAauFromJwt();
  a.innerHTML = '';

  // Header
  const hd = el('header', { className: 'bg-white shadow-sm border-b border-gray-200' });
  const hi = el('div', { className: 'max-w-7xl mx-auto px-6 py-4 flex justify-between items-center' });
  hi.appendChild(el('div', { className: 'flex items-center gap-3' }, [
    el('span', { className: 'text-2xl' }, '🤖'),
    el('div', {}, [el('h1', { className: 'font-bold text-lg text-gray-900 leading-tight' }, 'Agent Ops Admin'), el('p', { className: 'text-xs text-gray-500' }, 'Agents Service V2 管理面板')])
  ]));
  hi.appendChild(btn('退出登录', () => { localStorage.removeItem('aat'); localStorage.removeItem('aau'); renderLogin(); }, 'text-sm text-gray-500 hover:text-red-500 bg-transparent'));
  hd.appendChild(hi); a.appendChild(hd);

  const nv = el('nav', { className: 'bg-white border-b border-gray-200 sticky top-0 z-30 shadow-sm' });
  const nvInner = el('div', { className: 'max-w-7xl mx-auto px-4 py-2 flex flex-wrap gap-1' });
  TABS.forEach(([k, l]) => {
    const on = tab === k;
    const cls =
      'px-3 py-1.5 text-xs sm:text-sm cursor-pointer whitespace-nowrap rounded-lg font-medium transition-colors ' +
      (on ? 'bg-indigo-600 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900');
    nvInner.appendChild(el('div', { className: cls, onclick: () => go(k) }, l));
  });
  nv.appendChild(nvInner);
  a.appendChild(nv);

  // Content
  const ct = el('div', { className: 'max-w-7xl mx-auto px-6 py-6' });
  const fn = VW[tab] || viewDash;
  ct.appendChild(fn()); a.appendChild(ct);

  // Footer
  a.appendChild(el('footer', { className: 'max-w-7xl mx-auto px-6 py-4 text-xs text-gray-400 text-center border-t border-gray-100 mt-8' }, '© 2026 Agent Ops Admin — ' + Object.keys(AN).length + ' Agents | Phase 7'));
}

async function go(t) { tab = t; const r = await load(t); if (r === 'auth') return; render(); }

// ── Init ──
if (localStorage.getItem('aat')) go('dashboard'); else renderLogin();
