/**
 * 营业日报「今日实际出勤」台账：在职与打卡、已通过休假比对；休息以日报为准；名册缺口检缺勤。
 */

function sumHrmsStaffPersonDays(arr) {
  const list = Array.isArray(arr) ? arr : [];
  let sum = 0;
  for (const x of list) {
    const d = Number(x?.days);
    if (Number.isFinite(d) && d > 0) sum += d;
    else sum += 1;
  }
  return Math.round(sum * 100) / 100;
}

function mergeDailyReportRestStaff(staffObj) {
  const so = staffObj && typeof staffObj === 'object' && !Array.isArray(staffObj) ? staffObj : {};
  const lists = [
    Array.isArray(so.restStaff) ? so.restStaff : [],
    Array.isArray(so.frontRestStaff) ? so.frontRestStaff : [],
    Array.isArray(so.kitchenRestStaff) ? so.kitchenRestStaff : []
  ];
  const seen = new Set();
  const out = [];
  for (const arr of lists) {
    for (const x of arr) {
      const u = String(x?.user || x?.username || '').trim().toLowerCase();
      const n = String(x?.name || '').trim();
      const key = u || n.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(x);
    }
  }
  return out;
}

function safeDateOnly(d) {
  const s = String(d || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

export function normalizeRegisterLineDetails(row) {
  let ld = row?.line_details;
  if (ld == null) return [];
  if (typeof ld === 'string') {
    try {
      ld = JSON.parse(ld);
    } catch {
      return [];
    }
  }
  return Array.isArray(ld) ? ld : [];
}

export function parseRegisterRowDateKey(row) {
  const v = row?.report_date;
  if (!v && v !== 0) return '';
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return String(v).trim().slice(0, 10);
}

function employeeTokenMatchesLine(ln, qLower) {
  if (!qLower) return true;
  const name = String(ln?.display_name || '').trim().toLowerCase();
  const user = String(ln?.username || '').trim().toLowerCase();
  return (name && name.includes(qLower)) || (user && user.includes(qLower));
}

/** GET 出勤表：按姓名关键词汇总在职/休息日历天数与人日 */
export function summarizeDailyRegisterForEmployee(rows, employeeRaw) {
  const q = String(employeeRaw || '').trim().toLowerCase();
  if (!q) return null;
  const workDates = new Set();
  const restDates = new Set();
  let workPd = 0;
  let restPd = 0;
  for (const row of rows || []) {
    const dateKey = parseRegisterRowDateKey(row);
    if (!dateKey) continue;
    const lines = normalizeRegisterLineDetails(row);
    for (const ln of lines) {
      if (!employeeTokenMatchesLine(ln, q)) continue;
      const kind = String(ln.kind || '');
      const d = Number(ln.declared_days);
      const pd = Number.isFinite(d) && d > 0 ? d : 1;
      if (kind === 'work') {
        workDates.add(dateKey);
        workPd += pd;
      } else if (kind === 'rest') {
        restDates.add(dateKey);
        restPd += pd;
      }
    }
  }
  const round2 = (x) => Math.round(x * 100) / 100;
  return {
    employee_query: String(employeeRaw || '').trim(),
    attendance_days: workDates.size,
    rest_days: restDates.size,
    attendance_person_days: round2(workPd),
    rest_person_days: round2(restPd),
    matched: workDates.size > 0 || restDates.size > 0
  };
}

/** 仅保留姓名匹配的明细行；无匹配行的日期整行剔除 */
export function filterDailyRegisterRowsByEmployee(rows, employeeRaw) {
  const q = String(employeeRaw || '').trim().toLowerCase();
  if (!q) return rows || [];
  const out = [];
  for (const row of rows || []) {
    const lines = normalizeRegisterLineDetails(row).filter((ln) => employeeTokenMatchesLine(ln, q));
    if (!lines.length) continue;
    out.push({ ...row, line_details: lines });
  }
  return out;
}

async function resolveNamesToUsernames(pool, store, nameList) {
  const names = [...new Set(nameList.map((n) => String(n || '').trim()).filter(Boolean))];
  const m = new Map();
  if (!names.length || !store) return m;
  try {
    const q = await pool.query(
      `SELECT LOWER(TRIM(username)) AS u, TRIM(name) AS name FROM employees
       WHERE TRIM(COALESCE(store, '')) ILIKE '%' || $1 || '%'
         AND TRIM(name) = ANY($2::text[])`,
      [store, names]
    );
    for (const row of q.rows || []) {
      const nm = String(row.name || '').trim();
      if (nm && row.u) m.set(nm, String(row.u || '').trim());
    }
  } catch {
    /* employees 表缺失或非致命 */
  }
  return m;
}

/** 门店在职员工名册（与日报门店名模糊匹配），用于「未列入出勤/休息」缺勤核对 */
async function fetchStoreActiveEmployeesUsernames(pool, store) {
  const st = String(store || '').trim();
  if (!st) return [];
  try {
    const q = await pool.query(
      `SELECT DISTINCT ON (LOWER(TRIM(username)))
          LOWER(TRIM(username)) AS u,
          TRIM(COALESCE(name, '')) AS name
       FROM employees
       WHERE TRIM(COALESCE(store, '')) ILIKE '%' || $1 || '%'
         AND TRIM(COALESCE(username, '')) <> ''
         AND (
           status IS NULL OR BTRIM(status) = ''
           OR LOWER(BTRIM(status)) NOT IN ('inactive', 'disabled', '离职', '禁用', '停用', 'left', 'resigned')
         )
         AND NOT COALESCE((extra_json->>'offboardingApproved')::boolean, false)
       ORDER BY LOWER(TRIM(username))`,
      [st]
    );
    return (q.rows || []).map((r) => ({
      u: String(r.u || '').trim(),
      name: String(r.name || '').trim()
    }));
  } catch {
    return [];
  }
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ store: string, brand?: string, reportDate: string, staffPayload?: object, laborTotal?: number }} opts
 */
export async function reconcileDailyReportAttendanceRegister(pool, opts) {
  const store = String(opts.store || '').trim();
  const reportDate = safeDateOnly(opts.reportDate);
  if (!store || !reportDate) return { ok: false, skipped: true };

  const brand = String(opts.brand || '').trim();
  const staffObj =
    opts.staffPayload && typeof opts.staffPayload === 'object' && !Array.isArray(opts.staffPayload)
      ? opts.staffPayload
      : {};
  const laborTotal = Number(opts.laborTotal || 0);

  const frontArr = Array.isArray(staffObj.front) ? staffObj.front : [];
  const kitchenArr = Array.isArray(staffObj.kitchen) ? staffObj.kitchen : [];
  const restMerged = mergeDailyReportRestStaff(staffObj);

  const frontPersonDays = sumHrmsStaffPersonDays(frontArr);
  const kitchenPersonDays = sumHrmsStaffPersonDays(kitchenArr);
  const restPersonDays = sumHrmsStaffPersonDays(restMerged);

  const nameNeedResolve = [];
  for (const e of [...frontArr, ...kitchenArr, ...restMerged]) {
    const u = String(e?.user || e?.username || '').trim();
    const n = String(e?.name || '').trim();
    if (!u && n) nameNeedResolve.push(n);
  }
  const nameMap = await resolveNamesToUsernames(pool, store, nameNeedResolve);

  function resolveUser(e) {
    const raw = String(e?.user || e?.username || '').trim();
    if (raw) return raw.toLowerCase();
    const n = String(e?.name || '').trim();
    return String(nameMap.get(n) || '').trim().toLowerCase();
  }

  const allUsernames = [];
  for (const e of [...frontArr, ...kitchenArr, ...restMerged]) {
    const u = resolveUser(e);
    if (u) allUsernames.push(u);
  }
  const onReportUsernames = new Set(allUsernames.filter(Boolean));

  /** 日报中出现过的姓名（小写）：休息人员可能未绑定 username，仍视为「已在日报中列出」 */
  const nameKeysOnReport = new Set();
  for (const e of [...frontArr, ...kitchenArr, ...restMerged]) {
    const n = String(e?.name || '').trim().toLowerCase();
    if (n) nameKeysOnReport.add(n);
  }

  const rosterRows = await fetchStoreActiveEmployeesUsernames(pool, store);
  const rosterUsernames = [...new Set(rosterRows.map((r) => r.u).filter(Boolean))];

  const uniqUsers = [...new Set([...onReportUsernames, ...rosterUsernames])];

  const clockSet = new Set();
  if (uniqUsers.length) {
    try {
      const cr = await pool.query(
        `SELECT DISTINCT LOWER(TRIM(username)) AS u
         FROM checkin_records
         WHERE (timezone('Asia/Shanghai', check_time))::date = $1::date
           AND LOWER(TRIM(username)) = ANY($2::text[])`,
        [reportDate, uniqUsers]
      );
      for (const row of cr.rows || []) clockSet.add(String(row.u || '').trim());
    } catch {
      /* checkin 不可用时不阻断台账写入 */
    }
  }

  const leaveMap = new Map();
  if (uniqUsers.length) {
    try {
      const lr = await pool.query(
        `SELECT LOWER(TRIM(username)) AS u, COUNT(*)::int AS c
         FROM hrms_leave_records
         WHERE status = 'approved'
           AND start_date <= $1::date AND end_date >= $1::date
           AND LOWER(TRIM(username)) = ANY($2::text[])
         GROUP BY LOWER(TRIM(username))`,
        [reportDate, uniqUsers]
      );
      for (const row of lr.rows || []) leaveMap.set(String(row.u || '').trim(), Number(row.c || 0));
    } catch {
      /* 休假表不可用 */
    }
  }

  const lineDetails = [];

  function pushWork(segment, e) {
    const displayName = String(e?.name || e?.user || e?.username || '').trim() || '—';
    const username = resolveUser(e);
    const declaredDays = Number(e?.days);
    const d = Number.isFinite(declaredDays) && declaredDays > 0 ? declaredDays : 1;
    const reasons = [];
    let status = 'verified';

    if (!username) {
      status = 'abnormal';
      reasons.push('缺少系统账号（无法在打卡与休假数据中比对）');
    } else if (d >= 0.5) {
      const leaveN = leaveMap.get(username) || 0;
      const hasClock = clockSet.has(username);
      if (leaveN > 0) {
        status = 'abnormal';
        reasons.push('日报填在职，但当日存在已通过休假记录');
      }
      if (!hasClock) {
        status = 'abnormal';
        reasons.push('日报填在职，当日无打卡记录');
      }
    }

    lineDetails.push({
      kind: 'work',
      role_segment: segment,
      username,
      display_name: displayName,
      declared_days: d,
      has_clock_in: username ? clockSet.has(username) : false,
      approved_leave_hits: username ? leaveMap.get(username) || 0 : 0,
      status,
      reasons
    });
  }

  function pushRest(e) {
    const displayName = String(e?.name || e?.user || e?.username || '').trim() || '—';
    const username = resolveUser(e);
    const declaredDays = Number(e?.days);
    const d = Number.isFinite(declaredDays) && declaredDays > 0 ? declaredDays : 1;

    // 休息以营业日报为准：本休/调休不要求休假审批；不校验打卡与休假库（有人休息时仍会打卡也不标异常）
    lineDetails.push({
      kind: 'rest',
      role_segment: 'rest',
      username,
      display_name: displayName,
      declared_days: d,
      has_clock_in: username ? clockSet.has(username) : false,
      approved_leave_hits: username ? leaveMap.get(username) || 0 : 0,
      status: 'verified',
      reasons: []
    });
  }

  for (const e of frontArr) pushWork('front', e);
  for (const e of kitchenArr) pushWork('kitchen', e);
  for (const e of restMerged) pushRest(e);

  const rosterByU = new Map(rosterRows.map((r) => [r.u, r.name]));
  for (const row of rosterRows) {
    const u = row.u;
    if (!u || onReportUsernames.has(u)) continue;
    const nm = String(row.name || '').trim().toLowerCase();
    if (nm && nameKeysOnReport.has(nm)) continue;

    const displayName = String(rosterByU.get(u) || u || '').trim() || u;
    const leaveN = leaveMap.get(u) || 0;
    const hasClock = clockSet.has(u);
    if (leaveN > 0) {
      lineDetails.push({
        kind: 'leave_only',
        role_segment: 'roster',
        username: u,
        display_name: displayName,
        declared_days: 0,
        has_clock_in: hasClock,
        approved_leave_hits: leaveN,
        status: 'verified',
        reasons: ['未列入日报出勤/休息，但当日有已通过休假记录']
      });
    } else {
      const reasons = ['门店名册中有此人，但日报未列入出勤或休息；且无已通过休假记录，视为缺勤'];
      if (hasClock) reasons.push('当日有打卡记录，请核对是否漏填出勤');
      lineDetails.push({
        kind: 'absent',
        role_segment: 'roster',
        username: u,
        display_name: displayName,
        declared_days: 0,
        has_clock_in: hasClock,
        approved_leave_hits: 0,
        status: 'abnormal',
        reasons
      });
    }
  }

  const anomalyCount = lineDetails.filter((x) => x.status !== 'verified').length;
  const overallStatus = anomalyCount === 0 ? 'verified' : 'abnormal';

  await pool.query(
    `INSERT INTO daily_report_attendance_register (
       store, brand, report_date, labor_total,
       front_person_days, kitchen_person_days, rest_person_days,
       staff_snapshot, line_details, overall_status, anomaly_count, updated_at
     ) VALUES (
       $1::text, $2::text, $3::date, $4,
       $5, $6, $7,
       $8::jsonb, $9::jsonb, $10, $11, NOW()
     )
     ON CONFLICT (store, report_date) DO UPDATE SET
       brand = EXCLUDED.brand,
       labor_total = EXCLUDED.labor_total,
       front_person_days = EXCLUDED.front_person_days,
       kitchen_person_days = EXCLUDED.kitchen_person_days,
       rest_person_days = EXCLUDED.rest_person_days,
       staff_snapshot = EXCLUDED.staff_snapshot,
       line_details = EXCLUDED.line_details,
       overall_status = EXCLUDED.overall_status,
       anomaly_count = EXCLUDED.anomaly_count,
       updated_at = NOW()`,
    [
      store,
      brand || null,
      reportDate,
      Number.isFinite(laborTotal) ? laborTotal : null,
      frontPersonDays,
      kitchenPersonDays,
      restPersonDays,
      JSON.stringify(staffObj),
      JSON.stringify(lineDetails),
      overallStatus,
      anomalyCount
    ]
  );

  return {
    ok: true,
    store,
    reportDate,
    overallStatus,
    anomalyCount,
    lines: lineDetails.length
  };
}

/**
 * 根据 PostgreSQL daily_reports 补缺 daily_report_attendance_register。
 * 上线前已写入 daily_reports、但当时未跑 reconcile 的历史行，会通过本函数补台账。
 *
 * @param {import('pg').Pool} pool
 * @param {{ maxRows?: number, start?: string, end?: string, store?: string, refreshExisting?: boolean }} [opts]
 */
export async function backfillDailyAttendanceRegisterMissing(pool, opts = {}) {
  const maxRows = Math.min(5000, Math.max(1, Number(opts.maxRows) || 800));
  const start = safeDateOnly(opts.start);
  const end = safeDateOnly(opts.end);
  const storeFilter = String(opts.store || '').trim();
  const refreshExisting = !!opts.refreshExisting;

  const params = [];
  let idx = 1;
  let extra = '';
  if (start && end) {
    extra += ` AND dr.date >= $${idx}::date AND dr.date <= $${idx + 1}::date`;
    params.push(start, end);
    idx += 2;
  } else if (start) {
    extra += ` AND dr.date >= $${idx}::date`;
    params.push(start);
    idx += 1;
  } else if (end) {
    extra += ` AND dr.date <= $${idx}::date`;
    params.push(end);
    idx += 1;
  } else {
    extra += ` AND dr.date >= (CURRENT_DATE - INTERVAL '550 days')`;
  }
  if (storeFilter) {
    extra += ` AND TRIM(dr.store) = TRIM($${idx}::text)`;
    params.push(storeFilter);
    idx += 1;
  }
  const limPlaceholder = idx;
  params.push(maxRows);

  const missingOrAll = refreshExisting ? 'TRUE' : 'ar.store IS NULL';

  const sql = `
    SELECT dr.store, dr.brand, dr.date::text AS report_date, dr.staff, dr.labor_total
    FROM daily_reports dr
    LEFT JOIN daily_report_attendance_register ar
      ON TRIM(dr.store) = TRIM(ar.store) AND dr.date::date = ar.report_date
    WHERE (${missingOrAll})${extra}
    ORDER BY dr.date DESC
    LIMIT $${limPlaceholder}`;

  const r = await pool.query(sql, params);
  let reconciled = 0;
  const errors = [];

  for (const row of r.rows || []) {
    try {
      let staffPayload = row.staff;
      if (staffPayload == null || staffPayload === '') staffPayload = {};
      else if (typeof staffPayload === 'string') {
        try {
          staffPayload = JSON.parse(staffPayload);
        } catch {
          staffPayload = {};
        }
      }
      if (typeof staffPayload !== 'object' || Array.isArray(staffPayload)) staffPayload = {};

      await reconcileDailyReportAttendanceRegister(pool, {
        store: String(row.store || '').trim(),
        brand: String(row.brand || '').trim(),
        reportDate: String(row.report_date || '').slice(0, 10),
        staffPayload,
        laborTotal: row.labor_total
      });
      reconciled++;
    } catch (e) {
      errors.push({
        store: row.store,
        date: row.report_date,
        message: String(e?.message || e)
      });
    }
  }

  return { scanned: (r.rows || []).length, reconciled, errors: errors.slice(0, 50) };
}
