import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { callLLM } from './llm-provider.js';
import { NOW_CN, extractFirstBalancedJsonObject } from './agent-handlers/text-utils.js';

function cleanText(value, max = 255) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function pctDiff(current, previous) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  if (!p) return null;
  return ((c - p) / p) * 100;
}

function pctText(value) {
  if (value == null || Number.isNaN(Number(value))) return 'N/A';
  const n = Number(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(0)}%`;
}

function holidayHints() {
  const upcoming = [
    { date: '2026-06-20', label: '端午节' },
    { date: '2026-09-17', label: '中秋节' },
    { date: '2026-10-01', label: '国庆节' }
  ];
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  return upcoming
    .map((h) => {
      const d = new Date(`${h.date}T00:00:00+08:00`);
      const days = Math.ceil((d.getTime() - today.getTime()) / 86400000);
      return days >= 0 ? `${h.label} ${h.date.slice(5).replace('-', '月').replace(/^0/, '')}日，距今${days}天` : null;
    })
    .filter(Boolean)
    .slice(0, 2);
}

async function getWeatherSummary() {
  try {
    const resp = await fetch('https://api.open-meteo.com/v1/forecast?latitude=31.2304&longitude=121.4737&daily=weather_code&timezone=Asia%2FShanghai&forecast_days=5');
    const data = await resp.json();
    const codes = Array.isArray(data?.daily?.weather_code) ? data.daily.weather_code : [];
    const rainy = codes.filter((c) => [51, 53, 55, 61, 63, 65, 80, 81, 82].includes(Number(c))).length;
    return rainy >= 3 ? '本周连续阴雨' : rainy >= 1 ? '本周有降雨' : '本周天气平稳';
  } catch (_) {
    return '天气数据暂缺';
  }
}

async function getCandidateStores() {
  const r = await query(
    `SELECT store_id, SUM(scan_count + payment_count)::int AS activity
     FROM growth_daily_metrics
     WHERE metric_date >= CURRENT_DATE - 7 AND store_id IS NOT NULL AND store_id <> ''
     GROUP BY store_id
     ORDER BY activity DESC, store_id ASC
     LIMIT 10`
  );
  return (r.rows || []).map((row) => cleanText(row.store_id, 128)).filter(Boolean);
}

async function buildWeekContext(storeId) {
  const r = await query(
    `WITH base AS (
       SELECT CASE
                WHEN metric_date >= date_trunc('week', CURRENT_DATE)::date THEN 'current'
                WHEN metric_date >= date_trunc('week', CURRENT_DATE)::date - 7 THEN 'previous'
                ELSE NULL
              END AS wk,
              SUM(revenue_fen)::int AS revenue_fen,
              SUM(payment_count)::int AS covers
       FROM growth_daily_metrics
       WHERE store_id = $1
         AND metric_date >= date_trunc('week', CURRENT_DATE)::date - 7
       GROUP BY 1
     )
     SELECT * FROM base WHERE wk IS NOT NULL`,
    [storeId]
  );
  const current = r.rows.find((x) => x.wk === 'current') || {};
  const previous = r.rows.find((x) => x.wk === 'previous') || {};
  return {
    revenue: pctDiff(current.revenue_fen, previous.revenue_fen),
    covers: pctDiff(current.covers, previous.covers),
    currentRevenueFen: Number(current.revenue_fen) || 0,
    previousRevenueFen: Number(previous.revenue_fen) || 0,
    currentCovers: Number(current.covers) || 0,
    previousCovers: Number(previous.covers) || 0
  };
}

async function buildAudienceSnapshot(storeId) {
  const r = await query(
    `WITH base AS (
       SELECT cp.customer_id, cp.pos_order_count, cp.visit_interval_days, cp.price_sensitivity,
              COALESCE(cp.pos_last_order_at::date, gc.last_seen_at::date) AS last_visit_at,
              (CURRENT_DATE - COALESCE(cp.pos_last_order_at::date, gc.last_seen_at::date))::int AS days_since_last_visit,
              gc.meta
       FROM growth_customer_profiles cp
       JOIN growth_customers gc ON gc.id = cp.customer_id
       WHERE cp.store_id = $1
     )
     SELECT
       COUNT(*) FILTER (WHERE pos_order_count >= 5 AND days_since_last_visit BETWEEN 21 AND 45)::int AS high_risk_count,
       COUNT(*) FILTER (WHERE pos_order_count >= 3 AND days_since_last_visit > 45)::int AS lost_count,
       COUNT(*) FILTER (WHERE pos_order_count = 1 AND days_since_last_visit >= 14)::int AS silent_new_count,
       COUNT(*) FILTER (
         WHERE pos_order_count >= 3
           AND visit_interval_days IS NOT NULL
           AND visit_interval_days <= 10
           AND to_char(CURRENT_DATE, 'MM') = COALESCE(NULLIF(meta->>'birthday_month',''), to_char(to_date(NULLIF(meta->>'birthday',''), 'YYYY-MM-DD'), 'MM'))
       )::int AS loyal_birthday_count
     FROM base`,
    [storeId]
  );
  return r.rows[0] || { high_risk_count: 0, lost_count: 0, silent_new_count: 0, loyal_birthday_count: 0 };
}

async function buildAnomalyBrief(storeId) {
  const lines = [];
  try {
    const avgCheck = await query(
      `WITH cur AS (
         SELECT ROUND(AVG(amount_after_discount), 2) AS avg_check
         FROM pos_orders
         WHERE store_id = $1
           AND biz_date >= date_trunc('week', CURRENT_DATE)::date
           AND EXTRACT(ISODOW FROM biz_date) = EXTRACT(ISODOW FROM CURRENT_DATE)
           AND EXTRACT(HOUR FROM COALESCE(order_time, checkout_time)) BETWEEN 10 AND 14
       ), prev AS (
         SELECT ROUND(AVG(amount_after_discount), 2) AS avg_check
         FROM pos_orders
         WHERE store_id = $1
           AND biz_date >= date_trunc('week', CURRENT_DATE)::date - 7
           AND biz_date < date_trunc('week', CURRENT_DATE)::date
           AND EXTRACT(ISODOW FROM biz_date) = EXTRACT(ISODOW FROM CURRENT_DATE)
           AND EXTRACT(HOUR FROM COALESCE(order_time, checkout_time)) BETWEEN 10 AND 14
       )
       SELECT cur.avg_check AS cur_avg, prev.avg_check AS prev_avg FROM cur, prev`,
      [storeId]
    );
    const curAvg = Number(avgCheck.rows?.[0]?.cur_avg) || 0;
    const prevAvg = Number(avgCheck.rows?.[0]?.prev_avg) || 0;
    if (curAvg > 0 && prevAvg > 0 && curAvg < prevAvg) {
      lines.push(`- 周中午市客单价环比下降${(prevAvg - curAvg).toFixed(0)}元（历史均值${prevAvg.toFixed(0)}元，今日${curAvg.toFixed(0)}元）`);
    }
  } catch (_) {}

  try {
    const newShare = await query(
      `WITH cur AS (
         SELECT COUNT(*) FILTER (WHERE first_seen_at >= date_trunc('week', CURRENT_DATE)::date)::numeric AS new_count,
                COUNT(*)::numeric AS total_count
         FROM growth_customers WHERE last_store_id = $1
       ), prev AS (
         SELECT COUNT(*) FILTER (
                  WHERE first_seen_at >= date_trunc('week', CURRENT_DATE)::date - 7
                    AND first_seen_at < date_trunc('week', CURRENT_DATE)::date
                )::numeric AS prev_new
         FROM growth_customers WHERE last_store_id = $1
       )
       SELECT cur.new_count, cur.total_count, prev.prev_new FROM cur, prev`,
      [storeId]
    );
    const newCount = Number(newShare.rows?.[0]?.new_count) || 0;
    const totalCount = Number(newShare.rows?.[0]?.total_count) || 0;
    const ratio = totalCount > 0 ? (newCount / totalCount) * 100 : 0;
    if (ratio >= 35) lines.push(`- 新客占比本周升至${ratio.toFixed(0)}%（正常水位约25%），老客回访承压`);
  } catch (_) {}

  try {
    const dishDrop = await query(
      `WITH cur AS (
         SELECT dish_name, SUM(qty)::numeric AS qty
         FROM pos_order_items
         WHERE store_code = $1 AND biz_date >= date_trunc('week', CURRENT_DATE)::date
         GROUP BY dish_name
       ), prev AS (
         SELECT dish_name, SUM(qty)::numeric AS qty
         FROM pos_order_items
         WHERE store_code = $1
           AND biz_date >= date_trunc('week', CURRENT_DATE)::date - 7
           AND biz_date < date_trunc('week', CURRENT_DATE)::date
         GROUP BY dish_name
       )
       SELECT cur.dish_name, cur.qty AS cur_qty, prev.qty AS prev_qty
       FROM cur JOIN prev USING (dish_name)
       WHERE prev.qty >= 5 AND cur.qty < prev.qty
       ORDER BY (prev.qty - cur.qty) DESC
       LIMIT 1`,
      [storeId]
    );
    const top = dishDrop.rows?.[0];
    if (top) {
      const decline = Number(top.prev_qty) > 0 ? Math.round(((Number(top.prev_qty) - Number(top.cur_qty)) / Number(top.prev_qty)) * 100) : 0;
      if (decline >= 20) lines.push(`- 招牌菜${top.dish_name}本周点单量下降${decline}%`);
    }
  } catch (_) {}

  return lines.length ? `【今日异常信号】\n${lines.join('\n')}` : '【今日异常信号】暂无显著异常';
}

async function refreshActionOutcomes(storeId) {
  const r = await query(
    `SELECT action_key, action_type, executed_at, payload
     FROM growth_actions
     WHERE store_id = $1 AND status = 'executed' AND executed_at IS NOT NULL
       AND executed_at >= CURRENT_DATE - 30
     ORDER BY executed_at DESC
     LIMIT 30`,
    [storeId]
  );
  const summaries = [];
  for (const row of r.rows || []) {
    const payload = row.payload || {};
    const actionKey = cleanText(row.action_key, 255);
    const couponId = cleanText(payload.coupon_id, 128);
    const executedAt = row.executed_at;
    const stats = { triggered: 0, delivered: 0, read: 0, clicked: 0, redeemed: 0 };
    const evt = await query(
      `SELECT event_type, COUNT(*)::int AS cnt
       FROM growth_events
       WHERE occurred_at >= $2 AND occurred_at < $2 + INTERVAL '14 days'
         AND metadata->>'action_key' = $1
       GROUP BY event_type`,
      [actionKey, executedAt]
    ).catch(() => ({ rows: [] }));
    for (const e of evt.rows || []) {
      const cnt = Number(e.cnt) || 0;
      if (e.event_type === 'marketing_triggered') stats.triggered += cnt;
      if (e.event_type === 'wecom_message_delivered') stats.delivered += cnt;
      if (e.event_type === 'wecom_message_read') stats.read += cnt;
      if (e.event_type === 'wecom_message_clicked') stats.clicked += cnt;
      if (e.event_type === 'wecom_coupon_redeemed') stats.redeemed += cnt;
    }
    if (couponId) {
      const red = await query(
        `SELECT COUNT(*)::int AS cnt FROM growth_redemptions
         WHERE coupon_id = $1 AND redeemed_at >= $2 AND redeemed_at < $2 + INTERVAL '14 days'`,
        [couponId, executedAt]
      ).catch(() => ({ rows: [{ cnt: 0 }] }));
      stats.redeemed = Math.max(stats.redeemed, Number(red.rows?.[0]?.cnt) || 0);
    }
    const base = Math.max(stats.triggered, 1);
    const redemptionRate = stats.redeemed > 0 ? stats.redeemed / base : 0;
    const clickRate = stats.clicked > 0 ? stats.clicked / base : 0;
    const daysPassed = Math.floor((Date.now() - new Date(executedAt).getTime()) / 86400000);
    let effectiveness = '待观察';
    if (redemptionRate >= 0.3 || clickRate >= 0.2) effectiveness = '有效';
    else if (daysPassed >= 14 && redemptionRate < 0.05 && clickRate < 0.05) effectiveness = '无效';
    const summary = {
      triggered: stats.triggered,
      delivered: stats.delivered,
      read: stats.read,
      clicked: stats.clicked,
      redeemed: stats.redeemed,
      redemption_rate: Number((redemptionRate * 100).toFixed(1)),
      click_rate: Number((clickRate * 100).toFixed(1)),
      effectiveness,
      evaluated_at: new Date().toISOString()
    };
    await query(
      `UPDATE growth_actions
       SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('outcome_summary', $2::jsonb), updated_at = NOW()
       WHERE action_key = $1`,
      [actionKey, JSON.stringify(summary)]
    ).catch(() => {});
    summaries.push({ actionKey, title: cleanText(payload.title || row.action_type, 120), ...summary });
  }
  return summaries;
}

function formatLastActionsContext(items) {
  if (!items.length) {
    return '上周AI建议执行情况：\n- 暂无已执行样本，请基于现有经营数据给出试验性建议，并明确缺少的验证数据。';
  }
  const lines = items.slice(0, 5).map((it) => {
    const result = it.effectiveness === '有效' ? '✅ 有效' : it.effectiveness === '无效' ? '❌ 无效' : '🟡 待观察';
    const rate = it.redemption_rate ? `核销率${it.redemption_rate}%` : (it.click_rate ? `点击率${it.click_rate}%` : '无明显转化');
    return `- ${it.title} → ${rate}，触达${it.triggered || 0}人，核销${it.redeemed || 0}次 ${result}`;
  });
  return `上周AI建议执行情况：\n${lines.join('\n')}\n\n请在本次建议中：\n- 不要重复上周已执行的动作\n- 可以加强有效的方向\n- 解释为什么放弃无效的方向`;
}

function buildOperationalContext(weekCtx, weather) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const day = now.getDay();
  const daysToWeekend = day === 0 || day === 6 ? 0 : 6 - day;
  return {
    today: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${weekdayNames[day]}`,
    daysToWeekend,
    upcomingHolidays: holidayHints(),
    currentWeekVsLastWeek: {
      revenue: pctText(weekCtx.revenue),
      covers: pctText(weekCtx.covers)
    },
    weather
  };
}

function buildCurrentDataBlock({ storeId, audience, weekCtx, anomalyBrief, lastActionsContext, opCtx }) {
  return [
    `门店：${storeId}`,
    `【时间节点上下文】`,
    `- 今天：${opCtx.today}`,
    `- 距离周末：${opCtx.daysToWeekend}天`,
    `- 近期节日：${opCtx.upcomingHolidays.join('；') || '暂无'}`,
    `- 本周 vs 上周：营收 ${opCtx.currentWeekVsLastWeek.revenue}，客流 ${opCtx.currentWeekVsLastWeek.covers}`,
    `- 天气：${opCtx.weather}`,
    `【关键客群池】`,
    `- 高危流失（21-45天未到访、消费>=5次）：${audience.high_risk_count || 0}人`,
    `- 已流失（>45天未到访、消费>=3次）：${audience.lost_count || 0}人`,
    `- 新客未激活（首购后14天未复购）：${audience.silent_new_count || 0}人`,
    `- 忠诚客户生日月：${audience.loyal_birthday_count || 0}人`,
    `【经营周度数据】`,
    `- 本周营收：¥${(Number(weekCtx.currentRevenueFen || 0) / 100).toFixed(0)}`,
    `- 上周营收：¥${(Number(weekCtx.previousRevenueFen || 0) / 100).toFixed(0)}`,
    `- 本周客流：${Number(weekCtx.currentCovers || 0)}`,
    `- 上周客流：${Number(weekCtx.previousCovers || 0)}`,
    anomalyBrief,
    lastActionsContext
  ].join('\n');
}

function buildStructuredPrompt(currentData) {
  return `你是一家餐厅的营销顾问。请根据以下数据，输出【恰好3条】可立即执行的建议。

每条建议必须包含：
- level: 只能是「高置信」「试验性」「需人工判断」之一
- target_audience: [具体人数+特征]，例如"28天未到访、历史消费≥4次的客户，共47人"
- execution_action: [具体到券面值/文案方向/渠道]
- execution_time: [今天/本周几/几号前]
- expected_effect: [基于历史数据的数字估算]
- cost_estimate: [最大券面值×目标人数]
- why_this_level: [为什么是这个级别]
- action_type: 只能是 send_voucher / send_message / promo_task 三选一
- channel: 例如 wecom / miniprogram / xiaohongshu / douyin / dianping
- coupon_value_fen: 发券时必须给整数分值；不是发券填0
- target_count: 目标人数整数
- missing_data: 若数据不足，明确写缺什么；若足够则写空字符串

禁止输出“增加互动”“提升体验”等无法执行的建议。
如果数据不足以支撑具体建议，说明缺少什么数据。

输出要求：
1. 只输出一个 JSON 对象，不要解释，不要 markdown。
2. JSON 结构必须为：
{
  "suggestions": [
    { ... },
    { ... },
    { ... }
  ]
}
3. suggestions 必须恰好3条。
4. 至少1条必须是「高置信」或明确说明为什么没有高置信建议。
5. 不要重复上周已经证明无效的方向。

当前数据：
${currentData}`;
}

function extractSuggestions(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  for (const candidate of [text, extractFirstBalancedJsonObject(text)].filter(Boolean)) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed?.suggestions)) return parsed.suggestions.slice(0, 3);
    } catch (_) {}
  }
  return [];
}

function normalizeSuggestion(s, storeId, idx) {
  const level = ['高置信', '试验性', '需人工判断'].includes(cleanText(s.level, 20)) ? cleanText(s.level, 20) : '试验性';
  const actionType = ['send_voucher', 'send_message', 'promo_task'].includes(cleanText(s.action_type, 40)) ? cleanText(s.action_type, 40) : 'send_message';
  const targetCount = Math.max(0, Math.floor(Number(s.target_count) || 0));
  const couponValueFen = Math.max(0, Math.floor(Number(s.coupon_value_fen) || 0));
  const channel = cleanText(s.channel || (actionType === 'promo_task' ? 'xiaohongshu' : 'wecom'), 80);
  return {
    actionKey: `llm_growth:${storeId}:${new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10)}:${idx + 1}`,
    actionType,
    status: 'proposed',
    title: `${level}｜${cleanText(s.execution_action || `营销建议${idx + 1}`, 120)}`,
    detail: [
      `目标客群：${cleanText(s.target_audience, 500)}`,
      `执行动作：${cleanText(s.execution_action, 1000)}`,
      `执行时间：${cleanText(s.execution_time, 120)}`,
      `预期效果：${cleanText(s.expected_effect, 500)}`,
      `成本估算：${cleanText(s.cost_estimate, 200)}`,
      `建议级别：${level}${cleanText(s.why_this_level, 300) ? `（${cleanText(s.why_this_level, 300)}）` : ''}`,
      cleanText(s.missing_data, 300) ? `缺失数据：${cleanText(s.missing_data, 300)}` : ''
    ].filter(Boolean).join('\n'),
    payload: {
      source: 'llm_campaign_autopilot',
      confidence_level: level,
      confidence_reason: cleanText(s.why_this_level, 300),
      target_audience: cleanText(s.target_audience, 500),
      execution_action: cleanText(s.execution_action, 1000),
      execution_time: cleanText(s.execution_time, 120),
      expected_effect: cleanText(s.expected_effect, 500),
      cost_estimate: cleanText(s.cost_estimate, 200),
      channel,
      coupon_value_fen: couponValueFen,
      target_count: targetCount,
      missing_data: cleanText(s.missing_data, 300),
      action_type_structured: actionType
    }
  };
}

async function writeSuggestions(storeId, suggestions) {
  let written = 0;
  for (let i = 0; i < suggestions.length; i++) {
    const s = normalizeSuggestion(suggestions[i], storeId, i);
    await query(
      `INSERT INTO growth_actions (action_key, action_type, status, store_id, title, detail, payload, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'agent_v2')
       ON CONFLICT (action_key) DO UPDATE SET
         action_type = EXCLUDED.action_type,
         status = EXCLUDED.status,
         title = EXCLUDED.title,
         detail = EXCLUDED.detail,
         payload = EXCLUDED.payload,
         updated_at = NOW()`,
      [s.actionKey, s.actionType, s.status, storeId, s.title, s.detail, JSON.stringify(s.payload)]
    );
    written += 1;
  }
  return written;
}

async function generateSuggestionsForStore(storeId) {
  const [weekCtx, audience, weather, outcomes] = await Promise.all([
    buildWeekContext(storeId),
    buildAudienceSnapshot(storeId),
    getWeatherSummary(),
    refreshActionOutcomes(storeId)
  ]);
  const anomalyBrief = await buildAnomalyBrief(storeId);
  const opCtx = buildOperationalContext(weekCtx, weather);
  const lastActionsContext = formatLastActionsContext(outcomes);
  const currentData = buildCurrentDataBlock({ storeId, audience, weekCtx, anomalyBrief, lastActionsContext, opCtx });
  const prompt = buildStructuredPrompt(currentData);
  const r = await callLLM([
    { role: 'system', content: '你是严格遵守格式的餐饮营销顾问。必须输出可执行建议，且仅输出 JSON。' },
    { role: 'user', content: prompt }
  ], { temperature: 0.2, max_tokens: 1800, purpose: 'marketing_planner' });
  const suggestions = extractSuggestions(r.content);
  if (suggestions.length !== 3) {
    throw new Error(`invalid_suggestion_count:${suggestions.length}`);
  }
  return { suggestions, currentData };
}

export async function runCampaignAutopilot() {
  logger.info('campaign autopilot started');
  const stores = await getCandidateStores();
  if (!stores.length) {
    logger.info('campaign autopilot: no candidate stores');
    return { ok: true, total: 0, written: 0 };
  }
  let written = 0;
  const failures = [];
  for (const storeId of stores) {
    try {
      const { suggestions } = await generateSuggestionsForStore(storeId);
      written += await writeSuggestions(storeId, suggestions);
    } catch (e) {
      failures.push({ storeId, err: e?.message || 'unknown' });
      logger.warn({ storeId, err: e?.message }, 'campaign autopilot generation failed');
    }
  }
  logger.info({ stores: stores.length, written, failures: failures.length }, 'campaign autopilot completed');
  return { ok: true, stores: stores.length, written, failures };
}
