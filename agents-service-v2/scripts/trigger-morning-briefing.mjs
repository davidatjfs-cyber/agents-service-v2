#!/usr/bin/env node
/**
 * 手动发一轮晨报（登录需 admin 或能在 DB 弱认证下拿到 hq_manager —— 见 /api/login）
 * 环境变量：
 *   AGENTS_BASE_URL  默认 http://127.0.0.1:3101
 *   ADMIN_USERNAME   默认 admin
 *   ADMIN_PASSWORD   默认 admin123（生产请务必改成 .env 里的真实密码）
 */
const base = (process.env.AGENTS_BASE_URL || 'http://127.0.0.1:3101').replace(/\/$/, '');
const user = process.env.ADMIN_USERNAME || 'admin';
const pass = process.env.ADMIN_PASSWORD || 'admin123';

async function main() {
  const r1 = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass })
  });
  const j1 = await r1.json().catch(() => ({}));
  if (!j1.token) {
    console.error('登录失败:', j1);
    process.exit(1);
  }
  console.log('>>> 已登录，正在发送晨报（可能需几十秒）…');
  const r2 = await fetch(`${base}/api/briefing/send-now`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${j1.token}`,
      'Content-Type': 'application/json'
    },
    body: '{}'
  });
  const text = await r2.text();
  console.log('HTTP', r2.status, text);
  if (!r2.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
