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
  if (r.status === 401) throw new Error('auth');
  return r.json();
}
const G = p => api('GET', p), PUT = (p, b) => api('PUT', p, b), POST = (p, b) => api('POST', p, b), DEL = p => api('DELETE', p);
function catchNonAuth(e) { if (e?.message === 'auth') throw e; return null; }

// ── State ──
const AN = { master: 'Master调度中枢', data_auditor: '数据审计', ops_supervisor: '运营督导', chief_evaluator: '绩效考核', train_advisor: '培训顾问', appeal: '申诉处理', marketing_planner: '营销策划', marketing_executor: '营销执行', procurement_advisor: '采购建议' };
let tab = 'dashboard';
let S = { hl: {}, st: {}, fs: {}, agents: {}, rules: [], scores: {}, campaigns: [], templates: [], evalReport: {}, auditItems: [], cfgs: [], schedCfg: {}, anomalyCfg: {}, perfCfg: {}, ratingCfg: {}, kpiTargets: [], kbItems: [], memoryItems: [], featureFlags: {}, selectedAgent: 'data_auditor', activity: {}, activityDate: new Date().toISOString().slice(0,10), drillData: [], bitableStatus: {} };

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
    if (d.ok && d.token) { localStorage.setItem('aat', d.token); go('dashboard'); }
    else { if (errEl) { errEl.textContent = d.error || '登录失败'; errEl.classList.remove('hidden'); } }
  } catch (e) { if (errEl) { errEl.textContent = '网络错误'; errEl.classList.remove('hidden'); } }
}
function doTokenLogin() { const t = $('ti')?.value?.trim(); if (t) { localStorage.setItem('aat', t); go('dashboard'); } }

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
  try {
    const data = await G('/api/dashboard-detail/' + type).catch(() => ({ items: [] }));
    const items = data.items || [];
    const content = el('div');
    if (!items.length) { content.appendChild(el('p', { className: 'text-gray-500 text-sm py-8 text-center' }, '暂无数据')); showModal('详情 — ' + type, content); return; }
    const tbl = el('table', { className: 'w-full text-sm' });
    const thead = el('thead'); const hr = el('tr', { className: 'bg-gray-50' });
    if (type === 'anomalies') { ['门店','异常类型','严重度','描述','日期','状态'].forEach(h => hr.appendChild(el('th', { className: 'p-2 text-left text-xs font-semibold text-gray-600' }, h))); }
    else if (type === 'tasks') { ['任务ID','标题','门店','严重度','状态','处理Agent','已开(h)','创建时间'].forEach(h => hr.appendChild(el('th', { className: 'p-2 text-left text-xs font-semibold text-gray-600' }, h))); }
    else if (type === 'messages') { ['Agent','门店','用户','延迟ms','证据','时间'].forEach(h => hr.appendChild(el('th', { className: 'p-2 text-left text-xs font-semibold text-gray-600' }, h))); }
    else if (type === 'rhythm') { ['类型','状态','执行日期','耗时','详情'].forEach(h => hr.appendChild(el('th', { className: 'p-2 text-left text-xs font-semibold text-gray-600' }, h))); }
    thead.appendChild(hr); tbl.appendChild(thead);
    const tbody = el('tbody');
    items.forEach(it => {
      const tr = el('tr', { className: 'hover:bg-gray-50 border-b border-gray-100' });
      if (type === 'anomalies') {
        tr.appendChild(el('td', { className: 'p-2 text-xs font-medium' }, it.store || '-'));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, it.anomaly_key || it.category || '-'));
        const sevBadge = el('span', { className: 'text-xs px-2 py-0.5 rounded-full font-medium ' + (SEV_CLS[it.severity] || 'bg-gray-100') }, it.severity || '-');
        tr.appendChild(el('td', { className: 'p-2' }, sevBadge));
        tr.appendChild(el('td', { className: 'p-2 text-xs max-w-xs truncate' }, (it.description || '-').slice(0,60)));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, fmtDate(it.trigger_date)));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, it.status || '-'));
      } else if (type === 'tasks') {
        tr.appendChild(el('td', { className: 'p-2 text-xs font-mono' }, (it.task_id||'').slice(0,8)));
        tr.appendChild(el('td', { className: 'p-2 text-xs font-medium max-w-xs truncate' }, it.title || '-'));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, it.store || '-'));
        const sevBadge = el('span', { className: 'text-xs px-2 py-0.5 rounded-full font-medium ' + (SEV_CLS[it.severity] || 'bg-gray-100') }, it.severity || '-');
        tr.appendChild(el('td', { className: 'p-2' }, sevBadge));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, it.status || '-'));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, it.agent || '-'));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, it.hours_open ? parseFloat(it.hours_open).toFixed(1) : '-'));
        tr.appendChild(el('td', { className: 'p-2 text-xs' }, fmtDate(it.created_at)));
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
    content.appendChild(el('p', { className: 'text-xs text-gray-400 mt-3 text-right' }, '共 ' + items.length + ' 条记录'));
    showModal({ anomalies:'异常详情(近7天)', tasks:'未闭环任务', messages:'24h消息详情', rhythm:'节奏执行日志' }[type] || type, content);
  } catch (e) { msg('加载失败: ' + e?.message, true); }
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

  // Header with date picker
  const hdr = el('div', { className: 'flex flex-wrap justify-between items-center mb-6 gap-3' });
  hdr.appendChild(el('h2', { className: 'text-lg font-bold text-gray-900' }, '📋 Agent 每日活动视图'));
  const dateRow = el('div', { className: 'flex items-center gap-2' });
  const dtInp = el('input', { id: 'actDate', type: 'date', className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-200 outline-none', value: S.activityDate });
  dateRow.appendChild(dtInp);
  dateRow.appendChild(btn('查询', async () => { S.activityDate = $('actDate').value; await load('activity'); render(); }, 'bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700 font-medium'));
  dateRow.appendChild(btn('今天', async () => { S.activityDate = new Date().toISOString().slice(0,10); await load('activity'); render(); }, 'bg-gray-100 text-gray-700 text-sm px-3 py-2 rounded-lg hover:bg-gray-200 font-medium'));
  hdr.appendChild(dateRow);
  w.appendChild(hdr);

  // Summary stats
  const sumRow = el('div', { className: 'grid grid-cols-2 md:grid-cols-4 gap-4 mb-6' });
  sumRow.appendChild(stat(A.totalInteractions || 0, '总交互次数', 'text-blue-600'));
  sumRow.appendChild(stat(A.totalAnomalies || 0, '异常触发', (A.totalAnomalies || 0) > 0 ? 'text-red-600' : 'text-green-600'));
  sumRow.appendChild(stat(A.totalRhythm || 0, '节奏执行', 'text-purple-600'));
  sumRow.appendChild(stat(Object.keys(A.summary || {}).length, '活跃Agent数', 'text-indigo-600'));
  w.appendChild(sumRow);

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
    ['门店','异常类型','严重度','描述','状态','时间'].forEach(h => atr.appendChild(el('th', { className: 'p-2 text-left text-xs font-semibold text-gray-600' }, h)));
    ath.appendChild(atr); anomTbl.appendChild(ath);
    const atb = el('tbody');
    anomalies.forEach(a => {
      const tr = el('tr', { className: 'border-b border-gray-100 hover:bg-gray-50' });
      tr.appendChild(el('td', { className: 'p-2 text-xs font-medium' }, a.store || '-'));
      tr.appendChild(el('td', { className: 'p-2 text-xs' }, a.anomaly_key || '-'));
      tr.appendChild(el('td', { className: 'p-2' }, el('span', { className: 'text-xs px-2 py-0.5 rounded-full font-medium ' + (SEV_CLS[a.severity] || 'bg-gray-100') }, a.severity || '-')));
      tr.appendChild(el('td', { className: 'p-2 text-xs max-w-xs truncate' }, (a.description || '-').slice(0, 50)));
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
  if (tasks.length > 0) {
    const taskCard = el('div', { className: 'bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-4' });
    taskCard.appendChild(el('h3', { className: 'text-base font-semibold text-gray-800 mb-4 pb-2 border-b border-gray-100' }, '📝 任务状态 (' + tasks.length + ' 条)'));
    const taskTbl = el('table', { className: 'w-full text-sm' });
    const tth = el('thead'); const ttr = el('tr', { className: 'bg-gray-50' });
    ['任务ID','标题','门店','严重度','状态','Agent','创建时间'].forEach(h => ttr.appendChild(el('th', { className: 'p-2 text-left text-xs font-semibold text-gray-600' }, h)));
    tth.appendChild(ttr); taskTbl.appendChild(tth);
    const ttb = el('tbody');
    tasks.forEach(t => {
      const tr = el('tr', { className: 'border-b border-gray-100 hover:bg-gray-50' });
      tr.appendChild(el('td', { className: 'p-2 text-xs font-mono' }, (t.task_id||'').slice(0,8)));
      tr.appendChild(el('td', { className: 'p-2 text-xs font-medium' }, (t.title||'-').slice(0,30)));
      tr.appendChild(el('td', { className: 'p-2 text-xs' }, t.store || '-'));
      tr.appendChild(el('td', { className: 'p-2' }, el('span', { className: 'text-xs px-2 py-0.5 rounded-full font-medium ' + (SEV_CLS[t.severity] || 'bg-gray-100') }, t.severity || '-')));
      tr.appendChild(el('td', { className: 'p-2 text-xs' }, t.status || '-'));
      tr.appendChild(el('td', { className: 'p-2 text-xs' }, AN[t.agent] || t.agent || '-'));
      tr.appendChild(el('td', { className: 'p-2 text-xs' }, fmtTime(t.created_at)));
      ttb.appendChild(tr);
    });
    taskTbl.appendChild(ttb); taskCard.appendChild(taskTbl);
    w.appendChild(taskCard);
  }

  if (!logs.length && !rhythms.length && !anomalies.length && !tasks.length && !collabs.length && !Object.keys(summary).length) {
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
function viewScheduled() {
  const w = el('div');
  w.appendChild(el('h2', { className: 'text-lg font-bold text-gray-900 mb-4' }, '定时任务与巡检配置 (全部可自定义)'));
  const cfg = S.schedCfg || {};

  // ── 任务设定 (原节奏引擎, 去掉时间设定, 支持增删) ──
  const rhythmItems = cfg.rhythmItems || [
    { key: 'morning', label: '晨检推送', desc: '每日发送门店晨检提醒', enabled: true },
    { key: 'patrol_am', label: '上午巡检', desc: '午市前巡检推送', enabled: true },
    { key: 'patrol_pm', label: '下午巡检', desc: '晚市前巡检推送', enabled: true },
    { key: 'eod', label: '日终报告', desc: '日终运营数据汇总推送', enabled: true },
    { key: 'weekly', label: '周报', desc: '周度运营分析报告', enabled: true },
    { key: 'monthly', label: '月评', desc: '月度绩效评估报告', enabled: true }
  ];
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
        r.appendChild(btnDanger('删除', () => { rhythmItems.splice(i, 1); renderRhythmList(); }));
        g.appendChild(r);
      });
      // Add new item row
      const addRow = el('div', { className: 'flex items-center gap-3 py-2 px-3 bg-blue-50 rounded-lg border border-blue-100 mt-2' });
      addRow.appendChild(el('input', { id: 'rhy_new_label', placeholder: '任务名称', className: 'border rounded px-2 py-1 text-sm font-medium w-28' }));
      addRow.appendChild(el('input', { id: 'rhy_new_desc', placeholder: '任务描述', className: 'border rounded px-2 py-1 text-xs text-gray-500 flex-1' }));
      addRow.appendChild(btn('+ 新增', () => {
        const label = ($('rhy_new_label')?.value || '').trim();
        const desc = ($('rhy_new_desc')?.value || '').trim();
        if (!label) { msg('请填写任务名称', true); return; }
        const key = 'custom_' + Date.now();
        rhythmItems.push({ key, label, desc, enabled: true });
        renderRhythmList();
      }, 'bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700 font-medium'));
      g.appendChild(addRow);
      // Save button
      g.appendChild(btn('保存任务设定', async () => {
        const items = rhythmItems.map((it, i) => ({
          key: it.key, label: $('rhy_label_' + i)?.value || it.label, desc: $('rhy_desc_' + i)?.value || it.desc,
          enabled: $('rhy_en_' + i)?.checked !== false
        }));
        await PUT('/api/config/rhythm_schedule', { config_value: { rhythmItems: items }, description: '任务设定配置' });
        msg('任务设定已保存');
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
    const addRow = el('div', { className: 'grid grid-cols-5 gap-2 mb-3 p-3 bg-orange-50 rounded-lg border border-orange-100' });
    addRow.appendChild(field('检查项名称', inp('nri_type', '如: 海鲜池水温')));
    addRow.appendChild(field('描述', inp('nri_desc', '拍摄海鲜池照片')));
    addRow.appendChild(field('限时(分)', inp('nri_tw', '15', 'number')));
    addRow.appendChild(field('最小间隔(h)', inp('nri_min', '2', 'number')));
    addRow.appendChild(el('div', { className: 'flex items-end gap-2' }, [
      field('最大间隔(h)', inp('nri_max', '4', 'number')),
      btn('+ 添加', async () => {
        const item = { type: $('nri_type')?.value?.trim(), description: $('nri_desc')?.value?.trim(),
          timeWindow: parseInt($('nri_tw')?.value) || 15, intervalMinHours: parseInt($('nri_min')?.value) || 2, intervalMaxHours: parseInt($('nri_max')?.value) || 4 };
        if (!item.type) { msg('请填写检查项名称', true); return; }
        random.push(item);
        await PUT('/api/config/random_inspections', { config_value: random, description: '随机抽检配置' });
        msg('抽检项已添加'); go('scheduled');
      }, 'bg-orange-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-orange-700 mb-3')
    ]));
    g.appendChild(addRow);
    // Existing items
    random.forEach((r, i) => {
      const row = el('div', { className: 'bg-gray-50 rounded-lg p-3 mb-2 flex flex-wrap gap-3 items-center' });
      row.appendChild(el('input', { id: 'ri_type_' + i, value: r.type, className: 'border rounded px-2 py-1 text-sm font-medium w-32' }));
      row.appendChild(el('input', { id: 'ri_desc_' + i, value: r.description || '', className: 'border rounded px-2 py-1 text-xs flex-1' }));
      const tw = el('div', { className: 'flex items-center gap-1' }); tw.appendChild(lbl('限时(分)')); tw.appendChild(el('input', { type: 'number', value: String(r.timeWindow), id: 'ri_tw_' + i, className: 'border rounded px-2 py-1 text-xs w-16' })); row.appendChild(tw);
      const iv = el('div', { className: 'flex items-center gap-1' }); iv.appendChild(lbl('间隔(h)')); iv.appendChild(el('input', { type: 'number', value: String(r.intervalMinHours), id: 'ri_min_' + i, className: 'border rounded px-2 py-1 text-xs w-14' })); iv.appendChild(el('span', {}, '~')); iv.appendChild(el('input', { type: 'number', value: String(r.intervalMaxHours), id: 'ri_max_' + i, className: 'border rounded px-2 py-1 text-xs w-14' })); row.appendChild(iv);
      row.appendChild(btnDanger('删除', async () => {
        random.splice(i, 1);
        await PUT('/api/config/random_inspections', { config_value: random, description: '随机抽检配置' });
        msg('已删除'); go('scheduled');
      }));
      g.appendChild(row);
    });
    if (random.length) {
      g.appendChild(btn('保存全部修改', async () => {
        const items = random.map((r, i) => ({
          type: $('ri_type_' + i)?.value || r.type, description: $('ri_desc_' + i)?.value || r.description,
          timeWindow: parseInt($('ri_tw_' + i)?.value) || r.timeWindow,
          intervalMinHours: parseInt($('ri_min_' + i)?.value) || r.intervalMinHours,
          intervalMaxHours: parseInt($('ri_max_' + i)?.value) || r.intervalMaxHours
        }));
        await PUT('/api/config/random_inspections', { config_value: items, description: '随机抽检配置' });
        msg('抽检配置已保存'); go('scheduled');
      }, 'mt-3 bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700'));
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
    { cat: '桌访产品异常', role: 'store_production_manager', med: 5, high: 10, freq: 'weekly' },
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
function viewMemory() {
  const w = el('div');
  w.appendChild(el('h2', { className: 'text-lg font-bold text-gray-900 mb-4' }, '🧠 Agent 记忆系统'));

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
// AUDIT LOG
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
    el('p', {}, '• 数据同步到 feishu_generic_records 表和 agent_messages 表,供Agent查询使用'),
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
      const rhyCfg = rhy?.config_value || {};
      S.schedCfg = { dailyInspections: di?.config_value || [], randomInspections: ri?.config_value || [], rhythmItems: rhyCfg.rhythmItems || null, ...(rhyCfg) };
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
    if (t === 'memory') { S.memoryItems = (await G('/api/agent-memory/' + S.selectedAgent).catch(e => { catchNonAuth(e); return { memories: [] }; })).memories || []; }
    if (t === 'flags') { S.featureFlags = (await G('/api/feature-flags').catch(e => { catchNonAuth(e); return { flags: {} }; })).flags || {}; }
    if (t === 'configs') { S.cfgs = (await G('/api/config').catch(e => { catchNonAuth(e); return { configs: [] }; })).configs || []; }
    if (t === 'audit') { S.auditItems = (await G('/api/audit-log?limit=50').catch(e => { catchNonAuth(e); return { log: [] }; })).log || []; }
    if (t === 'activity') { S.activity = await G('/api/agent-activity?date=' + S.activityDate).catch(e => { catchNonAuth(e); return {}; }); }
    if (t === 'datasources') { S.bitableStatus = await G('/api/bitable-status').catch(e => { catchNonAuth(e); return {}; }); }
  } catch (e) { if (e.message === 'auth') { localStorage.removeItem('aat'); renderLogin(); return 'auth'; } }
}

// ═══════════════════════════════════════════════════════
// TABS & ROUTER
// ═══════════════════════════════════════════════════════
const TABS = [
  ['dashboard', '📊 仪表盘'], ['activity', '📋 Agent活动'], ['datasources', '📡 数据源'], ['agents', '🤖 Agent配置'], ['scheduled', '⏰ 定时任务'],
  ['anomaly', '🚨 异常阈值'], ['performance', '📋 绩效考核'], ['marketing', '📢 营销管理'],
  ['evaluation', '🔍 Agent评估'], ['knowledge', '📚 知识库'], ['memory', '🧠 记忆系统'],
  ['flags', '🚩 功能开关'], ['configs', '⚙️ 系统配置'], ['audit', '📝 审计日志']
];
const VW = { dashboard: viewDash, activity: viewActivity, datasources: viewDataSources, agents: viewAgents, scheduled: viewScheduled, anomaly: viewAnomaly, performance: viewPerformance, marketing: viewMarketing, evaluation: viewEval, knowledge: viewKnowledge, memory: viewMemory, flags: viewFlags, configs: viewCfgs, audit: viewAudit };

function render() {
  const a = $('app');
  if (!localStorage.getItem('aat')) { renderLogin(); return; }
  a.innerHTML = '';

  // Header
  const hd = el('header', { className: 'bg-white shadow-sm border-b border-gray-200' });
  const hi = el('div', { className: 'max-w-7xl mx-auto px-6 py-4 flex justify-between items-center' });
  hi.appendChild(el('div', { className: 'flex items-center gap-3' }, [
    el('span', { className: 'text-2xl' }, '🤖'),
    el('div', {}, [el('h1', { className: 'font-bold text-lg text-gray-900 leading-tight' }, 'Agent Ops Admin'), el('p', { className: 'text-xs text-gray-500' }, 'Agents Service V2 管理面板')])
  ]));
  hi.appendChild(btn('退出登录', () => { localStorage.removeItem('aat'); renderLogin(); }, 'text-sm text-gray-500 hover:text-red-500 bg-transparent'));
  hd.appendChild(hi); a.appendChild(hd);

  // Nav tabs
  const nv = el('nav', { className: 'bg-white border-b border-gray-100' });
  const nvInner = el('div', { className: 'max-w-7xl mx-auto px-6 flex gap-1 overflow-x-auto' });
  TABS.forEach(([k, l]) => {
    const cls = 'px-4 py-3 text-sm cursor-pointer whitespace-nowrap transition-colors font-medium ' + (tab === k ? 'border-b-2 border-indigo-500 text-indigo-600' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50 rounded-t');
    nvInner.appendChild(el('div', { className: cls, onclick: () => go(k) }, l));
  });
  nv.appendChild(nvInner); a.appendChild(nv);

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
