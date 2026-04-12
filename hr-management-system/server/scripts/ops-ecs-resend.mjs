#!/usr/bin/env node
/**
 * 在 ECS 本机调用 HRMS / agents 管理接口（需 admin 账号）。
 * 用法（在 /opt/hrms/server 或加载 .env.production 后）：
 *   node scripts/ops-ecs-resend.mjs sync-daily-pg 2026-04-11
 *   node scripts/ops-ecs-resend.mjs briefing
 *   node scripts/ops-ecs-resend.mjs attitude 2026-04-11
 *
 * 环境：HRMS_BASE_URL（默认 http://127.0.0.1:3000）、AGENTS_BASE_URL（默认 http://127.0.0.1:3101）、
 *       ADMIN_USERNAME、ADMIN_PASSWORD
 */
import 'dotenv/config';

const HRMS = (process.env.HRMS_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const AGENTS = (process.env.AGENTS_BASE_URL || 'http://127.0.0.1:3101').replace(/\/$/, '');
const user = process.env.ADMIN_USERNAME || 'admin';
const pass = process.env.ADMIN_PASSWORD || 'admin123';

async function loginHrms() {
  const r = await fetch(`${HRMS}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass })
  });
  const j = await r.json().catch(() => ({}));
  if (!j.token) throw new Error(`HRMS 登录失败: HTTP ${r.status} ${JSON.stringify(j)}`);
  return j.token;
}

async function loginAgents() {
  const r = await fetch(`${AGENTS}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass })
  });
  const j = await r.json().catch(() => ({}));
  if (!j.token) throw new Error(`agents 登录失败: HTTP ${r.status} ${JSON.stringify(j)}`);
  return j.token;
}

async function main() {
  const [cmd, a1] = process.argv.slice(2);
  if (cmd === 'sync-daily-pg') {
    const date = String(a1 || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('用法: sync-daily-pg YYYY-MM-DD');
    const token = await loginHrms();
    const r = await fetch(`${HRMS}/api/admin/sync-submitted-daily-reports-pg`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date })
    });
    const text = await r.text();
    console.log('sync-daily-pg', r.status, text);
    if (!r.ok) process.exit(1);
    return;
  }
  if (cmd === 'briefing') {
    const token = await loginAgents();
    const r = await fetch(`${AGENTS}/api/briefing/send-now`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}'
    });
    const text = await r.text();
    console.log('briefing', r.status, text);
    if (!r.ok) process.exit(1);
    return;
  }
  if (cmd === 'attitude') {
    const bizYmd = String(a1 || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bizYmd)) throw new Error('用法: attitude YYYY-MM-DD');
    const token = await loginAgents();
    const r = await fetch(`${AGENTS}/api/rhythm/attitude-filing`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bizYmd, force: true })
    });
    const text = await r.text();
    console.log('attitude', r.status, text);
    if (!r.ok) process.exit(1);
    return;
  }
  console.error(
    '用法: node scripts/ops-ecs-resend.mjs sync-daily-pg YYYY-MM-DD | briefing | attitude YYYY-MM-DD'
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
