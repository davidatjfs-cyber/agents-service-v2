const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgres://hrms:Abc1234567!@127.0.0.1:5432/hrms' });
(async () => {
  const sr = await pool.query("select data from hrms_state where key='default' limit 1");
  const d = sr.rows[0]?.data || {};
  const notifs = d.notifications || [];

  // Find notifications for yufeng (NNYXYF95) and xubin (NNYXXB13)
  const yfNotifs = notifs.filter(n => String(n?.targetUser || '').toUpperCase() === 'NNYXYF95');
  const xbNotifs = notifs.filter(n => String(n?.targetUser || '').toUpperCase() === 'NNYXXB13');
  console.log('=== YUFENG NOTIFS (' + yfNotifs.length + ') ===');
  yfNotifs.forEach(n => console.log(JSON.stringify({ title: n.title, type: n.type, createdAt: n.createdAt })));
  console.log('=== XUBIN NOTIFS (' + xbNotifs.length + ') ===');
  xbNotifs.forEach(n => console.log(JSON.stringify({ title: n.title, type: n.type, createdAt: n.createdAt })));

  // Find leave-related notifications
  const leaveNotifs = notifs.filter(n => String(n?.type || '').includes('leave'));
  console.log('=== LEAVE NOTIFS (' + leaveNotifs.length + ') ===');
  leaveNotifs.forEach(n => console.log(JSON.stringify({ targetUser: n.targetUser, title: n.title, createdAt: n.createdAt })));

  // Check renderProfileNotifications - what does it read?
  const anns = d.announcements || [];
  console.log('=== ANNOUNCEMENTS ===', anns.length);

  // Check attendance records
  const attRecs = await pool.query("select count(*) from information_schema.tables where table_name like '%attend%'");
  console.log('=== ATTENDANCE TABLES ===', attRecs.rows[0].count);

  // Check if there's attendance data in state
  const attKeys = Object.keys(d).filter(k => k.toLowerCase().includes('attend') || k.toLowerCase().includes('clock'));
  console.log('=== ATTENDANCE STATE KEYS ===', attKeys);

  pool.end();
})();
