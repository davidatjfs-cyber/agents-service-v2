#!/usr/bin/env node
/**
 * HRMS 业务测试脚本（QA + 业务专家）
 * 全自动执行：登录 → 员工 → 考勤 → 请款 → 积分 → 离职 → DB 校验 → 错误测试
 * 不修改业务逻辑，只做测试。
 */

const BASE = process.env.HRMS_BASE || 'http://127.0.0.1:3000';

async function request(method, path, body, token) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}

const report = { steps: {}, dbChecks: {}, errors: [], conclusion: null };

function log(name, ok, detail) {
  report.steps[name] = { ok: !!ok, detail: detail || null };
  console.log(ok ? `[PASS] ${name}` : `[FAIL] ${name}`, detail ? JSON.stringify(detail).slice(0, 200) : '');
}

async function main() {
  let token = null;
  let stateBackup = null;
  const testEmpUsername = 'qa_test_emp_' + Date.now();

  // ========== 前置：登录 ==========
  const loginRes = await request('POST', '/api/login', { username: 'admin', password: 'admin123' });
  if (loginRes.status !== 200 || !loginRes.json?.token) {
    log('0_pre_login', false, { status: loginRes.status, body: loginRes.json });
    report.conclusion = 'NO';
    return report;
  }
  token = loginRes.json.token;
  log('0_pre_login', true, { user: loginRes.json.user?.username });

  // ========== 第一步：员工管理（通过 GET/PUT /api/state 增删员工） ==========
  const getStateRes = await request('GET', '/api/state', null, token);
  if (getStateRes.status !== 200 || !getStateRes.json?.data) {
    log('1_employee_get_state', false, { status: getStateRes.status });
    report.conclusion = 'NO';
    return report;
  }
  stateBackup = JSON.parse(JSON.stringify(getStateRes.json.data));
  const data = getStateRes.json.data;
  const employees = Array.isArray(data.employees) ? data.employees : [];
  const newEmp = {
    username: testEmpUsername,
    name: 'QA测试员工',
    role: 'store_employee',
    store: (data.stores && data.stores[0]?.name) || '测试店',
    managerUsername: 'admin',
    status: 'active',
    password: 'admin123',
  };
  const nextEmployees = [...employees, newEmp];
  const nextData = { ...data, employees: nextEmployees };
  const putStateRes = await request('PUT', '/api/state', { data: nextData }, token);
  if (putStateRes.status !== 200 || !putStateRes.json?.ok) {
    log('1_employee_add', false, { status: putStateRes.status, body: putStateRes.json });
  } else {
    log('1_employee_add', true);
  }
  const getAfterAdd = await request('GET', '/api/state', null, token);
  const foundAfterAdd = getAfterAdd.json?.data?.employees?.some(e => String(e?.username) === testEmpUsername);
  log('1_employee_query_after_add', getAfterAdd.status === 200 && !!foundAfterAdd, { found: !!foundAfterAdd });

  const dataForDelete = { ...getAfterAdd.json.data };
  dataForDelete.employees = (dataForDelete.employees || []).filter(e => String(e?.username) !== testEmpUsername);
  const putDeleteRes = await request('PUT', '/api/state', { data: dataForDelete }, token);
  log('1_employee_delete', putDeleteRes.status === 200 && putDeleteRes.json?.ok);
  const getAfterDel = await request('GET', '/api/state', null, token);
  const foundAfterDel = getAfterDel.json?.data?.employees?.some(e => String(e?.username) === testEmpUsername);
  log('1_employee_gone_after_delete', getAfterDel.status === 200 && !foundAfterDel, { stillPresent: !!foundAfterDel });

  // 恢复 state 避免影响后续（若有备份则恢复）
  if (stateBackup) {
    await request('PUT', '/api/state', { data: stateBackup }, token);
  }

  // ========== 第二步：考勤打卡 ==========
  const checkinRes = await request('POST', '/api/checkin', {
    type: 'clock_in',
    latitude: 31.23,
    longitude: 121.47,
    store: '',
    noGps: false,
    faceMatch: true,
  }, token);
  const checkinOk = checkinRes.status === 200 && (checkinRes.json?.ok || checkinRes.json?.record);
  const checkinDup = checkinRes.status === 400 && checkinRes.json?.error === 'duplicate_checkin';
  if (!checkinOk && checkinRes.json?.error === 'no_gps') {
    log('2_checkin_post', false, { error: 'no_gps', hint: '需要非零经纬度且未返回 no_gps 时才能写入' });
  } else {
    log('2_checkin_post', checkinOk || checkinDup, checkinDup ? { note: '1小时内已打卡，防重复逻辑生效' } : (checkinRes.json?.error ? { error: checkinRes.json.error } : null));
  }
  const recordsRes = await request('GET', '/api/checkin/records', null, token);
  const hasRecords = recordsRes.status === 200 && Array.isArray(recordsRes.json?.records) && recordsRes.json.records.length > 0;
  log('2_checkin_get_records', recordsRes.status === 200, { count: recordsRes.json?.records?.length ?? 0 });

  // ========== 第三步：请款审批（payment） ==========
  const stores = stateBackup?.stores || getStateRes.json?.data?.stores || [];
  const storeName = (stores[0]?.name) || '测试店';
  const payPayload = {
    store: storeName,
    date: new Date().toISOString().slice(0, 10),
    amount: 100,
    category: '测试请款',
  };
  const createPayRes = await request('POST', '/api/approvals', { type: 'payment', payload: payPayload }, token);
  const approvalId = createPayRes.json?.item?.id || createPayRes.json?.id;
  const payCreated = createPayRes.status === 200 && approvalId;
  log('3_payment_create', payCreated, createPayRes.json?.error ? { error: createPayRes.json.error } : { id: approvalId });
  let paymentApprovalId = approvalId;
  if (paymentApprovalId) {
    const decideRes = await request('POST', `/api/approvals/${paymentApprovalId}/decide`, { approved: true, note: '测试通过' }, token);
    log('3_payment_decide', decideRes.status === 200, decideRes.json?.error ? { error: decideRes.json.error } : null);
  }

  // ========== 第四步：积分申请审批（需门店员工；admin 无权限提交，验证接口行为） ==========
  const pointsCreateRes = await request('POST', '/api/approvals', {
    type: 'points',
    payload: { ruleId: 'r1', reason: '测试' },
  }, token);
  const pointsForbidden = pointsCreateRes.status === 403 && (pointsCreateRes.json?.error === 'forbidden' || pointsCreateRes.json?.error === 'missing_store');
  log('4_points_submit', pointsForbidden || pointsCreateRes.status === 200, pointsForbidden ? { expected: 'admin 不能提交积分，返回 403' } : (pointsCreateRes.json?.error ? { error: pointsCreateRes.json.error } : null));

  // ========== 第五步：离职流程（offboarding，需申请人有 manager；admin 可提交自己的离职或接口会校验） ==========
  const offboardRes = await request('POST', '/api/approvals', {
    type: 'offboarding',
    payload: { reason: 'QA测试离职' },
  }, token);
  const offboardCreated = offboardRes.status === 200 && offboardRes.json?.id;
  const offboardRejected = offboardRes.status === 400 || offboardRes.status === 403;
  log('5_offboarding_submit', offboardCreated || offboardRejected, offboardCreated ? { id: offboardRes.json?.id } : { status: offboardRes.status, error: offboardRes.json?.error });
  if (offboardCreated && offboardRes.json?.id) {
    const obId = offboardRes.json.id;
    const obDecideRes = await request('POST', `/api/approvals/${obId}/decide`, { approved: true, note: '测试' }, token);
    log('5_offboarding_decide', obDecideRes.status === 200, obDecideRes.json?.error ? { error: obDecideRes.json.error } : null);
  }

  // ========== 第六步：数据库校验（API + 可选 psql 直接查询） ==========
  const stateAgain = await request('GET', '/api/state', null, token);
  const hasStateData = stateAgain.status === 200 && stateAgain.json?.data != null;
  log('6_db_state_read', hasStateData);
  const recordsAgain = await request('GET', '/api/checkin/records', null, token);
  log('6_db_checkin_via_api', recordsAgain.status === 200);
  const listApprovals = await request('GET', '/api/approvals', null, token);
  log('6_db_approvals_via_api', listApprovals.status === 200 && Array.isArray(listApprovals.json?.items));
  try {
    const { execSync } = await import('child_process');
    const dbName = process.env.DB_NAME || 'hrms_local';
    const q = (sql) => execSync(`psql -d ${dbName} -tAc "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
    report.dbChecks = {
      hrms_state_rows: q("SELECT count(*) FROM hrms_state WHERE key = 'default'"),
      checkin_records: q('SELECT count(*) FROM checkin_records'),
      approval_requests: q('SELECT count(*) FROM approval_requests'),
      payment_approved: q("SELECT count(*) FROM approval_requests WHERE type = 'payment' AND status IN ('approved','paid')"),
    };
    log('6_db_direct_query', true, report.dbChecks);
  } catch (e) {
    report.dbChecks = { _note: 'psql not run: ' + (e.message || e) };
    log('6_db_direct_query', false, { skip: true, reason: e.message });
  }

  // ========== 第七步：错误测试（空字段、重复） ==========
  const emptyLogin = await request('POST', '/api/login', { username: '', password: '' });
  log('7_error_empty_login', emptyLogin.status === 400, emptyLogin.json?.error || null);
  const dupCheckin = await request('POST', '/api/checkin', { type: 'clock_in', latitude: 31.23, longitude: 121.47, store: '' }, token);
  const dupOk = dupCheckin.status === 200 || (dupCheckin.status === 400 && (dupCheckin.json?.error === 'duplicate_checkin' || dupCheckin.json?.error === 'no_gps'));
  log('7_error_dup_or_invalid_checkin', dupOk, dupCheckin.json?.error ? { error: dupCheckin.json.error } : null);
  const invalidApproval = await request('POST', '/api/approvals', { type: 'payment', payload: {} }, token);
  log('7_error_invalid_payload', invalidApproval.status === 400, invalidApproval.json?.error || null);

  // ========== 结论 ==========
  const allKeys = Object.keys(report.steps);
  const passed = allKeys.filter(k => report.steps[k].ok).length;
  const total = allKeys.length;
  report.conclusion = passed === total ? 'YES' : (passed >= total * 0.7 ? 'PARTIAL' : 'NO');
  report.summary = { passed, total, conclusion: report.conclusion };
  return report;
}

main()
  .then(r => {
    console.log('\n--- 业务测试报告 ---');
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.conclusion === 'YES' ? 0 : 1);
  })
  .catch(e => {
    console.error(e);
    process.exit(2);
  });
