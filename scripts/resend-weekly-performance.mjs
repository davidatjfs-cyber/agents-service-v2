#!/usr/bin/env node
/**
 * 一键「重算并重发」上周绩效汇总（管理）飞书卡：调用 agents-service POST /api/performance/weekly-digest/resend
 *
 * 用法（须换成真实值；不要把中文说明写进 URL）：
 *   cd HRMS
 *   export AGENTS_BASE_URL=https://（与 agents /health 一致的根地址，勿仅用 HR 主站域名）
 *   export ADMIN_USERNAME=admin
 *   export ADMIN_PASSWORD='实际登录密码'
 *   export PERIOD_MONDAY=2026-03-23
 *
 *   node scripts/resend-weekly-performance.mjs
 *
 * AGENTS_BASE_URL 必须是 **agents-service-v2** 的站点根（与飞书回调打到的那台 agents 一致）。
 * 若主域名 nnyx.cc 只把 HR 前端 + HRMS /api 暴露出去，而仅 /api/webhook/feishu 指到 agents，
 * 则不能把 AGENTS_BASE_URL 设为 nnyx.cc——需在 Nginx 同样反代 /health、/api/login、/api/performance* 到 agents，
 * 或使用 agents 独立域名/端口后再填这里。
 * zsh 里注释单独成行且以 # 开头；不要执行单独一行的 `#`，否则会报 command not found: #。
 *
 * （不设 dotenv：请在 shell 里 export，或 `set -a && source agents-service-v2/.env && set +a`）
 */

function normalizeAgentsBase(raw) {
  let s = String(raw || '').trim().replace(/\/$/, '');
  if (!s) return '';
  s = s.replace(/\/api\/webhook\/feishu\/?$/i, '').replace(/\/$/, '');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/$/, '');
}

function assertNoPlaceholders(base, _user, pass) {
  let host = '';
  try {
    host = new URL(base).hostname;
  } catch {
    return;
  }
  // 中文写在 URL 里时，Node 会把主机名转成 punycode（xn--...），所以必须检查原始 base 字符串
  const badHost = /[\u4e00-\u9fff]/.test(host) || /你的|agents域名|示例域名|占位/.test(base);
  const badPass = pass === '你的密码' || /你的密码/.test(pass);
  if (badHost || badPass) {
    console.error(
      'AGENTS_BASE_URL 或密码仍是文档里的占位符。请改为 **agents 服务** 的真实根地址与密码，例如：\n' +
        '  export AGENTS_BASE_URL=https://agents.example.com\n' +
        '  export ADMIN_PASSWORD=（与服务器上 agents 的 ADMIN_PASSWORD 一致）\n' +
        '\n若报错 ENOTFOUND xn--... 即曾把中文说明写进 URL。'
    );
    process.exit(1);
  }
}

function lastCompletedWeekMondayShanghai() {
  const now = new Date();
  const sh = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const dow = sh.getDay();
  const daysSinceMonday = (dow + 6) % 7;
  const thisMonday = new Date(sh);
  thisMonday.setDate(sh.getDate() - daysSinceMonday);
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(thisMonday.getDate() - 7);
  const y = lastMonday.getFullYear();
  const m = String(lastMonday.getMonth() + 1).padStart(2, '0');
  const da = String(lastMonday.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

const base = normalizeAgentsBase(process.env.AGENTS_BASE_URL || '');
const user = String(process.env.ADMIN_USERNAME || process.env.AGENTS_ADMIN_USERNAME || '').trim();
const pass = String(process.env.ADMIN_PASSWORD || process.env.AGENTS_ADMIN_PASSWORD || '');
let periodMonday = String(process.env.PERIOD_MONDAY || '').trim();
if (!periodMonday) periodMonday = lastCompletedWeekMondayShanghai();

if (!base || !user || !pass) {
  console.error('缺少环境变量：AGENTS_BASE_URL、ADMIN_USERNAME、ADMIN_PASSWORD（或 AGENTS_* 别名）');
  process.exit(1);
}

try {
  const u = new URL(base);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('protocol');
} catch {
  console.error('AGENTS_BASE_URL 不是合法 URL，示例：https://nnyx.cc');
  process.exit(1);
}

assertNoPlaceholders(base, user, pass);

if (!/^\d{4}-\d{2}-\d{2}$/.test(periodMonday)) {
  console.error('PERIOD_MONDAY 须为 YYYY-MM-DD（绩效周周一）');
  process.exit(1);
}

async function assertTargetIsAgentsService() {
  if (String(process.env.SKIP_AGENTS_HEALTH_CHECK || '').trim() === '1') return;
  const res = await fetch(`${base}/health`);
  const j = await res.json().catch(() => ({}));
  if (res.ok && j.service === 'agents-service-v2') return;

  const r2 = await fetch(`${base}/api/health`);
  const j2 = await r2.json().catch(() => ({}));
  const hrmsLike = r2.ok && j2 && j2.ok === true && j2.storage != null && typeof j2.storage === 'object';

  if (hrmsLike) {
    console.error(
      '当前域名指向 **HRMS 主站**（/api/health 为 HR 后端），不是 agents-service-v2。\n' +
        '登录接口打到了 HRMS，故会出现 `invalid_credentials`（与 agents 的 admin 密码无关）。\n\n' +
        '「绩效周报复发」只在 agents 上：请把 AGENTS_BASE_URL 改成能访问 agents 的根地址，例如：\n' +
        '  · Nginx 增加与 /api/webhook/feishu 相同 upstream 的 location：/health、/api/login、/api/performance\n' +
        '  · 或为 agents 配置独立子域名/端口，再 export AGENTS_BASE_URL=…\n\n' +
        '服务器上 agents 默认监听 3101（见 deploy 脚本）；密码以 ECS 上 agents 的 .env 中 ADMIN_* 为准。\n' +
        '临时绕过本检查可设：SKIP_AGENTS_HEALTH_CHECK=1（仍须保证 /api/login 真是 agents）。'
    );
    process.exit(1);
  }

  console.warn(
    `未在 ${base}/health 识别到 agents-service-v2（HTTP ${res.status}），仍尝试登录…\n` +
      '若登录返回 invalid_credentials，多半是 /api/login 被反代到了 HRMS。'
  );
}

await assertTargetIsAgentsService();

const loginUrl = `${base}/api/login`;
const resendUrl = `${base}/api/performance/weekly-digest/resend`;

const lr = await fetch(loginUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass })
});
const lj = await lr.json().catch(() => ({}));
const token = lj.token;
if (!lr.ok || !token) {
  if (lr.status === 401 && lj.error === 'invalid_credentials') {
    console.error(
      '登录失败: 401 invalid_credentials — 这来自 **HRMS** 登录，不是 agents。\n' +
        '请换用 agents 的 Base URL，或在网关把 /api/login 指到与飞书 webhook 相同的 agents 进程。'
    );
  } else {
    console.error('登录失败:', lr.status, lj);
  }
  process.exit(1);
}

const rr = await fetch(resendUrl, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ periodMonday })
});
const rj = await rr.json().catch(() => ({}));
if (!rr.ok) {
  console.error('重发失败:', rr.status, rj);
  process.exit(1);
}

console.log('ok', { periodMonday, result: rj });
