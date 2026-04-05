import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hrms_user_notifications (
        id BIGSERIAL PRIMARY KEY,
        target_username TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'performance_deduction',
        meta JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const testMsg = `【测试通知】这是一条由 Cursor 发送的测试公司通知，用于验证 V2 Agent 工作态度通知能否正确同步到 HRMS 公司通知栏。

如果您看到这条消息，说明修复已生效。请回复确认收到。

测试时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
`;

    const result = await pool.query(
      `INSERT INTO hrms_user_notifications (target_username, title, message, type, meta)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, target_username, title, created_at`,
      [
        'nnyxcs35',
        '🧪 Cursor 测试通知',
        testMsg,
        'test_notice',
        JSON.stringify({ source: 'cursor_test', timestamp: new Date().toISOString() })
      ]
    );

    const row = result.rows[0];
    console.log('✅ 测试通知已写入：');
    console.log('   ID:', row.id);
    console.log('   目标用户:', row.target_username);
    console.log('   标题:', row.title);
    console.log('   时间:', row.created_at);

    const verify = await pool.query(
      `SELECT COUNT(*) as cnt FROM hrms_user_notifications WHERE target_username = $1`,
      ['nnyxcs35']
    );
    console.log('\n📊 nnyxcs35 当前共有', verify.rows[0].cnt, '条公司通知');

    const latest = await pool.query(
      `SELECT id, title, type, created_at FROM hrms_user_notifications
       WHERE target_username = $1 ORDER BY created_at DESC LIMIT 3`,
      ['nnyxcs35']
    );
    console.log('\n📋 最新 3 条通知：');
    for (const r of latest.rows) {
      console.log(`   [${r.id}] ${r.title} (${r.type}) - ${r.created_at}`);
    }
  } catch(e) {
    console.error('❌ 失败:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
