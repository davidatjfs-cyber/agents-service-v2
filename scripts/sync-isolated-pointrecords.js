#!/usr/bin/env node
/**
 * 同步 state 中孤立的 pointRecords 到 DB
 */
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  try {
    const stateR = await pool.query(`SELECT data->'pointRecords' as pr FROM hrms_state WHERE key='default'`);
    const prs = stateR.rows[0]?.pr || [];
    
    const dbR = await pool.query('SELECT id::text FROM point_records');
    const dbIds = new Set(dbR.rows.map(r => r.id));
    
    const isolated = prs.filter(p => p?.id && !dbIds.has(p.id));
    console.log(`找到 ${isolated.length} 条孤立记录`);
    
    if (isolated.length === 0) {
      console.log('无需同步');
      return;
    }
    
    let inserted = 0;
    let errors = 0;
    
    for (const p of isolated) {
      try {
        const approvedAt = p.approvedAt ? new Date(p.approvedAt) : new Date();
        await pool.query(
          `INSERT INTO point_records (id, approval_id, username, name, store, item_name, reason, points, amount, approved_at, approved_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (id) DO NOTHING`,
          [
            p.id,
            p.approvalId || '',
            p.username || '',
            p.name || '',
            p.store || '',
            p.itemName || p.item_name || '',
            p.reason || '',
            p.points != null ? Number(p.points) : 0,
            p.amount != null ? Number(p.amount) : 0,
            approvedAt,
            p.approvedBy || '',
            approvedAt,
            approvedAt
          ]
        );
        inserted++;
      } catch (e) {
        errors++;
        console.error(`插入失败 id=${p.id}: ${e.message}`);
      }
    }
    
    console.log(`\n同步完成:`);
    console.log(`  成功插入: ${inserted}`);
    console.log(`  错误: ${errors}`);
    
    const finalStateR = await pool.query(`SELECT jsonb_array_length(data->'pointRecords') as cnt FROM hrms_state WHERE key='default'`);
    const finalDbR = await pool.query(`SELECT COUNT(*) as cnt FROM point_records`);
    console.log(`\n验证:`);
    console.log(`  state: ${finalStateR.rows[0].cnt}`);
    console.log(`  DB: ${finalDbR.rows[0].cnt}`);
    
  } catch (e) {
    console.error('失败:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
