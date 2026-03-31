const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgres://hrms:Abc1234567!@127.0.0.1:5432/hrms' });
(async () => {
  const sr = await pool.query("select data from hrms_state where key='default' limit 1");
  const d = sr.rows[0]?.data || {};

  // Check all notification keys
  const keys = Object.keys(d).filter(k => k.toLowerCase().includes('notif'));
  console.log('=== NOTIFICATION KEYS ===', keys);

  // Check notifications structure
  const notifs = d.notifications || [];
  console.log('Total notifications:', notifs.length);
  if (notifs.length > 0) {
    console.log('Sample:', JSON.stringify(notifs[notifs.length - 1]));
  }

  // Check if there's a separate notifications table
  try {
    const r = await pool.query("select count(*) from information_schema.tables where table_name like '%notif%'");
    console.log('Notification tables:', r.rows[0].count);
  } catch (e) {}

  // Check yufeng username exactly
  const emps = d.employees || [];
  const yf = emps.find(e => (e.name || '').includes('喻峰'));
  if (yf) console.log('=== YUFENG ===', JSON.stringify({ username: yf.username, name: yf.name, managerUsername: yf.managerUsername }));

  const xb = emps.find(e => (e.name || '').includes('徐彬') && String(e.role || '') !== 'store_employee');
  if (xb) console.log('=== XUBIN ===', JSON.stringify({ username: xb.username, name: xb.name, role: xb.role }));

  // Check the leave approval details
  const lr = await pool.query("select id,type,status,applicant_username,chain,payload from approval_requests where id='4999190f-df2c-4d7e-ac15-fe20c4bdb2cb'");
  if (lr.rows[0]) {
    console.log('=== LEAVE DETAIL ===');
    console.log('payload:', JSON.stringify(lr.rows[0].payload));
  }

  // Check leaveRecords
  const leaveRecs = d.leaveRecords || [];
  console.log('=== LEAVE RECORDS ===', leaveRecs.length);
  leaveRecs.slice(-2).forEach(r => console.log(JSON.stringify({ id: r.id, applicant: r.applicant, status: r.status, startDate: r.startDate, endDate: r.endDate })));

  pool.end();
})();
