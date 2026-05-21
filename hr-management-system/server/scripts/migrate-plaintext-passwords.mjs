#!/usr/bin/env node
/**
 * migrate-plaintext-passwords.mjs
 * ============================================================================
 * 一次性迁移脚本：扫描 hrms_state.employees / hrms_state.users 中的明文 password
 * 字段，bcrypt 后写入 users 表，并从 JSON 中移除 password 字段。
 *
 * 为什么需要这个脚本：
 *   - hrms_state 是单行 JSONB，会被快照、备份、SELECT 出来。
 *   - 任何能读 hrms_state 的人（运维、备份、第三方工具）就能读到全员密码。
 *   - 这违反《个人信息保护法》第 51 条"加密、去标识化"要求。
 *
 * ⚠️ 运行前必须做的事：
 *   1. pg_dump 当前数据库快照（必须有可回滚的备份）
 *   2. 通知运维：脚本完成后这些用户走 users 表 bcrypt 登录，hrms_state 回退已删除
 *   3. 设置 DRY_RUN=true 先空跑一遍，确认输出符合预期
 *
 * 用法：
 *   DRY_RUN=true  node scripts/migrate-plaintext-passwords.mjs   # 仅打印,不写库
 *   DRY_RUN=false node scripts/migrate-plaintext-passwords.mjs   # 实际执行
 *
 * 完成后还需做的事（手工 review 后再做）：
 *   1. 在 index.js 中删除 hrms_state 回退登录代码（行 ~15310-15346）
 *   2. 重启 hrms-service，用一个迁移过的账号尝试登录验证
 *   3. 如果失败，从 pg_dump 回滚 hrms_state
 *
 * 这个脚本是幂等的：重复运行不会重复写哈希（已有 password_hash 的用户会被跳过）
 * ============================================================================
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = String(process.env.DRY_RUN || 'true').toLowerCase() !== 'false';
const BCRYPT_COST = 10;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL 未配置');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

function looksLikeBcrypt(s) {
  // bcrypt 哈希都以 $2a$ / $2b$ / $2y$ 开头且长度 60
  return typeof s === 'string' && /^\$2[aby]\$\d{2}\$.{53}$/.test(s);
}

async function main() {
  console.log(`\n🔍 plaintext-password migration | DRY_RUN=${DRY_RUN}\n`);

  // 1. 读 hrms_state
  const r = await pool.query("select data from hrms_state where key = 'default' limit 1");
  const data = r.rows[0]?.data;
  if (!data || typeof data !== 'object') {
    console.log('hrms_state 不存在或为空，无需迁移');
    return;
  }

  const employees = Array.isArray(data.employees) ? data.employees : [];
  const users     = Array.isArray(data.users) ? data.users : [];

  // 2. 合并候选（employees 优先）
  const seen = new Map();
  for (const e of employees) {
    const u = String(e?.username || '').trim().toLowerCase();
    if (!u) continue;
    seen.set(u, { src: 'employees', record: e });
  }
  for (const e of users) {
    const u = String(e?.username || '').trim().toLowerCase();
    if (!u) continue;
    if (!seen.has(u)) seen.set(u, { src: 'users', record: e });
  }

  console.log(`📋 候选账号: ${seen.size} 个（employees=${employees.length}, users=${users.length}）`);

  // 3. 逐个迁移
  let migrated = 0;
  let skipped_no_password = 0;
  let skipped_already_hashed = 0;
  let skipped_already_in_users_table = 0;
  let failed = 0;

  for (const [usernameLc, { src, record }] of seen.entries()) {
    const pwd = String(record?.password || '').trim();
    const username = String(record?.username || '').trim();

    if (!pwd) { skipped_no_password++; continue; }
    if (looksLikeBcrypt(pwd)) { skipped_already_hashed++; continue; }

    // 已经在 users 表里有 password_hash 的，不动它
    const existing = await pool.query(
      'select id, password_hash from users where lower(username) = lower($1) limit 1',
      [username]
    );
    if (existing.rows[0]?.password_hash) {
      skipped_already_in_users_table++;
      console.log(`  ⏭️  ${username} (${src}) — users 表已有 hash，跳过`);
      continue;
    }

    try {
      const hash = await bcrypt.hash(pwd, BCRYPT_COST);
      if (DRY_RUN) {
        console.log(`  [DRY] ${username} (${src}) — would upsert hash`);
      } else {
        // 根据真实 users 表 schema:列名 real_name；id 由 DB 自动生成 UUID；role 有 CHECK 约束
        const realName = String(record?.name || record?.real_name || record?.realName || username);
        const rawRole = String(record?.role || 'store_employee').trim();
        const ALLOWED_ROLES = new Set(['admin','hq_manager','store_manager','hq_employee','store_employee','front_manager']);
        const role = ALLOWED_ROLES.has(rawRole) ? rawRole : 'store_employee';
        await pool.query(
          `insert into users (username, password_hash, real_name, role, is_active)
           values ($1, $2, $3, $4, true)
           on conflict (username) do update
             set password_hash = excluded.password_hash,
                 real_name = coalesce(nullif(users.real_name, ''), excluded.real_name)`,
          [username, hash, realName, role]
        );
        console.log(`  ✅ ${username} (${src}) — hash written (role=${role}${role !== rawRole ? `, original=${rawRole}` : ''})`);
      }
      migrated++;
    } catch (e) {
      failed++;
      console.error(`  ❌ ${username} (${src}) — ${e?.message}`);
    }
  }

  // 4. 从 hrms_state JSON 中删除 password 字段
  if (migrated > 0 && !DRY_RUN) {
    console.log('\n🧹 从 hrms_state 中移除明文 password 字段...');
    const stripped = { ...data };
    if (Array.isArray(stripped.employees)) {
      stripped.employees = stripped.employees.map(({ password, ...rest }) => rest);
    }
    if (Array.isArray(stripped.users)) {
      stripped.users = stripped.users.map(({ password, ...rest }) => rest);
    }
    await pool.query(
      "update hrms_state set data = $1::jsonb, updated_at = NOW() where key = 'default'",
      [JSON.stringify(stripped)]
    );
    console.log('  ✅ password 字段已从 hrms_state.employees / hrms_state.users 中清除');
  } else if (DRY_RUN && migrated > 0) {
    console.log(`\n[DRY] 实际运行时会从 hrms_state 中移除 ${migrated} 条 password 字段`);
  }

  // 5. 汇总
  console.log('\n📊 汇总:');
  console.log(`  迁移成功:               ${migrated}`);
  console.log(`  跳过(无密码):           ${skipped_no_password}`);
  console.log(`  跳过(已是 bcrypt 哈希): ${skipped_already_hashed}`);
  console.log(`  跳过(users 表已有 hash): ${skipped_already_in_users_table}`);
  console.log(`  失败:                   ${failed}`);
  if (DRY_RUN) {
    console.log('\n⚠️  这是 DRY RUN，未写入任何数据。复核无误后用 DRY_RUN=false 实际执行。');
  } else {
    console.log('\n✅ 完成。下一步：');
    console.log('   1) 用任意一个迁移过的账号尝试登录（验证 users 表 bcrypt 路径生效）');
    console.log('   2) 验证通过后，删除 server/index.js 中 hrms_state 明文回退登录代码');
    console.log('   3) 重启 hrms-service');
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('❌ Migration failed:', e); process.exit(1); });
