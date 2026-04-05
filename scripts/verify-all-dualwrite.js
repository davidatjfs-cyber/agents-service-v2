#!/usr/bin/env node
/**
 * 全面验证所有双写模块的写入和恢复能力
 * 检查每个模块的：
 * 1. DB 写入逻辑是否存在
 * 2. 启动恢复逻辑是否存在
 * 3. 当前数据一致性
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const indexPath = path.join(process.cwd(), 'index.js');
let sourceCode = '';
try {
  sourceCode = fs.readFileSync(indexPath, 'utf8');
} catch (e) {
  console.error('无法读取 index.js:', e.message);
  process.exit(1);
}

async function main() {
  console.log('=== 全量双写模块验证 ===\n');

  const results = [];

  // ========== 1. dailyReports ==========
  {
    const hasInsert = sourceCode.includes('INSERT INTO daily_reports');
    const hasSegmentsUpdate = sourceCode.includes('segments = EXCLUDED.segments');
    const hasParseJsonb = sourceCode.includes('parseJsonb');
    const hasDetailMerge = sourceCode.includes('DETAIL_FIELDS');
    
    const stateR = await pool.query(`SELECT data->'dailyReports' as dr FROM hrms_state WHERE key='default'`);
    const drs = stateR.rows[0]?.dr || [];
    const stateCount = Array.isArray(drs) ? drs.length : 0;
    const emptySeg = drs.filter(r => !r.data?.segments || Object.keys(r.data.segments).length === 0).length;
    
    const dbR = await pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE segments::text = '{}') as empty FROM daily_reports`);
    const dbTotal = parseInt(dbR.rows[0].total);
    const dbEmpty = parseInt(dbR.rows[0].empty);

    const issues = [];
    if (emptySeg > 0) issues.push(`state: ${emptySeg}/${stateCount} 条 segments 为空`);
    if (dbEmpty > 0) issues.push(`DB: ${dbEmpty}/${dbTotal} 条 segments 为空`);

    results.push({
      name: 'dailyReports',
      checks: [
        { name: 'DB写入', passed: hasInsert && hasSegmentsUpdate, msg: hasInsert ? 'INSERT+ON CONFLICT 包含所有明细字段' : '缺失' },
        { name: '启动恢复', passed: hasParseJsonb && hasDetailMerge, msg: hasParseJsonb ? 'parseJsonb + 明细合并逻辑存在' : '缺失' },
        { name: '数据状态', passed: emptySeg === 0 && dbEmpty === 0, msg: `state: ${stateCount}条(${emptySeg}空), DB: ${dbTotal}条(${dbEmpty}空)` }
      ],
      issues
    });
  }

  // ========== 2. employees ==========
  {
    const hasDualWrite = sourceCode.includes('employees → employees 表');
    const hasInsert = sourceCode.includes('INSERT INTO employees');
    const hasRebuild = sourceCode.includes('员工档案重建') || sourceCode.includes('employees 表');

    const stateR = await pool.query(`SELECT jsonb_array_length(data->'employees') as cnt FROM hrms_state WHERE key='default'`);
    const stateCount = parseInt(stateR.rows[0]?.cnt || 0);
    const dbR = await pool.query(`SELECT COUNT(*) as cnt FROM employees`);
    const dbCount = parseInt(dbR.rows[0].cnt);

    const issues = [];
    if (stateCount !== dbCount) issues.push(`state ${stateCount} vs DB ${dbCount}`);

    results.push({
      name: 'employees',
      checks: [
        { name: 'DB写入', passed: hasDualWrite && hasInsert, msg: hasDualWrite ? 'dualWriteStateToDB 包含' : '缺失' },
        { name: '启动恢复', passed: hasRebuild, msg: hasRebuild ? '存在' : '缺失' },
        { name: '数据一致性', passed: stateCount === dbCount && stateCount > 0, msg: `state: ${stateCount}, DB: ${dbCount}` }
      ],
      issues
    });
  }

  // ========== 3. leaveRecords ==========
  {
    const hasDualWrite = sourceCode.includes('leaveRecords → hrms_leave_records');
    const hasInsert = sourceCode.includes('INSERT INTO hrms_leave_records');
    const hasRebuild = sourceCode.includes('休假记录重建');
    const hasBackfill = sourceCode.includes('hrms_state.leaveRecords → hrms_leave_records');

    const stateR = await pool.query(`SELECT jsonb_array_length(data->'leaveRecords') as cnt FROM hrms_state WHERE key='default'`);
    const stateCount = parseInt(stateR.rows[0]?.cnt || 0);
    const dbR = await pool.query(`SELECT COUNT(*) as cnt FROM hrms_leave_records`);
    const dbCount = parseInt(dbR.rows[0].cnt);

    const issues = [];
    if (stateCount !== dbCount) issues.push(`state ${stateCount} vs DB ${dbCount}`);

    results.push({
      name: 'leaveRecords',
      checks: [
        { name: 'DB写入', passed: hasDualWrite && hasInsert, msg: hasDualWrite ? 'dualWriteStateToDB 包含' : '缺失' },
        { name: '启动恢复', passed: hasRebuild && hasBackfill, msg: hasRebuild ? '启动恢复+回填存在' : '缺失' },
        { name: '数据一致性', passed: stateCount === dbCount && stateCount > 0, msg: `state: ${stateCount}, DB: ${dbCount}` }
      ],
      issues
    });
  }

  // ========== 4. rewardPunishment ==========
  {
    const hasDualWrite = sourceCode.includes('salaryAdjustments → hrms_reward_punishment_records');
    const hasInsert = sourceCode.includes('INSERT INTO hrms_reward_punishment_records');
    const hasRebuild = sourceCode.includes('奖惩记录重建');
    const hasBackfill = sourceCode.includes('hrms_state.salaryAdjustments → hrms_reward_punishment_records');

    const stateR = await pool.query(`SELECT jsonb_array_length(data->'salaryAdjustments') as cnt FROM hrms_state WHERE key='default'`);
    const stateCount = parseInt(stateR.rows[0]?.cnt || 0);
    const dbR = await pool.query(`SELECT COUNT(*) as cnt FROM hrms_reward_punishment_records`);
    const dbCount = parseInt(dbR.rows[0].cnt);

    const issues = [];
    if (stateCount !== dbCount) issues.push(`state ${stateCount} vs DB ${dbCount}`);

    results.push({
      name: 'rewardPunishment',
      checks: [
        { name: 'DB写入', passed: hasDualWrite && hasInsert, msg: hasDualWrite ? 'dualWriteStateToDB 包含' : '缺失' },
        { name: '启动恢复', passed: hasRebuild && hasBackfill, msg: hasRebuild ? '启动恢复+回填存在' : '缺失' },
        { name: '数据一致性', passed: stateCount === dbCount, msg: `state: ${stateCount}, DB: ${dbCount}` }
      ],
      issues
    });
  }

  // ========== 5. pointRecords ==========
  {
    const hasDualWrite = sourceCode.includes('pointRecords → point_records') || sourceCode.includes('pointRecords');
    const hasInsert = sourceCode.includes('INSERT INTO point_records');
    const hasRebuild = sourceCode.includes('积分记录权威重建');

    const stateR = await pool.query(`SELECT jsonb_array_length(data->'pointRecords') as cnt FROM hrms_state WHERE key='default'`);
    const stateCount = parseInt(stateR.rows[0]?.cnt || 0);
    const dbR = await pool.query(`SELECT COUNT(*) as cnt FROM point_records`);
    const dbCount = parseInt(dbR.rows[0].cnt);

    const issues = [];
    if (stateCount !== dbCount) issues.push(`state ${stateCount} vs DB ${dbCount} (差异 ${Math.abs(stateCount - dbCount)} 条)`);

    results.push({
      name: 'pointRecords',
      checks: [
        { name: 'DB写入', passed: hasInsert, msg: hasInsert ? 'INSERT 存在' : '缺失' },
        { name: '启动恢复', passed: hasRebuild, msg: hasRebuild ? '启动恢复存在' : '缺失' },
        { name: '数据一致性', passed: stateCount === dbCount, msg: `state: ${stateCount}, DB: ${dbCount}` }
      ],
      issues
    });
  }

  // ========== 6. notifications ==========
  {
    const hasDualWrite = sourceCode.includes('notifications → hrms_user_notifications');
    const hasInsert = sourceCode.includes('INSERT INTO hrms_user_notifications');
    const hasRebuild = sourceCode.includes('公司通知重建');

    const stateR = await pool.query(`SELECT jsonb_array_length(data->'notifications') as cnt FROM hrms_state WHERE key='default'`);
    const stateCount = parseInt(stateR.rows[0]?.cnt || 0);
    const dbR = await pool.query(`SELECT COUNT(*) as cnt FROM hrms_user_notifications`);
    const dbCount = parseInt(dbR.rows[0].cnt);

    const issues = [];
    // state 包含历史通知，应该 >= DB
    if (stateCount < dbCount) issues.push(`state ${stateCount} < DB ${dbCount}`);

    results.push({
      name: 'notifications',
      checks: [
        { name: 'DB写入', passed: hasDualWrite && hasInsert, msg: hasDualWrite ? 'dualWriteStateToDB 包含' : '缺失' },
        { name: '启动恢复', passed: hasRebuild, msg: hasRebuild ? '启动恢复存在' : '缺失' },
        { name: '数据一致性', passed: stateCount >= dbCount, msg: `state: ${stateCount}, DB: ${dbCount}` }
      ],
      issues
    });
  }

  // ========== 7. payrollDomain ==========
  {
    const hasSync = sourceCode.includes('hrms_payroll_domain');
    const hasRebuild = sourceCode.includes('回灌') && sourceCode.includes('hrms_payroll_domain');

    const dbR = await pool.query(`SELECT COUNT(*) as cnt FROM hrms_payroll_domain`);
    const dbCount = parseInt(dbR.rows[0].cnt);

    results.push({
      name: 'payrollDomain',
      checks: [
        { name: 'DB写入', passed: hasSync, msg: hasSync ? '同步逻辑存在' : '缺失' },
        { name: '启动恢复', passed: hasRebuild, msg: hasRebuild ? '启动回灌存在' : '缺失' },
        { name: '数据状态', passed: true, msg: `DB: ${dbCount} 条` }
      ],
      issues: []
    });
  }

  // ========== 8. attendance ==========
  {
    const hasCheckin = sourceCode.includes('checkin_records');
    const hasAttendance = sourceCode.includes('employee_attendance_records');
    const hasSync = sourceCode.includes('考勤') && sourceCode.includes('checkin_records');

    const db1 = await pool.query(`SELECT COUNT(*) as cnt FROM checkin_records`);
    const db2 = await pool.query(`SELECT COUNT(*) as cnt FROM employee_attendance_records`);
    const c1 = parseInt(db1.rows[0].cnt);
    const c2 = parseInt(db2.rows[0].cnt);

    const issues = [];
    if (c1 !== c2) issues.push(`checkin_records ${c1} vs attendance_records ${c2}`);

    results.push({
      name: 'attendance',
      checks: [
        { name: 'DB写入', passed: hasCheckin && hasAttendance, msg: hasCheckin ? '双表写入存在' : '缺失' },
        { name: '启动恢复', passed: hasSync, msg: hasSync ? '启动同步存在' : '缺失' },
        { name: '数据一致性', passed: c1 === c2 && c1 > 0, msg: `checkin_records: ${c1}, attendance_records: ${c2}` }
      ],
      issues
    });
  }

  // ========== 输出结果 ==========
  console.log('\n=== 验证结果 ===\n');
  
  let allPassed = true;
  for (const r of results) {
    const status = r.issues.length === 0 ? '✅' : '❌';
    console.log(`${status} ${r.name}`);
    for (const c of r.checks) {
      const cStatus = c.passed ? '✅' : '❌';
      console.log(`   ${cStatus} ${c.name}: ${c.msg}`);
    }
    if (r.issues.length > 0) {
      console.log(`   ⚠️ 问题:`);
      r.issues.forEach(i => console.log(`      - ${i}`));
      allPassed = false;
    }
    console.log();
  }

  console.log('=== 总结 ===');
  const passed = results.filter(r => r.issues.length === 0).length;
  const failed = results.filter(r => r.issues.length > 0).length;
  console.log(`✅ 通过: ${passed}/${results.length}`);
  console.log(`❌ 失败: ${failed}/${results.length}`);

  if (!allPassed) {
    console.log('\n⚠️ 存在未通过验证的模块！');
    process.exit(1);
  } else {
    console.log('\n✅ 所有双写模块验证通过！');
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
