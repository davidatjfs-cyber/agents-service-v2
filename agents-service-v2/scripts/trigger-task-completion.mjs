#!/usr/bin/env node
/**
 * 手动重发「每日任务达成率」飞书卡片（与定时任务同源）。
 * 环境：AGENTS_BASE_URL（默认 http://127.0.0.1:3101）、ADMIN_USERNAME、ADMIN_PASSWORD
 * 可选：YESTERDAY_YMD=2026-04-11 指定统计「任务创建日」= 该日的上海日历（与 master_tasks.created_at 口径一致）
 */
const base = (process.env.AGENTS_BASE_URL || 'http://127.0.0.1:3101').replace(/\/$/, '');
const user = process.env.ADMIN_USERNAME || 'admin';
const pass = process.env.ADMIN_PASSWORD || 'admin123';
const yesterdayYmd = String(process.env.YESTERDAY_YMD || '').trim().slice(0, 10);
const force = String(process.env.FORCE_RESEND || '').trim() === '1' || process.env.FORCE_RESEND === 'true';

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
  const payload = {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(yesterdayYmd)) payload.yesterdayYmd = yesterdayYmd;
  if (force) payload.force = true;
  const body = JSON.stringify(payload);
  console.log('>>> 已登录，正在发送每日任务达成率…', body);
  const r2 = await fetch(`${base}/api/rhythm/task-completion`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${j1.token}`,
      'Content-Type': 'application/json'
    },
    body
  });
  const text = await r2.text();
  console.log('HTTP', r2.status, text);
  if (!r2.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
