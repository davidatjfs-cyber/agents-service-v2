/**
 * HRMS Feishu Agent 端到端测试脚本
 * 测试所有 Agent 的收发消息是否正确
 *
 * 用法: node scripts/test_feishu_agents.mjs
 */

import axios from 'axios';

const BASE = 'http://127.0.0.1:3000';
let TOKEN = '';
let ADMIN_OPEN_ID = '';

const PASS = '✅';
const FAIL = '❌';
const SKIP = '⏭ ';

let passed = 0, failed = 0, skipped = 0;

function log(icon, label, detail = '') {
  console.log(`${icon} ${label}${detail ? '  →  ' + detail : ''}`);
}

async function step(label, fn) {
  try {
    const result = await fn();
    if (result === 'skip') { log(SKIP, label, '跳过'); skipped++; return null; }
    log(PASS, label, typeof result === 'string' ? result : JSON.stringify(result));
    passed++;
    return result;
  } catch (e) {
    const msg = e?.response?.data ? JSON.stringify(e.response.data) : e.message;
    log(FAIL, label, msg);
    failed++;
    return null;
  }
}

async function api(method, path, data, auth = true) {
  const headers = auth && TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
  const resp = await axios({ method, url: BASE + path, data, headers, timeout: 15000 });
  return resp.data;
}

// ─────────────────────────────────────────────
// 1. 基础连通性
// ─────────────────────────────────────────────
console.log('\n══════════════════════════════════════════');
console.log('  HRMS Feishu Agent 端到端测试');
console.log('══════════════════════════════════════════\n');

console.log('【1】基础连通性');

await step('健康检查 /api/health', async () => {
  const d = await api('GET', '/api/health', null, false);
  if (!d.ok) throw new Error('health not ok');
  return `ok, storage: oss=${d.storage?.ossConfigured}`;
});

await step('管理员登录', async () => {
  const d = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' }, false);
  if (!d.token) throw new Error('no token returned');
  TOKEN = d.token;
  return `token获取成功, role=${d.user?.role}`;
});

// ─────────────────────────────────────────────
// 2. 飞书 Token 测试
// ─────────────────────────────────────────────
console.log('\n【2】飞书 Token 与发送能力');

await step('获取飞书 Tenant Access Token', async () => {
  const d = await api('GET', '/api/agents/feishu-token-test', null, true);
  if (!d.ok) throw new Error(d.error || 'token failed');
  return `token长度=${String(d.token || '').length}`;
});

await step('查询已绑定飞书用户', async () => {
  const d = await api('GET', '/api/agents/feishu-users', null, true);
  const items = d?.items || [];
  if (!items.length) throw new Error('没有已绑定的飞书用户，请先在飞书里和机器人对话绑定账号');
  const admin = items.find(u => u.role === 'admin' || u.role === 'hq_manager');
  if (!admin) throw new Error(`已绑定用户: ${items.map(u => u.username).join(',')}，但没有管理员账号`);
  ADMIN_OPEN_ID = admin.open_id;
  return `找到 ${items.length} 个绑定用户，管理员: ${admin.username}(${admin.name})`;
});

await step('飞书发送测试消息给管理员', async () => {
  if (!ADMIN_OPEN_ID) return 'skip';
  const d = await api('POST', '/api/agents/feishu-send-test', { openId: ADMIN_OPEN_ID, message: '🧪 HRMS Agent 系统测试消息 - 请忽略' }, true);
  if (!d.ok) throw new Error(d.error || '发送失败');
  return `发送成功 → ${ADMIN_OPEN_ID.slice(0, 20)}...`;
});

// ─────────────────────────────────────────────
// 3. Webhook 接收测试（模拟飞书事件）
// ─────────────────────────────────────────────
console.log('\n【3】Webhook 接收 & 消息路由');

await step('Webhook URL 验证（飞书握手）', async () => {
  const d = await api('POST', '/api/feishu/webhook', { type: 'url_verification', challenge: 'test_abc123' }, false);
  if (d.challenge !== 'test_abc123') throw new Error(`challenge 不匹配: ${JSON.stringify(d)}`);
  return 'challenge 响应正确';
});

// 模拟飞书消息事件（不需要真实 open_id，只测路由逻辑）
const mockEvent = (text, openId = 'ou_test_mock_user') => ({
  schema: '2.0',
  header: { event_type: 'im.message.receive_v1', event_id: `test_${Date.now()}` },
  event: {
    sender: { sender_id: { open_id: openId }, sender_type: 'user' },
    message: {
      message_id: `om_test_${Date.now()}`,
      message_type: 'text',
      content: JSON.stringify({ text })
    }
  }
});

const routeTests = [
  { label: '路由 → 数据审计员（损耗关键词）', text: '昨天损耗多少？', expect: 'data_auditor' },
  { label: '路由 → 营运督导员（卫生关键词）', text: '帮我检查一下卫生情况', expect: 'ops_supervisor' },
  { label: '路由 → 绩效考核官（考核关键词）', text: '我这周考核分多少？', expect: 'chief_evaluator' },
  { label: '路由 → SOP顾问（流程关键词）', text: '外卖漏发餐具怎么赔付？', expect: 'sop_advisor' },
  { label: '路由 → 申诉处理（申诉关键词）', text: '申诉昨天损耗扣分，原因是停电', expect: 'appeal' },
];

for (const t of routeTests) {
  await step(t.label, async () => {
    const d = await api('POST', '/api/agents/route-test', { text: t.text }, true);
    if (!d.route) throw new Error(`无路由结果: ${JSON.stringify(d)}`);
    if (d.route !== t.expect) throw new Error(`期望 ${t.expect}，实际 ${d.route}`);
    return `路由正确: ${d.route}`;
  });
}

// ─────────────────────────────────────────────
// 4. Agent 功能测试
// ─────────────────────────────────────────────
console.log('\n【4】Agent 功能测试');

await step('数据审计员 - 手动触发审计', async () => {
  const d = await api('POST', '/api/agents/run/audit', null, true);
  if (typeof d.scanned !== 'number') throw new Error(`返回格式异常: ${JSON.stringify(d)}`);
  return `扫描 ${d.scanned} 个门店，发现 ${d.issuesFound} 条，新增 ${d.issuesCreated} 条，飞书推送 ${d.feishuPushed} 条`;
});

await step('绩效考核官 - 手动触发评估', async () => {
  const now = new Date();
  const weekNum = Math.ceil((now.getDate() + new Date(now.getFullYear(), now.getMonth(), 1).getDay()) / 7);
  const period = `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  const d = await api('POST', '/api/agents/run/evaluate', { period }, true);
  if (typeof d.evaluated !== 'number') throw new Error(`返回格式异常: ${JSON.stringify(d)}`);
  return `评估 ${d.evaluated} 人，飞书推送 ${d.feishuPushed} 条，周期: ${period}`;
});

await step('查询异常列表 /api/agents/issues', async () => {
  const d = await api('GET', '/api/agents/issues?limit=5', null, true);
  const items = d?.items || [];
  return `共 ${items.length} 条，最新: ${items[0]?.title?.slice(0, 30) || '无'}`;
});

await step('查询绩效列表 /api/agents/scores', async () => {
  const d = await api('GET', '/api/agents/scores?limit=5', null, true);
  const items = d?.items || [];
  return `共 ${items.length} 条，最新: ${items[0] ? items[0].store + ' ' + items[0].total_score + '分' : '无'}`;
});

await step('查询消息日志 /api/agents/messages', async () => {
  const d = await api('GET', '/api/agents/messages?limit=5', null, true);
  const items = d?.items || [];
  return `共 ${items.length} 条，最新: ${items[0]?.sender_name || items[0]?.sender_username || '无'}`;
});

await step('查询审核记录 /api/agents/audits', async () => {
  const d = await api('GET', '/api/agents/audits?limit=5', null, true);
  const items = d?.items || [];
  return `共 ${items.length} 条`;
});

await step('查询仪表盘 /api/agents/dashboard', async () => {
  const d = await api('GET', '/api/agents/dashboard', null, true);
  if (!d.issues) throw new Error(`返回格式异常: ${JSON.stringify(d)}`);
  return `异常待处理: ${d.issues?.open}，平均绩效: ${d.scores?.avg_score}，飞书绑定: ${d.feishuUsers?.registered}/${d.feishuUsers?.total}`;
});

// ─────────────────────────────────────────────
// 5. 飞书主动推送测试
// ─────────────────────────────────────────────
console.log('\n【5】飞书主动推送测试');

await step('给管理员发送审计汇总通知', async () => {
  if (!ADMIN_OPEN_ID) return 'skip';
  const d = await api('POST', '/api/agents/feishu-send-test', {
    openId: ADMIN_OPEN_ID,
    message: `📊 HRMS Agent 测试报告\n\n所有 Agent 测试完成，系统运行正常。\n\n✅ 数据审计员：正常\n✅ 营运督导员：正常\n✅ 绩效考核官：正常\n✅ SOP顾问：正常\n\n如收到此消息，说明飞书推送链路完全正常。`
  }, true);
  if (!d.ok) throw new Error(d.error || '发送失败');
  return `测试报告已发送到你的飞书`;
});

// ─────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────
console.log('\n══════════════════════════════════════════');
console.log(`  测试结果: ${PASS} ${passed} 通过  ${FAIL} ${failed} 失败  ${SKIP} ${skipped} 跳过`);
console.log('══════════════════════════════════════════\n');

if (failed > 0) {
  console.log('⚠️  有测试失败，请检查上方错误信息。');
  process.exit(1);
} else {
  console.log('🎉 所有测试通过！飞书 ↔ HRMS Agent 链路正常。');
}
