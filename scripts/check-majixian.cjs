const path = require('path');

function requireWorkspaceModule(moduleName) {
  const candidates = [
    path.join(__dirname, '..', 'agents-service-v2', 'node_modules', moduleName),
    path.join(__dirname, '..', 'hr-management-system', 'server', 'node_modules', moduleName)
  ];

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (err) {
      if (err && err.code !== 'MODULE_NOT_FOUND') throw err;
    }
  }

  throw new Error(`Cannot resolve workspace module: ${moduleName}`);
}

const { Pool } = requireWorkspaceModule('pg');
const pool = new Pool({ connectionString: 'postgres://hrms:Abc1234567!@127.0.0.1:5432/hrms' });
async function main() {
  const r1 = await pool.query(`SELECT COUNT(*)::int AS total, MIN(biz_date) AS min_date, MAX(biz_date) AS max_date, COUNT(DISTINCT order_no)::int AS distinct_orders FROM pos_order_items WHERE store_code = '51866138' AND biz_date >= '2026-03-01' AND biz_date <= '2026-03-31'`);
  console.log('items 马己仙 3/1-3/31:', JSON.stringify(r1.rows[0]));

  const r2 = await pool.query(`SELECT COUNT(*)::int AS total, MIN(biz_date) AS min_date, MAX(biz_date) AS max_date FROM pos_orders WHERE store_id = '51866138' AND biz_date >= '2026-03-01' AND biz_date <= '2026-03-31'`);
  console.log('orders 马己仙 3/1-3/31:', JSON.stringify(r2.rows[0]));

  const r3 = await pool.query(`SELECT DISTINCT store_name, store_code FROM pos_order_items WHERE store_code = '51866138' LIMIT 5`);
  console.log('sample store_names:', JSON.stringify(r3.rows));

  const r4 = await pool.query(`SELECT COUNT(*)::int AS cnt, MIN(biz_date) AS min_date, MAX(biz_date) AS max_date FROM pos_order_items WHERE store_code = '51866138' AND biz_date >= '2026-04-01' AND biz_date <= '2026-04-30'`);
  console.log('items 马己仙 4/1-4/30 (not deleted):', JSON.stringify(r4.rows[0]));

  // Check if there are records without store_code but with 马己仙 store_name
  const r5 = await pool.query(`SELECT COUNT(*)::int AS cnt FROM pos_order_items WHERE store_name LIKE '%马己仙%' AND biz_date >= '2026-03-01' AND biz_date <= '2026-03-31'`);
  console.log('items with 马己仙 store_name 3/1-3/31:', JSON.stringify(r5.rows[0]));

  await pool.end();
}
main().catch(e=>console.error(e.message));
