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
  // Check what store_code values exist for 马己仙 items in March
  const r1 = await pool.query(`SELECT store_code, COUNT(*)::int AS cnt FROM pos_order_items WHERE store_name LIKE '%马己仙%' AND biz_date >= '2026-03-01' AND biz_date <= '2026-03-31' GROUP BY store_code`);
  console.log('store_code distribution:', JSON.stringify(r1.rows));

  // Check min/max dates
  const r2 = await pool.query(`SELECT MIN(biz_date) AS min_d, MAX(biz_date) AS max_d FROM pos_order_items WHERE store_name LIKE '%马己仙%' AND biz_date >= '2026-03-01' AND biz_date <= '2026-03-31'`);
  console.log('date range:', JSON.stringify(r2.rows[0]));

  // Check some sample records
  const r3 = await pool.query(`SELECT order_no, store_name, store_code, biz_date FROM pos_order_items WHERE store_name LIKE '%马己仙%' AND biz_date >= '2026-03-01' AND biz_date <= '2026-03-31' LIMIT 3`);
  console.log('sample:', JSON.stringify(r3.rows));

  await pool.end();
}
main().catch(e=>console.error(e.message));
