/**
 * AI 营运诊断（第一阶段）
 * 只做分析+建议，不修改业务、不执行操作。
 * 数据来源：HRMS 营业日报(daily_reports) + 飞书(桌访/差评)，本地 Ollama gemma4:26b。
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_OPERATIONS_MODEL || 'gemma4:26b';

/** 从 DB 读取指定日期的营业日报，组装为按门店的 daily_operation_summary 列表 */
export async function buildDailyOperationSummaries(dateStr, opts = {}) {
  const date = String(dateStr || '').trim() || new Date().toISOString().slice(0, 10);
  const storeFilter = String(opts?.store || '').trim();
  const summaries = [];

  // 1) 营业日报：门店、日期、营收、目标、可选出勤/排班相关
  let reportRows = [];
  try {
    const params = [date];
    let sql = `SELECT store, date::text AS date,
              COALESCE(actual_revenue, 0)::numeric(12,2) AS revenue,
              COALESCE(target_revenue, 0)::numeric(12,2) AS target,
              COALESCE(dine_orders, 0) AS dine_orders,
              actual_margin, target_margin, dianping_rating
       FROM daily_reports
       WHERE date = $1::date`;
    if (storeFilter) {
      sql += ` AND store = $2`;
      params.push(storeFilter);
    }
    sql += ` ORDER BY store`;
    const r = await query(sql, params);
    reportRows = r.rows || [];
  } catch (e) {
    logger.warn({ err: e?.message, date }, 'ai-operations: daily_reports query failed');
  }

  // 2) 出勤/排班：schedules 表若存在则按门店汇总
  let scheduleByStore = {};
  try {
    const params = [date];
    let sql = `SELECT store, employee_username, status
       FROM schedules
       WHERE shift_date = $1::date`;
    if (storeFilter) {
      sql += ` AND store = $2`;
      params.push(storeFilter);
    }
    sql += ` ORDER BY store, employee_username`;
    const s = await query(sql, params);
    const rows = s.rows || [];
    for (const row of rows) {
      const st = String(row.store || '').trim() || '未知';
      if (!scheduleByStore[st]) scheduleByStore[st] = { attendance: [], schedule: [] };
      scheduleByStore[st].schedule.push({
        employee: row.employee_username,
        status: row.status
      });
      if (String(row.status).toLowerCase() === 'present') {
        scheduleByStore[st].attendance.push({ employee: row.employee_username, status: row.status });
      }
    }
  } catch (e) {
    logger.warn({ err: e?.message, date }, 'ai-operations: schedules query failed (table may not exist)');
  }

  // 3) 飞书：桌访(正向)、差评(负向)，按门店+日期过滤
  let positiveByStore = {};
  let negativeByStore = {};
  try {
    const [tRes, bRes] = await Promise.all([
      query(
        `SELECT fields, created_at FROM feishu_generic_records WHERE config_key = 'table_visit' ORDER BY updated_at DESC LIMIT 2000`
      ),
      query(
        `SELECT fields, created_at FROM feishu_generic_records WHERE config_key = 'bad_review' ORDER BY updated_at DESC LIMIT 2000`
      )
    ]);
    const toDate = (v, fallback) => {
      if (v == null || v === '') {
        if (fallback && fallback.toISOString) return fallback.toISOString().slice(0, 10);
        return null;
      }
      // 飞书多维表常见毫秒时间戳
      if (typeof v === 'number' && Number.isFinite(v)) {
        return new Date(v).toISOString().slice(0, 10);
      }
      if (typeof v === 'string') {
        if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
        if (/^\d{10,13}$/.test(v)) {
          const n = Number(v);
          const ms = v.length === 13 ? n : n * 1000;
          return new Date(ms).toISOString().slice(0, 10);
        }
      }
      if (v && typeof v.toISOString === 'function') return v.toISOString().slice(0, 10);
      if (fallback && fallback.toISOString) return fallback.toISOString().slice(0, 10);
      return null;
    };
    const ext = (x) => (x != null && typeof x === 'string' ? x.trim() : Array.isArray(x) ? (x[0] != null ? String(x[0]).trim() : '') : '');
    const sameDate = (rowDate, target) => {
      const d = toDate(rowDate, rowDate) || (rowDate && rowDate.toISOString && rowDate.toISOString().slice(0, 10));
      return d === target;
    };
    const targetDate = date;

    for (const row of (tRes.rows || [])) {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const storeName = ext(f['门店'] || f['所属门店'] || f['store']);
      if (!storeName) continue;
      if (storeFilter && storeName !== storeFilter) continue;
      const rowDate = f['日期'] || f['创建日期'] || f['提交时间'] || row.created_at;
      if (!sameDate(rowDate, targetDate)) continue;
      if (!positiveByStore[storeName]) positiveByStore[storeName] = [];
      positiveByStore[storeName].push({
        summary:
          ext(
            f['用餐满意度'] ||
              f['今天用餐是否满意'] ||
              f['满意度'] ||
              f['反馈']
          ) || '桌访反馈',
        reason: ext(f['满意/不满意的主要原因'] || f['满意或不满意的主要原因是什么？'] || f['原因']),
        at: row.created_at
      });
    }
    for (const row of (bRes.rows || [])) {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const storeName = ext(f['差评门店'] || f['门店'] || f['所属门店']);
      if (!storeName) continue;
      if (storeFilter && storeName !== storeFilter) continue;
      const rowDate = f['日期'] || f['评价日期'] || f['创建日期'] || row.created_at;
      if (!sameDate(rowDate, targetDate)) continue;
      if (!negativeByStore[storeName]) negativeByStore[storeName] = [];
      negativeByStore[storeName].push({
        summary: ext(f['差评原因'] || f['评价内容'] || f['content']) || '差评',
        product: ext(f['差评产品']),
        platform: ext(f['差评平台'])
      });
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'ai-operations: feishu_generic_records query failed');
  }

  // 4) 按门店组装：有日报的门店一条 summary；无日报则仅当有排班/反馈时也生成一条
  const storeSet = new Set(reportRows.map(r => String(r.store || '').trim()));
  for (const k of Object.keys(scheduleByStore)) storeSet.add(k);
  for (const k of Object.keys(positiveByStore)) storeSet.add(k);
  for (const k of Object.keys(negativeByStore)) storeSet.add(k);

  for (const store of storeSet) {
    if (!store) continue;
    const report = reportRows.find(r => String(r.store || '').trim() === store);
    const rev = report ? String(Number(report.revenue)) : '';
    const target = report ? String(Number(report.target)) : '';
    const sch = scheduleByStore[store];
    summaries.push({
      store,
      date,
      revenue: rev,
      target,
      attendance: sch ? sch.attendance : [],
      schedule: sch ? sch.schedule : [],
      feedback_positive: positiveByStore[store] || [],
      feedback_negative: negativeByStore[store] || []
    });
  }

  return summaries;
}

/** 调用本地 Ollama 做营运诊断分析，返回规定格式的 JSON */
export async function runAIOperationsAnalysis(summaries) {
  const payload = JSON.stringify(summaries, null, 2);
  const lowAchievementStores = getLowAchievementStores(summaries, 80);
  const systemPrompt = `你是餐饮连锁公司营运总监，不是分析师。
你的任务是给出“可执行指令”，而不是总结数据。
每一条建议都必须具体到岗位、动作、时间和结果指标。
根据下面各门店的当日营业汇总数据，只做分析+决策建议，不执行任何操作。
请严格按以下 JSON 格式输出，不要包含其它说明或 markdown 代码块：
{
  "core_problem": "一句话核心问题",
  "top_3_issues": ["问题1", "问题2", "问题3"],
  "root_causes": ["原因1", "原因2"],
  "actions": [
    {
      "role": "店长/服务员/后厨/值班经理等",
      "action": "具体可执行动作",
      "deadline": "今天/本周/明日午高峰前等",
      "metric": "可量化结果指标"
    }
  ],
  "warnings": ["风险提示1"]
}
规则：
1. top_3_issues 必须最多3条，按优先级排序。
2. actions 必须是“可执行动作”，禁止抽象词（如“加强管理”“提升服务质量”“优化流程”）。
3. 每条 action 必须包含 role/action/deadline/metric 四个字段，且非空。
4. 如果存在门店达成率<80%，必须至少输出3条 actions。
5. warnings 仅输出需要管理层关注的风险。
若某项没有则用空数组 []。只输出上述 JSON，不要前后文字。`;

  const userPrompt = `当日营业汇总数据（JSON）：
${payload}

达成率低于80%的门店（若有）：${JSON.stringify(lowAchievementStores)}

请输出“可执行决策”JSON。`;

  try {
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Ollama HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    const raw = (data.message && data.message.content) ? data.message.content.trim() : '';
    const parsed = parseStrictReport(raw);
    return enforceDecisionRules(parsed, summaries);
  } catch (e) {
    logger.error({ err: e?.message }, 'ai-operations: Ollama call failed');
    const fallback = defaultDecisionReport();
    fallback.warnings.push('AI暂时不可用');
    fallback._error = e.message;
    return enforceDecisionRules(fallback, summaries);
  }
}

/** 从模型返回文本中解析出严格格式的 report，兼容被 markdown 包裹的情况 */
function parseStrictReport(raw) {
  const fallback = defaultDecisionReport();
  let str = raw;
  const jsonBlock = /```(?:json)?\s*([\s\S]*?)```/.exec(str);
  if (jsonBlock) str = jsonBlock[1].trim();
  const start = str.indexOf('{');
  if (start !== -1) str = str.slice(start);
  const end = str.lastIndexOf('}');
  if (end !== -1) str = str.slice(0, end + 1);
  try {
    const o = JSON.parse(str);
    return {
      core_problem: safeText(o.core_problem),
      top_3_issues: toStringArray(o.top_3_issues).slice(0, 3),
      root_causes: toStringArray(o.root_causes),
      actions: normalizeActions(o.actions),
      warnings: toStringArray(o.warnings)
    };
  } catch (e) {
    logger.warn({ err: e?.message, raw: str.slice(0, 300) }, 'ai-operations: parse report failed');
    return fallback;
  }
}

function defaultDecisionReport() {
  return {
    core_problem: '',
    top_3_issues: [],
    root_causes: [],
    actions: [],
    warnings: []
  };
}

function safeText(v) {
  return String(v || '').trim();
}

function toStringArray(v) {
  return Array.isArray(v) ? v.map(x => String(x || '').trim()).filter(Boolean) : [];
}

function normalizeActions(v) {
  if (!Array.isArray(v)) return [];
  return v.map((item) => {
    const rec = item && typeof item === 'object' ? item : {};
    return {
      role: safeText(rec.role),
      action: safeText(rec.action),
      deadline: safeText(rec.deadline),
      metric: safeText(rec.metric)
    };
  }).filter(a => a.role && a.action && a.deadline && a.metric);
}

function getLowAchievementStores(summaries, thresholdPercent) {
  const out = [];
  for (const s of (Array.isArray(summaries) ? summaries : [])) {
    const revenue = Number(s?.revenue || 0);
    const target = Number(s?.target || 0);
    if (!(target > 0)) continue;
    const rate = (revenue / target) * 100;
    if (rate < thresholdPercent) {
      out.push({
        store: String(s?.store || '').trim() || '未知门店',
        achievement_rate: Number(rate.toFixed(2))
      });
    }
  }
  return out;
}

function buildMandatoryActions(storeName) {
  const s = storeName || '重点门店';
  return [
    {
      role: '店长',
      action: `${s}今日闭店前复盘低达成时段，拆分午市/晚市掉单原因并形成整改清单`,
      deadline: '今天闭店前',
      metric: '次日营业额较昨日提升5%以上'
    },
    {
      role: '服务员',
      action: `${s}在晚高峰每桌加做1次主动回访，记录不满意点并当场补救`,
      deadline: '今天晚高峰',
      metric: '当日差评数为0，桌访满意反馈不少于5条'
    },
    {
      role: '后厨',
      action: `${s}本周内对出餐超时菜品做预制与工位调整，峰值时段每30分钟检查一次出餐节拍`,
      deadline: '本周',
      metric: '出餐超时订单占比下降到3%以内'
    }
  ];
}

function enforceDecisionRules(report, summaries) {
  const safe = {
    core_problem: safeText(report?.core_problem),
    top_3_issues: toStringArray(report?.top_3_issues).slice(0, 3),
    root_causes: toStringArray(report?.root_causes),
    actions: normalizeActions(report?.actions),
    warnings: toStringArray(report?.warnings)
  };

  const lowStores = getLowAchievementStores(summaries, 80);
  if (lowStores.length > 0 && safe.actions.length < 3) {
    const firstStore = String(lowStores[0]?.store || '').trim();
    const mustActions = buildMandatoryActions(firstStore);
    const merged = safe.actions.concat(mustActions);
    // 去重（按 role+action）
    const uniq = [];
    const seen = new Set();
    for (const a of merged) {
      const k = `${a.role}::${a.action}`;
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(a);
    }
    safe.actions = uniq.slice(0, Math.max(3, uniq.length));
    if (!safe.core_problem) safe.core_problem = `${firstStore || '门店'}达成率低于80%，需立即执行整改动作`;
    if (safe.top_3_issues.length === 0) safe.top_3_issues = lowStores.slice(0, 3).map(x => `${x.store}达成率仅${x.achievement_rate}%`);
  }

  return safe;
}

/**
 * 主入口：按日期拉取数据 + 调用 AI，返回分析报告（可单独调用）
 * @param {string} dateStr - 日期 YYYY-MM-DD
 * @returns {{ summaries: object[], report: object }}
 */
export async function getAIOperationsReport(dateStr, opts = {}) {
  const summaries = await buildDailyOperationSummaries(dateStr, opts);
  const report = await runAIOperationsAnalysis(summaries);
  return { summaries, report };
}
