#!/usr/bin/env node
/**
 * 手动重发「不满意产品日报」（与 POST /api/rhythm/dissatisfied-product/daily 等价）
 *
 * 用法：
 *   node scripts/resend-dissatisfied-product-daily.mjs           # 上海「今天」
 *   node scripts/resend-dissatisfied-product-daily.mjs 2026-04-17
 *
 * 环境变量：
 *   AGENTS_BASE_URL   默认 http://127.0.0.1:3101（与 ecosystem.config.cjs 中 PORT 一致）
 *   ADMIN_USERNAME    默认 admin
 *   ADMIN_PASSWORD    默认 admin123（生产请在 ECS 上 export 真实密码）
 */
const base = (process.env.AGENTS_BASE_URL || 'http://127.0.0.1:3101').replace(/\/$/, '');
const user = process.env.ADMIN_USERNAME || 'admin';
const pass = process.env.ADMIN_PASSWORD || 'admin123';
const targetYmd = process.argv[2] ? String(process.argv[2]).trim() : null;

async function main() {
  const r1 = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass })
  });
  const j1 = await r1.json().catch(() => ({}));
  if (!j1.token) {
    console.error('登录失败:', r1.status, j1);
    process.exit(1);
  }
  const body = { force: true };
  if (targetYmd) body.targetYmd = targetYmd;
  console.log('>>> 正在重发不满意产品日报…', body);
  const r2 = await fetch(`${base}/api/rhythm/dissatisfied-product/daily`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${j1.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await r2.text();
  console.log('HTTP', r2.status, text);
  if (!r2.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
