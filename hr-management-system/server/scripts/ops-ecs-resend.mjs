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
 *
 * 无密码运维（仅本机、需能读取与 HRMS/agents 一致的 JWT_SECRET）：
 *   OPS_USE_JWT_FORGE=1 node scripts/ops-ecs-resend.mjs …
 *   HRMS 与 agents 若密钥不同，可分别设 HRMS_JWT_SECRET、AGENTS_JWT_SECRET（否则回落 JWT_SECRET）。
 */
import 'dotenv/config';
import jwt from 'jsonwebtoken';

const HRMS = (process.env.HRMS_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const AGENTS = (process.env.AGENTS_BASE_URL || 'http://127.0.0.1:3101').replace(/\/$/, '');
const user = process.env.ADMIN_USERNAME || 'admin';
const pass = process.env.ADMIN_PASSWORD || 'admin123';

function forgeHrmsAdminToken() {
  const secret = process.env.HRMS_JWT_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('OPS_USE_JWT_FORGE=1 时需要 HRMS_JWT_SECRET 或 JWT_SECRET');
  /** 不传 sn：HRMS authRequired 会跳过 session_nonce 校验，等价于本机运维调用 */
  return jwt.sign(
    {
      id: Number(process.env.OPS_JWT_USER_ID || 1) || 1,
      username: process.env.OPS_JWT_USERNAME || 'admin',
      name: process.env.OPS_JWT_NAME || 'Admin',
      role: 'admin'
    },
    secret,
    { expiresIn: '2h' }
  );
}

function forgeAgentsAdminToken() {
  const secret = process.env.AGENTS_JWT_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('OPS_USE_JWT_FORGE=1 时需要 AGENTS_JWT_SECRET 或 JWT_SECRET');
  return jwt.sign(
    { username: process.env.OPS_JWT_USERNAME || 'admin', role: 'admin' },
    secret,
    { expiresIn: '2h' }
  );
}

async function loginHrms() {
  if (String(process.env.OPS_USE_JWT_FORGE || '').trim() === '1') {
    return forgeHrmsAdminToken();
  }
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
  if (String(process.env.OPS_USE_JWT_FORGE || '').trim() === '1') {
    return forgeAgentsAdminToken();
  }
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
