const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgres://hrms:Abc1234567!@127.0.0.1:5432/hrms' });
(async () => {
  // Recent leave approvals
  const r = await pool.query("select id,type,status,applicant_username,chain from approval_requests where type='leave' order by created_at desc limit 3");
  console.log('=== RECENT LEAVE APPROVALS ===');
  r.rows.forEach(x => console.log(JSON.stringify({ id: x.id, status: x.status, applicant: x.applicant_username, chain: x.chain })));

  // Recent reward_punishment approvals
  const r2 = await pool.query("select id,type,status,applicant_username from approval_requests where type='reward_punishment' order by created_at desc limit 3");
  console.log('=== RECENT REWARD APPROVALS ===');
  r2.rows.forEach(x => console.log(JSON.stringify(x)));

  // All pending approvals
  const r3 = await pool.query("select id,type,status,applicant_username,current_assignee_username from approval_requests where status='pending' order by created_at desc limit 10");
  console.log('=== ALL PENDING ===');
  r3.rows.forEach(x => console.log(JSON.stringify(x)));

  // Check notifications for yufeng and xubin
  const sr = await pool.query("select data from hrms_state where key='default' limit 1");
  const d = sr.rows[0]?.data || {};
  const notifs = d.notifications || [];
  const yufengNotifs = notifs.filter(n => String(n?.to || '').toLowerCase().includes('yufeng') || String(n?.to || '').toLowerCase().includes('nnyxyf'));
  const xubinNotifs = notifs.filter(n => String(n?.to || '').toLowerCase().includes('xubin') || String(n?.to || '').toLowerCase().includes('nnyxxb'));
  console.log('=== YUFENG NOTIFICATIONS (last 3) ===');
  yufengNotifs.slice(-3).forEach(n => console.log(JSON.stringify({ to: n.to, title: n.title, createdAt: n.createdAt })));
  console.log('=== XUBIN NOTIFICATIONS (last 3) ===');
  xubinNotifs.slice(-3).forEach(n => console.log(JSON.stringify({ to: n.to, title: n.title, createdAt: n.createdAt })));

  // Check gaoyun username
  const emps = d.employees || [];
  const gaoyun = emps.find(e => (e.name || '').includes('高') && (e.name || '').includes('赟'));
  if (gaoyun) console.log('=== GAOYUN ===', JSON.stringify({ username: gaoyun.username, role: gaoyun.role }));

  pool.end();
})();
