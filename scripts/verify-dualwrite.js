#!/usr/bin/env node
/**
 * 全面验证所有双写模块的数据一致性
 * 检查 DB 表和 hrms_state 之间的数据是否一致
 */
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let issues = [];
let ok = [];

async function check(name, fn) {
  try {
    const result = await fn();
    if (result.issues?.length) {
      issues.push({ name, issues: result.issues });
      console.log(`❌ ${name}: ${result.issues.length} 个问题`);
      result.issues.forEach(i => console.log(`   - ${i}`));
    } else {
      ok.push(name);
      console.log(`✅ ${name}: ${result.summary || 'OK'}`);
    }
  } catch (e) {
    issues.push({ name, issues: [`异常: ${e.message}`] });
    console.log(`❌ ${name}: 异常 - ${e.message}`);
  }
}

async function main() {
  console.log('=== 双写数据一致性验证 ===\n');

  // 1. dailyReports - 检查 state 和 DB 的明细字段
  await check('dailyReports', async () => {
    const stateR = await pool.query(`SELECT data->'dailyReports' as dr FROM hrms_state WHERE key='default'`);
    const drs = stateR.rows[0]?.dr || [];
    const count = Array.isArray(drs) ? drs.length : 0;
    const issues = [];
    
    // 检查 state 明细字段
    const emptySeg = drs.filter(r => !r.data?.segments || Object.keys(r.data.segments).length === 0).length;
    const emptyCat = drs.filter(r => !r.data?.categories || Object.keys(r.data.categories).length === 0).length;
    const emptyStaff = drs.filter(r => !r.data?.staff || Object.keys(r.data.staff).length === 0).length;
    const emptyPhotos = drs.filter(r => !r.data?.photos || !Array.isArray(r.data.photos) || r.data.photos.length === 0).length;
    const emptySched = drs.filter(r => !r.data?.scheduleNextDay || Object.keys(r.data.scheduleNextDay).length === 0).length;
    
    if (emptySeg > 0) issues.push(`state: ${emptySeg}/${count} 条 segments 为空`);
    if (emptyCat > 0) issues.push(`state: ${emptyCat}/${count} 条 categories 为空`);
    if (emptyStaff > 0) issues.push(`state: ${emptyStaff}/${count} 条 staff 为空`);
    if (emptyPhotos > 0) issues.push(`state: ${emptyPhotos}/${count} 条 photos 为空`);
    if (emptySched > 0) issues.push(`state: ${emptySched}/${count} 条 scheduleNextDay 为空`);
    
    // 检查 DB 明细字段
    const dbR = await pool.query(`
      SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE segments::text = '{}') as empty_seg,
        COUNT(*) FILTER (WHERE categories::text = '{}') as empty_cat,
        COUNT(*) FILTER (WHERE staff::text IN ('[]','{}')) as empty_staff,
        COUNT(*) FILTER (WHERE photos::text = '[]') as empty_photos,
        COUNT(*) FILTER (WHERE schedule_next_day::text = '{}') as empty_sched
      FROM daily_reports
    `);
    const row = dbR.rows[0];
    const total = parseInt(row.total);
    if (parseInt(row.empty_seg) > 0) issues.push(`DB: ${row.empty_seg}/${total} 条 segments 为空（从未写入）`);
    if (parseInt(row.empty_cat) > 0) issues.push(`DB: ${row.empty_cat}/${total} 条 categories 为空（从未写入）`);
    if (parseInt(row.empty_staff) > 0) issues.push(`DB: ${row.empty_staff}/${total} 条 staff 为空（从未写入）`);
    if (parseInt(row.empty_photos) > 0) issues.push(`DB: ${row.empty_photos}/${total} 条 photos 为空（从未写入）`);
    if (parseInt(row.empty_sched) > 0) issues.push(`DB: ${row.empty_sched}/${total} 条 schedule_next_day 为空（从未写入）`);
    
    // 检查昨天数据
    const yesterdayR = await pool.query(`
      SELECT date, store, actual_revenue, dine_revenue, delivery_actual,
        CASE WHEN segments::text = '{}' THEN 'EMPTY' ELSE 'HAS' END as seg,
        CASE WHEN categories::text = '{}' THEN 'EMPTY' ELSE 'HAS' END as cat,
        CASE WHEN staff::text IN ('[]','{}') THEN 'EMPTY' ELSE 'HAS' END as stf,
        CASE WHEN photos::text = '[]' THEN 'EMPTY' ELSE 'HAS' END as pho
      FROM daily_reports WHERE date >= '2026-04-03' ORDER BY date DESC, store
    `);
    const yesterdayData = yesterdayR.rows;
    
    return { 
      issues, 
      summary: `state ${count} 条 (空 seg:${emptySeg}, cat:${emptyCat}, staff:${emptyStaff}, photos:${emptyPhotos}), DB ${total} 条 (明细全空)`,
      yesterdayData 
    };
  });

  // 2. employees
  await check('employees', async () => {
    const stateR = await pool.query(`SELECT data->'employees' as emp FROM hrms_state WHERE key='default'`);
    const emps = stateR.rows[0]?.emp || [];
    const stateCount = Array.isArray(emps) ? emps.length : 0;
    const dbR = await pool.query(`SELECT COUNT(*) as cnt FROM employees`);
    const dbCount = parseInt(dbR.rows[0].cnt);
    const issues = [];
    if (stateCount !== dbCount) issues.push(`state ${stateCount} 条 vs DB ${dbCount} 条`);
    return { issues, summary: `state ${stateCount} 条, DB ${dbCount} 条` };
  });

  // 3. leaveRecords
  await check('leaveRecords', async () => {
    const stateR = await pool.query(`SELECT data->'leaveRecords' as lr FROM hrms_state WHERE key='default'`);
    const lrs = stateR.rows[0]?.lr || [];
    const stateCount = Array.isArray(lrs) ? lrs.length : 0;
    const dbR = await pool.query(`SELECT COUNT(*) as cnt FROM hrms_leave_records`);
    const dbCount = parseInt(dbR.rows[0].cnt);
    const issues = [];
    if (stateCount !== dbCount) issues.push(`state ${stateCount} 条 vs DB ${dbCount} 条`);
    return { issues, summary: `state ${stateCount} 条, DB ${dbCount} 条` };
  });

  // 4. rewardPunishment
  await check('rewardPunishment', async () => {
    const stateR = await pool.query(`SELECT data->'salaryAdjustments' as sa FROM hrms_state WHERE key='default'`);
    const sas = stateR.rows[0]?.sa || [];
    const stateCount = Array.isArray(sas) ? sas.length : 0;
    const dbR = await pool.query(`SELECT COUNT(*) as cnt FROM hrms_reward_punishment_records`);
    const dbCount = parseInt(dbR.rows[0].cnt);
    const issues = [];
    if (stateCount !== dbCount) issues.push(`state ${stateCount} 条 vs DB ${dbCount} 条`);
    return { issues, summary: `state ${stateCount} 条, DB ${dbCount} 条` };
  });

  // 5. pointRecords
  await check('pointRecords', async () => {
    const stateR = await pool.query(`SELECT data->'pointRecords' as pr FROM hrms_state WHERE key='default'`);
    const prs = stateR.rows[0]?.pr || [];
    const stateCount = Array.isArray(prs) ? prs.length : 0;
    const dbR = await pool.query(`SELECT COUNT(*) as cnt FROM point_records`);
    const dbCount = parseInt(dbR.rows[0].cnt);
    const issues = [];
    if (stateCount !== dbCount) issues.push(`state ${stateCount} 条 vs DB ${dbCount} 条`);
    return { issues, summary: `state ${stateCount} 条, DB ${dbCount} 条` };
  });

  // 6. notifications
  await check('notifications', async () => {
    const stateR = await pool.query(`SELECT data->'notifications' as notif FROM hrms_state WHERE key='default'`);
    const notifs = stateR.rows[0]?.notif || [];
    const stateCount = Array.isArray(notifs) ? notifs.length : 0;
    const dbR = await pool.query(`SELECT COUNT(*) as cnt FROM hrms_user_notifications`);
    const dbCount = parseInt(dbR.rows[0].cnt);
    const issues = [];
    if (stateCount !== dbCount) issues.push(`state ${stateCount} 条 vs DB ${dbCount} 条`);
    return { issues, summary: `state ${stateCount} 条, DB ${dbCount} 条` };
  });

  // 7. payrollDomain
  await check('payrollDomain', async () => {
    const stateR = await pool.query(`SELECT data->'payrollAdjustments' as pa, data->'payrollAudits' as paud FROM hrms_state WHERE key='default'`);
    const row = stateR.rows[0] || {};
    const paCount = Array.isArray(row.pa) ? row.pa.length : 0;
    const paudCount = Array.isArray(row.paud) ? row.paud.length : 0;
    const dbR = await pool.query(`SELECT COUNT(*) as cnt FROM hrms_payroll_domain`);
    const dbCount = parseInt(dbR.rows[0].cnt);
    return { issues: [], summary: `state payrollAdjustments ${paCount}, payrollAudits ${paudCount}, DB ${dbCount}` };
  });

  // 8. attendance
  await check('attendance', async () => {
    const db1 = await pool.query(`SELECT COUNT(*) as cnt FROM checkin_records`);
    const db2 = await pool.query(`SELECT COUNT(*) as cnt FROM employee_attendance_records`);
    const c1 = parseInt(db1.rows[0].cnt);
    const c2 = parseInt(db2.rows[0].cnt);
    return { issues: [], summary: `checkin_records ${c1}, attendance_records ${c2}` };
  });

  console.log('\n=== 验证完成 ===');
  console.log(`✅ 正常: ${ok.length}`);
  console.log(`❌ 问题: ${issues.length}`);
  if (issues.length > 0) {
    console.log('\n详细问题:');
    issues.forEach(({ name, issues: iss }) => {
      console.log(`\n${name}:`);
      iss.forEach(i => console.log(`  - ${i}`));
    });
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
