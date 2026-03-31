const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgres://hrms:Abc1234567!@127.0.0.1:5432/hrms' });
(async () => {
  // Check if checkin_records table exists and has data
  try {
    const r = await pool.query("select count(*) as cnt from checkin_records");
    console.log('=== CHECKIN RECORDS COUNT ===', r.rows[0].cnt);
  } catch (e) {
    console.log('=== CHECKIN TABLE ERROR ===', e.message);
  }

  // Test the checkin endpoint via curl-like approach
  // Check monthly confirm table
  try {
    const r = await pool.query("select count(*) as cnt from information_schema.tables where table_name = 'monthly_confirmations'");
    console.log('=== MONTHLY CONFIRM TABLE EXISTS ===', r.rows[0].cnt);
  } catch (e) {
    console.log('monthly_confirmations check error:', e.message);
  }

  // Check approval delete endpoint existence
  // Check for ghost approvals assigned to gaoyun
  try {
    const r = await pool.query("select id, type, status, applicant_username, current_assignee_username, chain from approval_requests where lower(current_assignee_username) = 'nnyxgy70' and status = 'pending'");
    console.log('=== GAOYUN PENDING APPROVALS ===');
    r.rows.forEach(x => console.log(JSON.stringify({ id: x.id, type: x.type, applicant: x.applicant_username, chain: x.chain })));
  } catch (e) {
    console.log('Error:', e.message);
  }

  // Check all approval types
  try {
    const r = await pool.query("select type, status, count(*) as cnt from approval_requests group by type, status order by type, status");
    console.log('=== APPROVAL COUNTS ===');
    r.rows.forEach(x => console.log(JSON.stringify(x)));
  } catch (e) {
    console.log('Error:', e.message);
  }

  pool.end();
})();
