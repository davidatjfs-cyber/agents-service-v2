import axios from 'axios';
import { executeGrowthActionRecord } from './growth-api.js';
import { callLLM, sendLarkMessage } from './agents.js';

const PHASE_EVENT_TYPES = new Set([
  'campaign_scan', 'phone_authorized', 'coupon_claimed',
  'coupon_purchased', 'coupon_redeemed', 'payment_success',
  'customer_arrived', 'marketing_triggered'
]);

function cleanText(value, max = 255) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function cleanPhone(value) {
  return cleanText(value, 32).replace(/[^0-9+]/g, '');
}

function parseOccurredAt(value) {
  if (!value) return new Date();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function safeDateOnly(value) {
  const s = cleanText(value, 32);
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function safeMonthOnly(value) {
  const s = cleanText(value, 32);
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 7);
}

function ymdAddDays(ymd, delta) {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + Number(delta || 0));
  return d.toISOString().slice(0, 10);
}

function diffDaysInclusive(startYmd, endYmd) {
  const s = new Date(`${startYmd}T00:00:00Z`);
  const e = new Date(`${endYmd}T00:00:00Z`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return 0;
  return Math.floor((e.getTime() - s.getTime()) / 86400000) + 1;
}

function todayShanghaiYmd() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

function stableVariant(seed) {
  let h = 0;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h) + s.charCodeAt(i);
  return Math.abs(h) % 2 === 0 ? 'A' : 'B';
}

function interpolateAbContent(template, customer) {
  const name = cleanText(customer?.name || customer?.member_name || '', 40) || '您';
  return String(template || '').replace(/\{姓名\}/g, name).replace(/\{name\}/gi, name);
}

function formatPercent(n, digits = 2) {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '0.00%';
  return `${v.toFixed(digits)}%`;
}

// ── Phase 6: Experience lookup layer ──────────────────────────────────────────
// Query the learnings KB before every content generation action.
// Matches spec's exact SQL; falls back gracefully on empty context fields.
async function lookupLearnings(pool, context) {
  const channel = cleanText(context?.channel || '', 80);
  const scene = context?.scene ? cleanText(context.scene, 80) : null;
  const audienceTag = context?.audience_tag ? cleanText(context.audience_tag, 120) : null;
  const variable = cleanText(context?.variable || '', 120);
  if (!channel || !variable) return [];
  const r = await pool.query(
    `SELECT winning_value, losing_value, effect_desc, sample_size, confidence, variable, audience_tag, scene
       FROM growth_learnings
      WHERE channel = $1
        AND (scene = $2 OR scene IS NULL OR $2 IS NULL)
        AND (audience_tag = $3 OR audience_tag IS NULL OR $3 IS NULL)
        AND variable = $4
        AND (valid_until IS NULL OR valid_until > CURRENT_DATE)
      ORDER BY sample_size DESC, confidence DESC
      LIMIT 3`,
    [channel, scene, audienceTag, variable]
  );
  return r.rows || [];
}

async function listAbAudienceForSendDate(pool, storeCode, sendDate, lookbackDays = 7) {
  const store = cleanText(storeCode, 128);
  const sendYmd = safeDateOnly(sendDate);
  if (!store || !sendYmd) return [];
  const startYmd = ymdAddDays(sendYmd, -Math.max(1, Math.floor(Number(lookbackDays) || 7)));
  const r = await pool.query(
    `WITH base AS (
       SELECT gc.id AS customer_id,
              gc.phone,
              COALESCE(gcp.store_id, gc.last_store_id, '') AS store_code,
              COALESCE(NULLIF(gcp.source_signals->>'name',''), NULLIF(gc.meta->>'name',''), '') AS customer_name
       FROM growth_customers gc
       LEFT JOIN growth_customer_profiles gcp ON gcp.customer_id = gc.id
       WHERE COALESCE(gcp.store_id, gc.last_store_id, '') = $1
         AND gc.phone IS NOT NULL AND gc.phone <> ''
     ),
     hist AS (
       SELECT b.customer_id,
              b.phone,
              b.store_code,
              b.customer_name,
              MAX(po.biz_date) FILTER (WHERE po.biz_date < $2::date) AS last_order_before_send,
              COUNT(*) FILTER (WHERE po.biz_date >= $3::date AND po.biz_date < $2::date) AS orders_last_7d,
              COUNT(*) FILTER (WHERE po.biz_date < $2::date) AS lifetime_orders
       FROM base b
       LEFT JOIN pos_orders po
         ON (po.customer_id = b.customer_id OR (po.customer_id IS NULL AND po.phone = b.phone))
        AND po.store_id = $1
       GROUP BY b.customer_id, b.phone, b.store_code, b.customer_name
     )
     SELECT customer_id, phone, store_code, customer_name, last_order_before_send
     FROM hist
     WHERE orders_last_7d = 0
       AND lifetime_orders > 0
     ORDER BY COALESCE(last_order_before_send, DATE '1900-01-01') ASC, customer_id ASC`,
    [store, sendYmd, startYmd]
  );
  return r.rows || [];
}

async function upsertAbTaskResult(pool, row) {
  await pool.query(
    `INSERT INTO ab_test_results (
       test_id, result_date, variant, sent, impressions, clicks,
       orders, redemptions, revenue, conversion_rate
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (test_id, result_date, variant) DO UPDATE SET
       sent = EXCLUDED.sent,
       impressions = EXCLUDED.impressions,
       clicks = EXCLUDED.clicks,
       orders = EXCLUDED.orders,
       redemptions = EXCLUDED.redemptions,
       revenue = EXCLUDED.revenue,
       conversion_rate = EXCLUDED.conversion_rate,
       created_at = NOW()`,
    [
      Number(row.test_id),
      safeDateOnly(row.result_date),
      cleanText(row.variant, 8),
      Math.max(0, Math.floor(Number(row.sent) || 0)),
      Math.max(0, Math.floor(Number(row.impressions) || 0)),
      Math.max(0, Math.floor(Number(row.clicks) || 0)),
      Math.max(0, Math.floor(Number(row.orders) || 0)),
      Math.max(0, Math.floor(Number(row.redemptions) || 0)),
      Number(Number(row.revenue || 0).toFixed(2)),
      Number(Number(row.conversion_rate || 0).toFixed(4))
    ]
  );
}

async function queueAbSmsAssignments(pool, taskRow, audienceRows, opts = {}) {
  const taskId = Number(taskRow?.id || 0);
  if (!taskId || !Array.isArray(audienceRows) || !audienceRows.length) return { created: 0, audience: 0 };
  const storeCode = cleanText(taskRow?.store_code, 128);
  const sendDate = safeDateOnly(opts.sendDate || taskRow?.start_date) || todayShanghaiYmd();
  const variantA = taskRow?.variant_a && typeof taskRow.variant_a === 'object' ? taskRow.variant_a : {};
  const variantB = taskRow?.variant_b && typeof taskRow.variant_b === 'object' ? taskRow.variant_b : {};
  let created = 0;
  for (const row of audienceRows) {
    const customerId = Number(row?.customer_id || 0);
    const phone = cleanPhone(row?.phone);
    if (!customerId || !phone) continue;
    const variant = stableVariant(`${taskId}:${customerId}:${phone}`);
    const variantDef = variant === 'A' ? variantA : variantB;
    const content = interpolateAbContent(variantDef?.content || '', { name: row?.customer_name || '', phone });
    const deliveryKey = `abtest_${taskId}_${variant}_${customerId}`;
    const payload = {
      ab_test_id: taskId,
      variant,
      phone,
      customer_name: cleanText(row?.customer_name, 80),
      test_name: cleanText(taskRow?.test_name, 255),
      store_code: storeCode,
      target_metric: cleanText(taskRow?.target_metric, 80),
      sms_copy: content,
      coupon_offer: variant === 'A' ? '8折券' : '减8元券',
      audience_tag: '7日未到店',
      send_date: sendDate
    };
    const ins = await pool.query(
      `INSERT INTO growth_delivery_logs (
         delivery_key, action_key, rule_key, customer_id, store_id, channel,
         status, payload, result, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,'sms','sent',$6::jsonb,$7::jsonb,$8::timestamptz,$8::timestamptz)
       ON CONFLICT (delivery_key) DO NOTHING
       RETURNING id`,
      [
        deliveryKey,
        deliveryKey,
        `ab_test_${taskId}`,
        customerId,
        storeCode,
        JSON.stringify(payload),
        JSON.stringify({ provider: 'internal_auto_seed', sent: true }),
        `${sendDate}T10:00:00+08:00`
      ]
    );
    if (ins.rows?.length) created += 1;
  }
  return { created, audience: audienceRows.length };
}

async function refreshAbTestResults(pool, taskRow) {
  const taskId = Number(taskRow?.id || 0);
  const storeCode = cleanText(taskRow?.store_code, 128);
  const startDate = safeDateOnly(taskRow?.start_date);
  const endDate = safeDateOnly(taskRow?.end_date);
  if (!taskId || !startDate || !endDate) return null;

  const deliveries = await pool.query(
    `SELECT customer_id,
            store_id,
            created_at,
            payload->>'variant' AS variant,
            payload->>'send_date' AS send_date
       FROM growth_delivery_logs
      WHERE channel = 'sms'
        AND payload->>'ab_test_id' = $1`,
    [String(taskId)]
  );
  const assignments = deliveries.rows || [];
  const sendCount = { A: 0, B: 0 };
  assignments.forEach((a) => {
    const v = cleanText(a.variant, 8) === 'B' ? 'B' : 'A';
    sendCount[v] += 1;
  });

  const assignmentMap = new Map();
  assignments.forEach((a) => {
    assignmentMap.set(Number(a.customer_id), cleanText(a.variant, 8) === 'B' ? 'B' : 'A');
  });

  const orderRes = await pool.query(
    `SELECT po.biz_date::text AS biz_date,
            po.customer_id,
            COUNT(*)::int AS order_count,
            COALESCE(SUM(po.amount_after_discount),0)::numeric AS revenue
       FROM pos_orders po
      WHERE po.store_id = $1
        AND po.customer_id IS NOT NULL
        AND po.biz_date >= $2::date
        AND po.biz_date <= $3::date
        AND po.customer_id = ANY($4::bigint[])
      GROUP BY po.biz_date, po.customer_id`,
    [storeCode, startDate, endDate, assignments.map((x) => Number(x.customer_id)).filter(Boolean)]
  );

  const byDateVariant = new Map();
  for (let cur = startDate; cur <= endDate; cur = ymdAddDays(cur, 1)) {
    ['A', 'B'].forEach((variant) => {
      byDateVariant.set(`${cur}|${variant}`, {
        test_id: taskId,
        result_date: cur,
        variant,
        sent: cur === startDate ? sendCount[variant] : 0,
        impressions: cur === startDate ? sendCount[variant] : 0,
        clicks: 0,
        orders: 0,
        redemptions: 0,
        revenue: 0,
        conversion_rate: 0
      });
    });
  }

  (orderRes.rows || []).forEach((row) => {
    const customerId = Number(row.customer_id || 0);
    const variant = assignmentMap.get(customerId);
    const key = `${safeDateOnly(row.biz_date)}|${variant}`;
    const slot = byDateVariant.get(key);
    if (!slot) return;
    slot.orders += Math.max(0, Math.floor(Number(row.order_count) || 0));
    slot.redemptions += 1;
    slot.revenue = Number((Number(slot.revenue || 0) + Number(row.revenue || 0)).toFixed(2));
    slot.conversion_rate = sendCount[variant] > 0 ? Number((slot.redemptions / sendCount[variant]).toFixed(4)) : 0;
  });

  for (const row of byDateVariant.values()) {
    await upsertAbTaskResult(pool, row);
  }

  return { sendCount, assignments: assignments.length };
}

async function computeAbTestOutcome(pool, taskRow) {
  const taskId = Number(taskRow?.id || 0);
  if (!taskId) return null;
  const deliveries = await pool.query(
    `SELECT customer_id, payload->>'variant' AS variant
       FROM growth_delivery_logs
      WHERE channel='sms' AND payload->>'ab_test_id' = $1`,
    [String(taskId)]
  );
  const assigns = deliveries.rows || [];
  const sendCount = { A: 0, B: 0 };
  const customerByVariant = { A: new Set(), B: new Set() };
  assigns.forEach((a) => {
    const v = cleanText(a.variant, 8) === 'B' ? 'B' : 'A';
    sendCount[v] += 1;
    customerByVariant[v].add(Number(a.customer_id));
  });
  const rows = await pool.query(
    `SELECT result_date, variant, sent, impressions, clicks, orders, redemptions, revenue, conversion_rate
       FROM ab_test_results
      WHERE test_id = $1
      ORDER BY result_date ASC, variant ASC`,
    [taskId]
  );
  const byVariant = {
    A: { sent: sendCount.A, impressions: 0, clicks: 0, orders: 0, redemptions: 0, revenue: 0 },
    B: { sent: sendCount.B, impressions: 0, clicks: 0, orders: 0, redemptions: 0, revenue: 0 }
  };
  (rows.rows || []).forEach((r) => {
    const v = cleanText(r.variant, 8) === 'B' ? 'B' : 'A';
    byVariant[v].impressions += Math.max(0, Math.floor(Number(r.impressions) || 0));
    byVariant[v].clicks += Math.max(0, Math.floor(Number(r.clicks) || 0));
    byVariant[v].orders += Math.max(0, Math.floor(Number(r.orders) || 0));
    byVariant[v].redemptions += Math.max(0, Math.floor(Number(r.redemptions) || 0));
    byVariant[v].revenue = Number((byVariant[v].revenue + Number(r.revenue || 0)).toFixed(2));
  });
  ['A', 'B'].forEach((v) => {
    byVariant[v].redemption_rate = byVariant[v].sent > 0 ? Number((byVariant[v].redemptions / byVariant[v].sent).toFixed(4)) : 0;
    byVariant[v].revenue_per_order = byVariant[v].orders > 0 ? Number((byVariant[v].revenue / byVariant[v].orders).toFixed(2)) : 0;
  });
  return { daily: rows.rows || [], byVariant, sendCount };
}

async function buildAbAiSummary(taskRow, outcome) {
  const byVariant = outcome?.byVariant || {};
  const a = byVariant.A || {};
  const b = byVariant.B || {};
  const prompt = `你是餐饮增长分析助手。请用简洁中文总结一次A/B测试结果，输出1段话，不要分点，不超过180字。\n测试名：${taskRow.test_name}\n目标指标：${taskRow.target_metric}\nA组发送${a.sent || 0}人，核销/回流${a.redemptions || 0}，核销率${formatPercent((a.redemption_rate || 0) * 100)}，营收${a.revenue || 0}元。\nB组发送${b.sent || 0}人，核销/回流${b.redemptions || 0}，核销率${formatPercent((b.redemption_rate || 0) * 100)}，营收${b.revenue || 0}元。`;
  try {
    const llm = await callLLM([{ role: 'user', content: prompt }], { purpose: 'data_analysis', temperature: 0.2, max_tokens: 220 });
    if (llm?.ok && llm.content) return cleanText(llm.content, 1800);
  } catch (_) {}
  const winner = (a.redemption_rate || 0) > (b.redemption_rate || 0) ? 'A' : (a.redemption_rate || 0) < (b.redemption_rate || 0) ? 'B' : 'tie';
  return cleanText(`测试完成：A组核销率${formatPercent((a.redemption_rate || 0) * 100)}，B组核销率${formatPercent((b.redemption_rate || 0) * 100)}，${winner === 'tie' ? '两组差异不明显，建议继续积累样本。' : `${winner}组表现更好，建议将该版本作为下轮默认文案。`}`, 1800);
}

async function maybeWriteAbLearning(pool, taskRow, outcome, winner, winnerLift) {
  if (!['A', 'B'].includes(winner)) return;
  const variable = taskRow?.test_type === 'sms_copy' ? '文案风格' : cleanText(taskRow?.test_type || '测试变量', 80);
  const variantA = taskRow?.variant_a && typeof taskRow.variant_a === 'object' ? taskRow.variant_a : {};
  const variantB = taskRow?.variant_b && typeof taskRow.variant_b === 'object' ? taskRow.variant_b : {};
  const winDef = winner === 'A' ? variantA : variantB;
  const loseDef = winner === 'A' ? variantB : variantA;
  const learningKey = `ab_test:${taskRow.id}:${winner}`;
  await pool.query(
    `INSERT INTO growth_learnings (
       source_type, source_id, store_code, channel, scene, audience_tag, variable,
       winning_value, losing_value, effect_desc, sample_size, confidence, valid_until
     ) VALUES ('ab_test',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT DO NOTHING`,
    [
      String(taskRow.id),
      cleanText(taskRow.store_code, 128),
      taskRow.test_type === 'sms_copy' ? 'sms' : cleanText(taskRow.test_type, 80),
      '晚市',
      '7日未到店',
      variable,
      cleanText(winDef.label || winDef.content || winner, 500),
      cleanText(loseDef.label || loseDef.content || (winner === 'A' ? 'B' : 'A'), 500),
      cleanText(`核销率+${Number(winnerLift || 0).toFixed(2)}%`, 255),
      Math.max(Number(outcome?.byVariant?.A?.sent || 0), Number(outcome?.byVariant?.B?.sent || 0)),
      Math.max(Number(outcome?.byVariant?.A?.sent || 0), Number(outcome?.byVariant?.B?.sent || 0)) >= 100 ? 'high' : 'medium',
      ymdAddDays(todayShanghaiYmd(), 90)
    ]
  ).catch(() => {});
}

async function evaluateAbTask(pool, taskRow) {
  const outcome = await computeAbTestOutcome(pool, taskRow);
  if (!outcome) return null;
  const a = outcome.byVariant.A || {};
  const b = outcome.byVariant.B || {};
  const minSample = Math.max(1, Math.floor(Number(taskRow?.min_sample_size) || 30));
  if ((a.sent || 0) < minSample || (b.sent || 0) < minSample) return { outcome, finalized: false };
  const rateA = Number(a.redemption_rate || 0);
  const rateB = Number(b.redemption_rate || 0);
  let winner = 'tie';
  if (Math.abs(rateA - rateB) >= 0.01) winner = rateA > rateB ? 'A' : 'B';
  const base = winner === 'A' ? rateB : rateA;
  const top = winner === 'A' ? rateA : rateB;
  const winnerLift = winner === 'tie' ? 0 : Number((base > 0 ? ((top - base) / base) * 100 : top * 100).toFixed(2));
  const aiSummary = await buildAbAiSummary(taskRow, outcome);
  const status = safeDateOnly(taskRow.end_date) <= todayShanghaiYmd() ? 'completed' : 'running';
  const updated = await pool.query(
    `UPDATE ab_test_tasks
        SET winner = $2,
            winner_lift = $3,
            ai_summary = $4,
            status = $5
      WHERE id = $1
      RETURNING *`,
    [Number(taskRow.id), winner, winnerLift, cleanText(aiSummary, 4000), status]
  );
  await maybeWriteAbLearning(pool, updated.rows[0] || taskRow, outcome, winner, winnerLift);
  return { outcome, finalized: true, task: updated.rows[0] || taskRow };
}

async function generateDishTrendSummary(pool, storeCode) {
  const store = cleanText(storeCode, 128);
  const r = await pool.query(
    `WITH cur AS (
       SELECT dish_name, COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(amount_after_discount),0) AS revenue
       FROM pos_order_items
       WHERE store_code = $1 AND biz_date >= CURRENT_DATE - INTERVAL '7 day'
       GROUP BY dish_name
     ),
     prev AS (
       SELECT dish_name, COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(amount_after_discount),0) AS revenue
       FROM pos_order_items
       WHERE store_code = $1 AND biz_date >= CURRENT_DATE - INTERVAL '14 day' AND biz_date < CURRENT_DATE - INTERVAL '7 day'
       GROUP BY dish_name
     )
     SELECT COALESCE(cur.dish_name, prev.dish_name) AS dish_name,
            COALESCE(cur.qty,0) AS cur_qty,
            COALESCE(prev.qty,0) AS prev_qty,
            COALESCE(cur.revenue,0) AS cur_revenue,
            COALESCE(prev.revenue,0) AS prev_revenue
     FROM cur
     FULL JOIN prev ON prev.dish_name = cur.dish_name`,
    [store]
  );
  const rows = (r.rows || []).map((x) => {
    const prevQty = Number(x.prev_qty || 0);
    const curQty = Number(x.cur_qty || 0);
    const deltaPct = prevQty > 0 ? ((curQty - prevQty) / prevQty) * 100 : (curQty > 0 ? 100 : 0);
    return { ...x, deltaPct: Number(deltaPct.toFixed(2)) };
  });
  rows.sort((a, b) => Number(b.deltaPct || 0) - Number(a.deltaPct || 0));
  return {
    topGrowers: rows.filter((x) => Number(x.cur_qty || 0) > 0).slice(0, 5),
    topDecliners: rows.slice().sort((a, b) => Number(a.deltaPct || 0) - Number(b.deltaPct || 0)).filter((x) => Number(x.prev_qty || 0) > 0).slice(0, 5)
  };
}

async function generateWeeklyContentSuggestion(pool, storeCode, weekStart, operator = 'system') {
  const store = cleanText(storeCode, 128);
  const start = safeDateOnly(weekStart) || todayShanghaiYmd();
  const trends = await generateDishTrendSummary(pool, store);

  // Phase 6: Context-specific lookups before generating content
  const [smsLearnings, xhsLearnings, abRes] = await Promise.all([
    lookupLearnings(pool, { channel: 'sms', scene: '晚市', audience_tag: '7日未到店', variable: '文案风格' }),
    lookupLearnings(pool, { channel: 'xiaohongshu', variable: '内容策略' }),
    pool.query(`SELECT * FROM ab_test_tasks WHERE ($1 = '' OR store_code = $1) AND winner IS NOT NULL ORDER BY created_at DESC LIMIT 10`, [store])
  ]);

  const top = trends.topGrowers[0] || null;
  const down = trends.topDecliners[0] || null;
  const bestSmsLearning = smsLearnings[0] || null;
  const bestXhsLearning = xhsLearnings[0] || null;
  const bestAb = abRes.rows?.find((x) => x.test_type === 'sms_copy') || abRes.rows?.[0] || null;

  // Phase 6 flywheel: auto-adopt winning SMS style when learning exists
  let smsA = top ? `荔枝木${top.dish_name}本周热卖，今晚来尝尝，限时优惠已备好` : '今晚来店，专属优惠已为您准备';
  let smsB = top ? `{姓名}，${top.dish_name}这周很受欢迎，给你留了一张优惠券，3天内有效` : '{姓名}，给你准备了一张限时优惠券，3天内有效';
  let smsCite = '';
  if (bestSmsLearning) {
    // The winning copy style becomes the primary variant; challenger is the baseline
    smsA = cleanText(bestSmsLearning.winning_value, 255) || smsA;
    smsCite = `根据上次测试（${cleanText(bestSmsLearning.effect_desc || '', 80)}），已自动采用胜出风格`;
  }

  const items = [
    {
      rank: 1,
      theme: top ? `重点推${top.dish_name}` : '重点推本周热门菜品',
      reason: top ? `近7天销量环比增长${Number(top.deltaPct || 0).toFixed(0)}%` : '结合近7天销售趋势与已验证经验',
      channel: 'sms',
      sms_copy_a: smsA,
      sms_copy_b: smsB,
      learning_cite: smsCite || null,
      action: smsCite ? '胜出风格已自动应用为A组；B组为挑战版本，继续追踪7天核销率' : '建议测试这两条，追踪7天核销/回流率'
    },
    {
      rank: 2,
      theme: '午市单人套餐',
      reason: bestXhsLearning
        ? `根据上次测试，建议：${cleanText(bestXhsLearning.audience_tag || '目标人群', 40)}场景下「${cleanText(bestXhsLearning.winning_value || '', 30)}」效果更优（${cleanText(bestXhsLearning.effect_desc || '', 40)}）`
        : '午市需要持续拉动到店转化',
      channel: 'xiaohongshu',
      xhs_copies: [
        '工作日午市也要吃得像样，单人套餐快手不将就。',
        '一个人吃饭也能很满足，午市套餐把性价比拉满。',
        '午休一小时，来一份热腾腾现炒套餐，刚刚好。'
      ],
      dianping_cover_styles: ['高性价比风格', '烟火气风格'],
      learning_cite: bestXhsLearning ? `根据上次测试（${cleanText(bestXhsLearning.effect_desc || '', 60)}）` : null,
      action: '运营选一个版本发布，并录入曝光/点击/订单效果'
    },
    {
      rank: 3,
      theme: down ? `本周不建议重推：${down.dish_name}` : '本周不建议重推高价低转化品类',
      reason: down ? `近7天销量环比下降${Math.abs(Number(down.deltaPct || 0)).toFixed(0)}%` : '避免继续投放弱转化主题，节省预算',
      channel: 'all',
      learning_cite: null,
      action: bestAb ? `优先复用最近A/B测试胜出风格：${bestAb.winner || 'A'}组` : '优先复用最近已验证的高转化内容风格'
    }
  ];
  const summaryText = `【本周内容建议 · ${store || '全部门店'}】\n① ${items[0].theme}：${items[0].reason}\n② ${items[1].theme}：${items[1].reason}\n③ ${items[2].theme}：${items[2].reason}`;
  const saved = await pool.query(
    `INSERT INTO growth_content_suggestions (suggestion_key, week_start, store_code, summary_json, generated_by)
     VALUES ($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT (suggestion_key) DO UPDATE SET summary_json = EXCLUDED.summary_json, generated_by = EXCLUDED.generated_by, updated_at = NOW()
     RETURNING *`,
    [`weekly_${store || 'all'}_${start}`, start, store, JSON.stringify({ store_code: store, week_start: start, items, summary_text: summaryText }), cleanText(operator, 80)]
  );
  return saved.rows[0] || null;
}

async function pushWeeklySuggestionToFeishu(pool, suggestionRow) {
  if (!suggestionRow) return { pushed: 0 };
  // Skip if already pushed within the last 7 days (survives service restarts)
  if (suggestionRow.feishu_pushed_at) {
    const daysSince = (Date.now() - new Date(suggestionRow.feishu_pushed_at).getTime()) / 86400000;
    if (daysSince < 7) return { pushed: 0, skipped: true };
  }
  const summary = suggestionRow.summary_json && typeof suggestionRow.summary_json === 'object' ? suggestionRow.summary_json : {};
  const text = cleanText(summary.summary_text || '', 4000);
  if (!text) return { pushed: 0 };
  const rec = await pool.query(
    `SELECT open_id FROM feishu_users
      WHERE registered = TRUE AND open_id IS NOT NULL AND trim(open_id) <> ''
        AND role IN ('admin','hq_manager')`,
    []
  );
  let pushed = 0;
  for (const row of rec.rows || []) {
    const sent = await sendLarkMessage(String(row.open_id || '').trim(), text, { skipDedup: true }).catch(() => ({ ok: false }));
    if (sent?.ok) pushed += 1;
  }
  if (pushed > 0) {
    await pool.query(`UPDATE growth_content_suggestions SET feishu_pushed_at = NOW() WHERE id = $1`, [Number(suggestionRow.id)]).catch(() => {});
  }
  return { pushed };
}

import jwt from 'jsonwebtoken';

function authPhaseApi(req) {
  const secret = cleanText(process.env.MINIPROGRAM_SYNC_SECRET || '', 500);
  if (!secret) return { ok: false, status: 503, error: 'miniprogram_sync_disabled' };
  const headerSecret = cleanText(req.headers['x-miniprogram-sync-secret'] || '', 500);
  const auth = cleanText(req.headers.authorization || '', 500);
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (headerSecret === secret || bearer === secret) return { ok: true, user: { username: 'system', role: 'system' } };
  if (bearer && process.env.JWT_SECRET) {
    try {
      const decoded = jwt.verify(bearer, process.env.JWT_SECRET);
      if (decoded && decoded.username) return { ok: true, user: { username: decoded.username, role: decoded.role || '' } };
    } catch (e) {}
  }
  return { ok: false, status: 401, error: 'unauthorized' };
}

// ── Phase 7a: Churn prediction (rule-based scoring) ───────────────────────────
async function computeChurnScores(pool, storeCode) {
  const store = cleanText(storeCode, 128);
  const today = todayShanghaiYmd();

  // Compute per-customer visit stats: avg cycle, last visit, spend trend, visit count trend
  const r = await pool.query(
    `WITH customer_visits AS (
       SELECT
         gc.id AS customer_id,
         gc.phone,
         COALESCE(NULLIF(gcp.source_signals->>'name',''), NULLIF(gc.meta->>'name',''), '') AS customer_name,
         COALESCE(gcp.store_id, gc.last_store_id, '') AS store_code,
         COUNT(po.id)::int AS total_orders,
         MAX(po.biz_date) AS last_visit,
         AVG(po.amount_after_discount) AS avg_spend,
         -- spend in last 30 vs prior 30 days
         COALESCE(SUM(po.amount_after_discount) FILTER (WHERE po.biz_date >= CURRENT_DATE - INTERVAL '30 day'), 0) AS spend_30d,
         COALESCE(SUM(po.amount_after_discount) FILTER (WHERE po.biz_date >= CURRENT_DATE - INTERVAL '60 day' AND po.biz_date < CURRENT_DATE - INTERVAL '30 day'), 0) AS spend_30_60d,
         -- visits in last 30 vs prior 30 days
         COUNT(po.id) FILTER (WHERE po.biz_date >= CURRENT_DATE - INTERVAL '30 day')::int AS visits_30d,
         COUNT(po.id) FILTER (WHERE po.biz_date >= CURRENT_DATE - INTERVAL '60 day' AND po.biz_date < CURRENT_DATE - INTERVAL '30 day')::int AS visits_30_60d
       FROM growth_customers gc
       LEFT JOIN growth_customer_profiles gcp ON gcp.customer_id = gc.id
       LEFT JOIN pos_orders po
         ON (po.customer_id = gc.id OR (po.customer_id IS NULL AND po.phone = gc.phone))
       WHERE ($1 = '' OR COALESCE(gcp.store_id, gc.last_store_id, '') = $1)
         AND gc.phone IS NOT NULL AND gc.phone <> ''
         AND po.biz_date IS NOT NULL
       GROUP BY gc.id, gc.phone, customer_name, store_code
       HAVING COUNT(po.id) >= 2
     )
     SELECT *,
       (CURRENT_DATE - last_visit)::int AS days_since_last,
       -- Rough avg cycle from first to last visit
       CASE WHEN total_orders > 1
         THEN ROUND(
           (last_visit - MIN(last_visit) OVER (PARTITION BY customer_id))::numeric / GREATEST(total_orders - 1, 1)
         )
         ELSE 30 END AS avg_cycle_days
     FROM customer_visits`,
    [store]
  );

  const predictions = [];
  for (const row of r.rows || []) {
    let score = 100;
    const factors = [];
    const daysSince = Number(row.days_since_last || 0);
    const avgCycle = Math.max(Number(row.avg_cycle_days || 30), 7);
    const spend30 = Number(row.spend_30d || 0);
    const spend3060 = Number(row.spend_30_60d || 0);
    const visits30 = Number(row.visits_30d || 0);
    const visits3060 = Number(row.visits_30_60d || 0);

    // Rule 1: exceeded avg return cycle
    if (daysSince > avgCycle) {
      score -= 20;
      factors.push(`超过平均回访周期${Math.round(daysSince / avgCycle * 10) / 10}倍`);
    }
    if (daysSince > avgCycle * 2) {
      score -= 20;
      factors.push('超过平均回访周期2倍');
    }

    // Rule 2: spend declining > 30%
    if (spend3060 > 0 && spend30 < spend3060 * 0.7) {
      const pct = Math.round((1 - spend30 / spend3060) * 100);
      score -= 20;
      factors.push(`消费金额环比下降${pct}%`);
    }

    // Rule 3: visit frequency declining
    if (visits3060 > 0 && visits30 < visits3060) {
      score -= 20;
      factors.push(`到店次数减少（近30天${visits30}次 vs 前30天${visits3060}次）`);
    }

    const spendTrendPct = spend3060 > 0
      ? Number(((spend30 - spend3060) / spend3060 * 100).toFixed(2))
      : 0;

    const riskLevel = score <= 40 ? 'high' : score <= 60 ? 'medium' : 'low';
    predictions.push({
      prediction_date: today,
      store_code: cleanText(row.store_code, 128),
      customer_id: Number(row.customer_id),
      phone: cleanText(row.phone, 32),
      customer_name: cleanText(row.customer_name, 80),
      churn_score: Math.max(0, score),
      risk_level: riskLevel,
      factors: JSON.stringify(factors),
      last_visit_days: daysSince,
      avg_visit_cycle_days: avgCycle,
      spend_trend_pct: spendTrendPct,
      visit_trend: visits30 - visits3060
    });
  }

  // Upsert all predictions
  let saved = 0;
  for (const p of predictions) {
    await pool.query(
      `INSERT INTO growth_churn_predictions
         (prediction_date, store_code, customer_id, phone, customer_name,
          churn_score, risk_level, factors, last_visit_days, avg_visit_cycle_days,
          spend_trend_pct, visit_trend)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
       ON CONFLICT (prediction_date, store_code, customer_id)
       DO UPDATE SET
         churn_score = EXCLUDED.churn_score,
         risk_level = EXCLUDED.risk_level,
         factors = EXCLUDED.factors,
         last_visit_days = EXCLUDED.last_visit_days,
         spend_trend_pct = EXCLUDED.spend_trend_pct,
         visit_trend = EXCLUDED.visit_trend`,
      [p.prediction_date, p.store_code, p.customer_id, p.phone, p.customer_name,
       p.churn_score, p.risk_level, p.factors, p.last_visit_days,
       p.avg_visit_cycle_days, p.spend_trend_pct, p.visit_trend]
    ).catch(() => {});
    saved++;
  }
  return { total: predictions.length, saved, high_risk: predictions.filter(p => p.risk_level === 'high').length };
}

// ── Phase 7b: Menu health report ─────────────────────────────────────────────
async function generateMenuHealthReport(pool, storeCode, reportMonth) {
  const store = cleanText(storeCode, 128);
  const month = safeMonthOnly(reportMonth) || todayShanghaiYmd().slice(0, 7);
  const prevMonth = (() => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();

  const storeCond = store ? `AND store_code = $3` : '';
  const params = [month, prevMonth, ...(store ? [store] : [])];

  // Current month sales per dish
  const r = await pool.query(
    `WITH cur AS (
       SELECT dish_name, category,
              SUM(qty)::numeric AS qty,
              SUM(amount_after_discount)::numeric AS revenue,
              AVG(unit_price)::numeric AS avg_price
       FROM pos_order_items
       WHERE TO_CHAR(biz_date, 'YYYY-MM') = $1 ${storeCond}
       GROUP BY dish_name, category
     ),
     prev AS (
       SELECT dish_name,
              SUM(qty)::numeric AS prev_qty,
              SUM(amount_after_discount)::numeric AS prev_revenue
       FROM pos_order_items
       WHERE TO_CHAR(biz_date, 'YYYY-MM') = $2 ${storeCond}
       GROUP BY dish_name
     ),
     total AS (SELECT SUM(revenue) AS total_rev FROM cur)
     SELECT c.dish_name, c.category, c.qty, c.revenue, c.avg_price,
            COALESCE(p.prev_qty, 0) AS prev_qty,
            COALESCE(p.prev_revenue, 0) AS prev_revenue,
            t.total_rev,
            CASE WHEN c.revenue > 0 AND t.total_rev > 0
                 THEN ROUND((c.revenue / t.total_rev * 100)::numeric, 2) ELSE 0 END AS revenue_share_pct,
            CASE WHEN p.prev_qty > 0
                 THEN ROUND(((c.qty - p.prev_qty) / p.prev_qty * 100)::numeric, 2) ELSE NULL END AS qty_mom_pct,
            CASE WHEN p.prev_revenue > 0
                 THEN ROUND(((c.revenue - p.prev_revenue) / p.prev_revenue * 100)::numeric, 2) ELSE NULL END AS rev_mom_pct
     FROM cur c
     LEFT JOIN prev p ON p.dish_name = c.dish_name
     CROSS JOIN total t
     ORDER BY c.revenue DESC`,
    params
  );

  const rows = r.rows || [];
  const totalRevAll = Number(rows[0]?.total_rev || 0);
  const medianRevShare = rows.length > 0
    ? Number(rows[Math.floor(rows.length / 2)]?.revenue_share_pct || 0)
    : 0;

  const growing = rows
    .filter(x => Number(x.qty_mom_pct || 0) > 10)
    .slice(0, 10)
    .map(x => ({ dish_name: x.dish_name, category: x.category, qty_mom_pct: Number(x.qty_mom_pct), revenue: Number(x.revenue) }));

  const declining = rows
    .filter(x => x.prev_qty > 0 && Number(x.qty_mom_pct || 0) < -10)
    .sort((a, b) => Number(a.qty_mom_pct || 0) - Number(b.qty_mom_pct || 0))
    .slice(0, 10)
    .map(x => ({ dish_name: x.dish_name, category: x.category, qty_mom_pct: Number(x.qty_mom_pct), revenue: Number(x.revenue) }));

  // High-profit (above avg price), low exposure (below median revenue share)
  const avgPrice = rows.length > 0
    ? rows.reduce((s, r) => s + Number(r.avg_price || 0), 0) / rows.length
    : 0;
  const highProfitLowExposure = rows
    .filter(x => Number(x.avg_price || 0) > avgPrice * 1.2 && Number(x.revenue_share_pct || 0) < medianRevShare)
    .slice(0, 10)
    .map(x => ({ dish_name: x.dish_name, category: x.category, avg_price: Number(x.avg_price), revenue_share_pct: Number(x.revenue_share_pct) }));

  const report = {
    report_month: month,
    store_code: store,
    period: { current: month, previous: prevMonth },
    summary: {
      total_dishes: rows.length,
      total_revenue: totalRevAll,
      growing_count: growing.length,
      declining_count: declining.length,
      high_profit_low_exposure_count: highProfitLowExposure.length
    },
    growing,
    declining,
    high_profit_low_exposure: highProfitLowExposure,
    top10: rows.slice(0, 10).map(x => ({
      dish_name: x.dish_name, category: x.category, revenue: Number(x.revenue),
      qty: Number(x.qty), revenue_share_pct: Number(x.revenue_share_pct), qty_mom_pct: x.qty_mom_pct
    })),
    recommendations: [
      ...growing.slice(0, 3).map(x => `【加大推广】${x.dish_name}：环比增长${x.qty_mom_pct}%，建议增加曝光`),
      ...declining.slice(0, 3).map(x => `【考虑调整】${x.dish_name}：环比下降${Math.abs(x.qty_mom_pct)}%，评估是否下架或优化`),
      ...highProfitLowExposure.slice(0, 3).map(x => `【值得主推】${x.dish_name}：均价¥${Number(x.avg_price).toFixed(0)}但曝光低（仅占${x.revenue_share_pct}%），有利润空间`)
    ]
  };

  const saved = await pool.query(
    `INSERT INTO growth_menu_health_reports (report_month, store_code, report_json, generated_by)
     VALUES ($1, $2, $3::jsonb, 'system')
     ON CONFLICT (report_month, store_code)
     DO UPDATE SET report_json = EXCLUDED.report_json, created_at = NOW()
     RETURNING *`,
    [month, store || '', JSON.stringify(report)]
  );
  return saved.rows[0] || null;
}

export async function ensurePhaseTables(pool) {
  // Phase 1: growth_coupons + sync_failures
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_coupons (
      id BIGSERIAL PRIMARY KEY, coupon_id TEXT UNIQUE NOT NULL,
      name TEXT, type TEXT DEFAULT 'cash', value_fen INTEGER DEFAULT 0,
      price_fen INTEGER DEFAULT 0, valid_days INTEGER DEFAULT 30,
      stock INTEGER DEFAULT -1, usage_rule TEXT, dish_name TEXT,
      is_active BOOLEAN DEFAULT TRUE, store_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_sync_failures (
      id BIGSERIAL PRIMARY KEY, source TEXT DEFAULT 'miniprogram',
      event_type TEXT, payload JSONB DEFAULT '{}'::jsonb, error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sync_failures_created ON growth_sync_failures (created_at DESC)`);

  // Phase 2: wechat_work_customers
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wechat_work_customers (
      id BIGSERIAL PRIMARY KEY, external_userid TEXT, name TEXT, phone TEXT,
      store_id TEXT, note TEXT, bind_customer_id BIGINT,
      import_batch TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ww_store ON wechat_work_customers (store_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ww_phone ON wechat_work_customers (phone) WHERE phone IS NOT NULL AND phone <> ''`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ww_external_userid ON wechat_work_customers (external_userid) WHERE external_userid IS NOT NULL AND external_userid <> ''`);

  // Phase 3: campaign_plans
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_campaign_plans (
      id BIGSERIAL PRIMARY KEY, plan_id TEXT UNIQUE, store_id TEXT,
      campaign_id TEXT, title TEXT NOT NULL, channel TEXT,
      voucher_template_id TEXT, target_audience TEXT DEFAULT 'all',
      coupon_value_fen INTEGER DEFAULT 0,
      budget_fen INTEGER DEFAULT 0, status TEXT DEFAULT 'draft',
      planned_start TIMESTAMPTZ, planned_end TIMESTAMPTZ,
      created_by TEXT DEFAULT 'admin', created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE growth_campaign_plans ADD COLUMN IF NOT EXISTS coupon_value_fen INTEGER DEFAULT 0`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_plans_store ON growth_campaign_plans (store_id, status, created_at DESC)`);

  // Phase 4: A/B tests + learnings
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ab_test_tasks (
      id BIGSERIAL PRIMARY KEY,
      test_name TEXT NOT NULL,
      store_code TEXT,
      test_type TEXT NOT NULL,
      target_metric TEXT NOT NULL,
      variant_a JSONB NOT NULL,
      variant_b JSONB NOT NULL,
      rotation_config JSONB DEFAULT '{"method":"time","a_days":[1,2,3],"b_days":[4,5,6,0]}'::jsonb,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      min_sample_size INTEGER DEFAULT 30,
      winner TEXT,
      winner_lift NUMERIC(5,2),
      ai_summary TEXT,
      status TEXT DEFAULT 'running',
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ab_test_tasks_store_status ON ab_test_tasks (store_code, status, created_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ab_test_results (
      id BIGSERIAL PRIMARY KEY,
      test_id BIGINT REFERENCES ab_test_tasks(id) ON DELETE CASCADE,
      result_date DATE NOT NULL,
      variant TEXT NOT NULL,
      sent INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      orders INTEGER DEFAULT 0,
      redemptions INTEGER DEFAULT 0,
      revenue NUMERIC(10,2) DEFAULT 0,
      conversion_rate NUMERIC(6,4),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(test_id, result_date, variant)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ab_test_results_test_date ON ab_test_results (test_id, result_date DESC, variant)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_learnings (
      id BIGSERIAL PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT,
      store_code TEXT,
      channel TEXT,
      scene TEXT,
      audience_tag TEXT,
      variable TEXT NOT NULL,
      winning_value TEXT NOT NULL,
      losing_value TEXT,
      effect_desc TEXT,
      sample_size INTEGER,
      confidence TEXT DEFAULT 'medium',
      valid_until DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_learnings_store ON growth_learnings (store_code, channel, created_at DESC)`);

  // Phase 5: content suggestions + performance
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_performance (
      id BIGSERIAL PRIMARY KEY,
      content_key TEXT UNIQUE,
      suggestion_id BIGINT,
      store_code TEXT,
      channel TEXT NOT NULL,
      scene TEXT,
      audience_tag TEXT,
      variable TEXT,
      content_title TEXT,
      content_body TEXT,
      winning_value TEXT,
      losing_value TEXT,
      impressions INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      orders INTEGER DEFAULT 0,
      redemptions INTEGER DEFAULT 0,
      revenue NUMERIC(10,2) DEFAULT 0,
      notes TEXT,
      recorded_by TEXT,
      published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE content_performance ADD COLUMN IF NOT EXISTS content_key TEXT`);
  await pool.query(`ALTER TABLE content_performance ADD COLUMN IF NOT EXISTS suggestion_id BIGINT`);
  await pool.query(`ALTER TABLE content_performance ADD COLUMN IF NOT EXISTS scene TEXT`);
  await pool.query(`ALTER TABLE content_performance ADD COLUMN IF NOT EXISTS audience_tag TEXT`);
  await pool.query(`ALTER TABLE content_performance ADD COLUMN IF NOT EXISTS variable TEXT`);
  await pool.query(`ALTER TABLE content_performance ADD COLUMN IF NOT EXISTS content_body TEXT`);
  await pool.query(`ALTER TABLE content_performance ADD COLUMN IF NOT EXISTS winning_value TEXT`);
  await pool.query(`ALTER TABLE content_performance ADD COLUMN IF NOT EXISTS losing_value TEXT`);
  await pool.query(`ALTER TABLE content_performance ADD COLUMN IF NOT EXISTS redemptions INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE content_performance ADD COLUMN IF NOT EXISTS revenue NUMERIC(10,2) DEFAULT 0`);
  await pool.query(`ALTER TABLE content_performance ADD COLUMN IF NOT EXISTS recorded_by TEXT`);
  await pool.query(`ALTER TABLE content_performance ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_content_performance_key ON content_performance (content_key) WHERE content_key IS NOT NULL AND content_key <> ''`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_content_performance_store ON content_performance (store_code, channel, created_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_content_suggestions (
      id BIGSERIAL PRIMARY KEY,
      suggestion_key TEXT UNIQUE NOT NULL,
      week_start DATE NOT NULL,
      store_code TEXT,
      summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      feishu_pushed_at TIMESTAMPTZ,
      generated_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_growth_content_suggestions_week ON growth_content_suggestions (week_start DESC, store_code)`);

  // Phase 6: unique dedup index on growth_learnings so ON CONFLICT works properly
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_growth_learnings_source
    ON growth_learnings (source_type, source_id)
    WHERE source_id IS NOT NULL AND source_id <> ''`);

  // Phase 7a: churn predictions
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_churn_predictions (
      id BIGSERIAL PRIMARY KEY,
      prediction_date DATE NOT NULL,
      store_code TEXT NOT NULL DEFAULT '',
      customer_id BIGINT NOT NULL,
      phone TEXT,
      customer_name TEXT,
      churn_score INTEGER DEFAULT 100,
      risk_level TEXT,
      factors JSONB DEFAULT '[]'::jsonb,
      last_visit_days INTEGER,
      avg_visit_cycle_days INTEGER,
      spend_trend_pct NUMERIC(6,2),
      visit_trend INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(prediction_date, store_code, customer_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_churn_predictions_date_risk ON growth_churn_predictions (prediction_date DESC, store_code, risk_level)`);

  // Phase 7b: menu health reports
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_menu_health_reports (
      id BIGSERIAL PRIMARY KEY,
      report_month TEXT NOT NULL,
      store_code TEXT NOT NULL DEFAULT '',
      report_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      generated_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(report_month, store_code)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_menu_health_month ON growth_menu_health_reports (report_month DESC, store_code)`);

  // Phase 8: content_calendar
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_content_calendar (
      id BIGSERIAL PRIMARY KEY, item_id TEXT UNIQUE, store_id TEXT,
      channel TEXT NOT NULL, publish_date DATE NOT NULL, title TEXT NOT NULL,
      content_brief TEXT, copy_text TEXT, image_url TEXT, campaign_id TEXT,
      qr_scene TEXT, status TEXT DEFAULT 'draft', assignee_username TEXT,
      result_scan_count INTEGER DEFAULT 0, result_revenue_fen INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_calendar_date ON growth_content_calendar (publish_date, store_id, channel)`);

  // Phase 9: POS orders (from KeruYun via Feishu bitable)
  // Column order matches KeruYun export: 编号,订单号,订单来源,营业日,下单时间,结账时间,订单状态,折前金额,总优惠金额,折后金额,支付方式,支付笔数,会员姓名,会员手机号,订单类型,桌台,就餐人数,就餐时长,+门店名称
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pos_orders (
      id BIGSERIAL PRIMARY KEY,
      seq_no TEXT,
      order_no TEXT NOT NULL,
      order_source TEXT,
      biz_date DATE,
      order_time TIMESTAMPTZ,
      checkout_time TIMESTAMPTZ,
      order_status TEXT,
      amount_before_discount NUMERIC DEFAULT 0,
      total_discount NUMERIC DEFAULT 0,
      amount_after_discount NUMERIC DEFAULT 0,
      payment_method TEXT,
      payment_count INTEGER DEFAULT 0,
      member_name TEXT,
      phone TEXT,
      order_type TEXT,
      table_no TEXT,
      diners INTEGER,
      duration TEXT,
      store_name TEXT,
      customer_id BIGINT,
      store_id TEXT,
      synced_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_orders_no ON pos_orders (order_no)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pos_orders_phone ON pos_orders (phone) WHERE phone IS NOT NULL AND phone <> ''`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pos_orders_date ON pos_orders (biz_date DESC, store_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pos_orders_customer ON pos_orders (customer_id) WHERE customer_id IS NOT NULL`);

  // Column order matches KeruYun export: 营业日,门店编号,门店名称,订单号,商品编码,商品名称,规格,菜品标签,单价,数量,单位,前折金额,服务费分摊,菜品优惠,折后金额,商品中类,商品大类
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pos_order_items (
      id BIGSERIAL PRIMARY KEY,
      biz_date DATE,
      store_code TEXT,
      store_name TEXT,
      order_no TEXT NOT NULL,
      sku TEXT,
      dish_name TEXT,
      spec TEXT,
      tags TEXT,
      unit_price NUMERIC DEFAULT 0,
      qty NUMERIC DEFAULT 0,
      unit TEXT,
      amount_before_discount NUMERIC DEFAULT 0,
      service_fee NUMERIC DEFAULT 0,
      discount NUMERIC DEFAULT 0,
      amount_after_discount NUMERIC DEFAULT 0,
      category_mid TEXT,
      category TEXT,
      synced_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    DELETE FROM pos_order_items a
    USING pos_order_items b
    WHERE a.id > b.id
      AND a.biz_date IS NOT DISTINCT FROM b.biz_date
      AND a.store_code IS NOT DISTINCT FROM b.store_code
      AND a.order_no = b.order_no
      AND a.sku IS NOT DISTINCT FROM b.sku
      AND a.dish_name IS NOT DISTINCT FROM b.dish_name
      AND a.spec IS NOT DISTINCT FROM b.spec
      AND a.tags IS NOT DISTINCT FROM b.tags
      AND a.unit_price IS NOT DISTINCT FROM b.unit_price
      AND a.qty IS NOT DISTINCT FROM b.qty
      AND a.unit IS NOT DISTINCT FROM b.unit
      AND a.amount_before_discount IS NOT DISTINCT FROM b.amount_before_discount
      AND a.service_fee IS NOT DISTINCT FROM b.service_fee
      AND a.discount IS NOT DISTINCT FROM b.discount
      AND a.amount_after_discount IS NOT DISTINCT FROM b.amount_after_discount
      AND a.category_mid IS NOT DISTINCT FROM b.category_mid
      AND a.category IS NOT DISTINCT FROM b.category
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_items_dedupe ON pos_order_items (
    order_no,
    biz_date,
    store_code,
    COALESCE(sku, ''),
    COALESCE(dish_name, ''),
    COALESCE(spec, ''),
    COALESCE(tags, ''),
    unit_price,
    qty,
    COALESCE(unit, ''),
    amount_before_discount,
    service_fee,
    discount,
    amount_after_discount,
    COALESCE(category_mid, ''),
    COALESCE(category, '')
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pos_items_order ON pos_order_items (order_no)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pos_items_dish ON pos_order_items (dish_name)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pos_items_cat ON pos_order_items (category) WHERE category IS NOT NULL`);
}

// ── Phase 9 helpers: parse KeruYun order data ──

const CN_OFFSET = 8 * 60 * 60 * 1000;
function parseKeruyunDateTime(val) {
  if (!val) return null;
  const n = Number(val);
  if (Number.isFinite(n) && n > 1e12) {
    return new Date(n).toISOString();
  }
  const s = String(val).trim().replace(/：/g, ':');
  const m = s.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})[日]?\s*(\d{1,2})?[：:]?(\d{1,2})?/);
  if (!m) return null;
  const d = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}T${(m[4]||'0').padStart(2,'0')}:${(m[5]||'0').padStart(2,'0')}:00`;
  const parsed = new Date(d);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
function cnDate(val) {
  if (!val) return null;
  const ts = Number(val);
  if (Number.isFinite(ts) && ts > 1e12) {
    return new Date(ts + CN_OFFSET).toISOString().slice(0, 10);
  }
  const dt = parseKeruyunDateTime(val);
  if (dt) return new Date(new Date(dt).getTime() + CN_OFFSET).toISOString().slice(0, 10);
  const s = String(val).trim().replace(/[\/年]/g, '-').replace(/月/g, '-').replace(/日/g, '');
  return s || null;
}

function parseKeruyunPhone(val) {
  if (!val || val === '-') return '';
  return String(val).replace(/[^0-9+]/g, '').slice(0, 32);
}

function parseNum(val) {
  const n = Number(String(val || '').replace(/[,，\s¥￥]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

async function refreshSalesGrowthSnapshot(pool, days = 3) {
  const r = await pool.query(`
    INSERT INTO sales_growth_snapshot
      (snapshot_date, store_code, dish_name, category, order_count, qty, revenue, avg_unit_price, lunch_qty, dinner_qty, updated_at)
    SELECT
      i.biz_date                                        AS snapshot_date,
      COALESCE(i.store_code, '')                        AS store_code,
      COALESCE(i.dish_name, '')                         AS dish_name,
      COALESCE(MAX(i.category), '')                      AS category,
      COUNT(DISTINCT i.order_no)                        AS order_count,
      SUM(i.qty)::INTEGER                               AS qty,
      SUM(i.amount_after_discount)                      AS revenue,
      CASE WHEN SUM(i.qty) > 0
           THEN ROUND(SUM(i.amount_after_discount) / SUM(i.qty), 2)
           ELSE 0 END                                   AS avg_unit_price,
      SUM(CASE WHEN EXTRACT(HOUR FROM i.order_time AT TIME ZONE 'Asia/Shanghai') BETWEEN 10 AND 13
               THEN i.qty ELSE 0 END)::INTEGER          AS lunch_qty,
      SUM(CASE WHEN EXTRACT(HOUR FROM i.order_time AT TIME ZONE 'Asia/Shanghai') BETWEEN 16 AND 20
               THEN i.qty ELSE 0 END)::INTEGER          AS dinner_qty,
      NOW()                                             AS updated_at
    FROM pos_order_items i
    WHERE i.biz_date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
      AND i.biz_date <= CURRENT_DATE
      AND i.dish_name IS NOT NULL AND i.dish_name <> ''
      AND i.store_code IS NOT NULL AND i.store_code <> ''
    GROUP BY i.biz_date, i.store_code, i.dish_name
    ON CONFLICT (snapshot_date, store_code, dish_name)
    DO UPDATE SET
      category       = EXCLUDED.category,
      order_count    = EXCLUDED.order_count,
      qty            = EXCLUDED.qty,
      revenue        = EXCLUDED.revenue,
      avg_unit_price = EXCLUDED.avg_unit_price,
      lunch_qty      = EXCLUDED.lunch_qty,
      dinner_qty     = EXCLUDED.dinner_qty,
      updated_at     = NOW()
  `, [days]);
  return r.rowCount;
}

async function linkPosOrdersToCustomers(pool) {
  const r = await pool.query(`
    UPDATE pos_orders o
    SET customer_id = gc.id
    FROM growth_customers gc
    WHERE o.phone <> '' AND o.phone = gc.phone AND o.customer_id IS NULL
  `);
  await pool.query(`
    UPDATE growth_customer_profiles gcp
    SET pos_order_count = s.order_cnt,
        pos_total_spend = s.total_spend,
        pos_dine_in_ratio = CASE WHEN s.order_cnt > 0 THEN
          ROUND(((s.dine_cnt)::numeric / s.order_cnt), 2) ELSE NULL END,
        pos_last_order_at = s.last_order
    FROM (
      SELECT gcp2.customer_id,
             COUNT(po.id)::int AS order_cnt,
             COALESCE(SUM(po.amount_after_discount),0) AS total_spend,
             COUNT(*) FILTER (WHERE po.order_type = '堂食') AS dine_cnt,
             MAX(po.order_time) AS last_order
      FROM growth_customer_profiles gcp2
      JOIN growth_customers gc ON gc.id = gcp2.customer_id
      JOIN pos_orders po ON po.phone = gc.phone
      WHERE gcp2.phone IS NOT NULL AND gcp2.phone <> ''
      GROUP BY gcp2.customer_id
    ) s
    WHERE gcp.customer_id = s.customer_id
  `);
  return r.rowCount;
}

export function registerPhaseRoutes(app, pool) {
  function rqa(req, res) {
    const auth = authPhaseApi(req);
    if (!auth.ok) { res.status(auth.status).json({ ok: false, error: auth.error }); return false; }
    return true;
  }

  // ── Phase 1: Coupons ──
  app.post('/api/growth/coupons', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO growth_coupons (coupon_id,name,type,value_fen,price_fen,valid_days,stock,usage_rule,dish_name,is_active,store_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (coupon_id) DO UPDATE SET name=EXCLUDED.name,is_active=EXCLUDED.is_active,updated_at=NOW() RETURNING *`,
      [cleanText(b.coupon_id,128),cleanText(b.name,300),cleanText(b.type||'cash',40),
       Math.max(0,Math.floor(Number(b.value_fen)||0)),Math.max(0,Math.floor(Number(b.price_fen)||0)),
       Math.max(1,Math.floor(Number(b.valid_days)||30)),Math.floor(Number(b.stock)!=null?Number(b.stock):-1),
       cleanText(b.usage_rule,500),cleanText(b.dish_name,500),b.is_active!==false,cleanText(b.store_id,128)]
    );
    res.json({ok:true,coupon:r.rows[0]});
  });
  app.get('/api/growth/coupons', async (req, res) => {
    if (!rqa(req, res)) return;
    const r = await pool.query('SELECT * FROM growth_coupons ORDER BY created_at DESC LIMIT 300');
    res.json({ok:true,coupons:r.rows});
  });

  // ── Phase 1: Sync Failures ──
  app.post('/api/growth/sync-failures', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    await pool.query('INSERT INTO growth_sync_failures (source,event_type,payload,error_message) VALUES ($1,$2,$3::jsonb,$4)',
      [cleanText(b.source,80),cleanText(b.event_type,80),JSON.stringify(b.payload||{}),cleanText(b.error_message,2000)]);
    res.json({ok:true});
  });
  app.get('/api/growth/sync-failures', async (req, res) => {
    if (!rqa(req, res)) return;
    const r = await pool.query('SELECT * FROM growth_sync_failures ORDER BY created_at DESC LIMIT 100');
    res.json({ok:true,failures:r.rows});
  });

  // ── Phase 2: WeChat Work ──
  app.post('/api/growth/wechat-work/import-feishu', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    const appToken = cleanText(b.app_token, 200);
    const tableId = cleanText(b.table_id, 200);
    const batch = `batch_${Date.now()}`;
    if (!appToken || !tableId) return res.status(400).json({ok:false,error:'missing app_token or table_id'});
    try {
      const mod = await import('../server/index.js');
      const getFeishuBitableData = mod.getFeishuBitableData || (await import('../index.js')).getFeishuBitableData;
      let records = [];
      try { const data = await getFeishuBitableData(appToken, tableId, b.access_token || ''); records = data?.data?.items || data?.data?.records || data?.items || []; } catch (e) { records = []; }
      let imported = 0;
      for (const rec of records) {
        const f = rec.fields || rec;
        const phone = cleanPhone(f.phone||f.手机号||f.mobile||'');
        const name = cleanText(f.name||f.姓名||f.昵称||'',200);
        const eid = cleanText(f.external_userid||f.userid||f.user_id||'',128);
        const sid = cleanText(f.store_id||f.门店||'',128);
        const note = cleanText(f.note||f.备注||'',500);
        if (phone||eid) {
          const ins = await pool.query('INSERT INTO wechat_work_customers(external_userid,name,phone,store_id,note,import_batch) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',
            [eid,name,phone,sid,note,batch]);
          if (ins.rows.length) imported++;
        }
      }
      const matched = await pool.query(
        `UPDATE wechat_work_customers w SET bind_customer_id=g.id,updated_at=NOW()
         FROM growth_customers g WHERE w.phone=g.phone AND w.bind_customer_id IS NULL AND w.import_batch=$1`,[batch]);
      res.json({ok:true,imported,matched:matched.rowCount||0,batch});
    } catch (e) { res.status(500).json({ok:false,error:e?.message||'import_failed'}); }
  });

  app.post('/api/growth/wechat-work/customers', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    const batch = `manual_${Date.now()}`;
    const customers = Array.isArray(b.customers) ? b.customers : [b];
    let imported = 0;
    for (const c of customers) {
      const phone = cleanPhone(c.phone||'');
      if (phone) {
        await pool.query('INSERT INTO wechat_work_customers(external_userid,name,phone,store_id,note,import_batch) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
          [cleanText(c.external_userid,128),cleanText(c.name,200),phone,cleanText(c.store_id,128),cleanText(c.note,500),batch]);
        imported++;
      }
    }
    const matched = await pool.query(
      `UPDATE wechat_work_customers w SET bind_customer_id=g.id,updated_at=NOW()
       FROM growth_customers g WHERE w.phone=g.phone AND w.bind_customer_id IS NULL AND w.import_batch=$1`,[batch]);
    res.json({ok:true,imported,matched:matched.rowCount||0,batch});
  });

  app.get('/api/growth/wechat-work/customers', async (req, res) => {
    if (!rqa(req, res)) return;
    const sid = cleanText(req.query.store_id||'',128);
    const r = await pool.query(
      `SELECT w.*,g.openid bound_openid,g.phone bound_phone FROM wechat_work_customers w LEFT JOIN growth_customers g ON w.bind_customer_id=g.id
       WHERE ($1='' OR w.store_id=$1) ORDER BY w.created_at DESC LIMIT 500`,[sid]);
    const total = r.rows.length;
    const bound = r.rows.filter(x=>x.bind_customer_id).length;
    res.json({ok:true,total,bound,unbound:total-bound,customers:r.rows});
  });

  app.get('/api/growth/wechat-work/stats', async (req, res) => {
    if (!rqa(req, res)) return;
    const r = await pool.query(`SELECT store_id,COUNT(*)::int total,
      COUNT(*) FILTER(WHERE bind_customer_id IS NOT NULL)::int bound,
      COUNT(*) FILTER(WHERE bind_customer_id IS NULL)::int unbound
      FROM wechat_work_customers GROUP BY store_id ORDER BY store_id`);
    res.json({ok:true,stats:r.rows});
  });

  // ── Phase 3: Campaign Plans + Rankings ──
  app.post('/api/growth/campaign-plans', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO growth_campaign_plans(plan_id,store_id,campaign_id,title,channel,voucher_template_id,target_audience,coupon_value_fen,budget_fen,status,planned_start,planned_end,created_by,source_template_id,recommended_poster_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT(plan_id) DO UPDATE SET title=EXCLUDED.title,status=EXCLUDED.status,channel=EXCLUDED.channel,target_audience=EXCLUDED.target_audience,coupon_value_fen=EXCLUDED.coupon_value_fen,budget_fen=EXCLUDED.budget_fen,source_template_id=EXCLUDED.source_template_id,recommended_poster_id=EXCLUDED.recommended_poster_id,updated_at=NOW() RETURNING *`,
      [cleanText(b.plan_id,128),cleanText(b.store_id,128),cleanText(b.campaign_id,128),cleanText(b.title,500),
       cleanText(b.channel,80),cleanText(b.voucher_template_id,128),cleanText(b.target_audience||'all',200),
       Math.max(0,Math.floor(Number(b.coupon_value_fen)||0)),Math.max(0,Math.floor(Number(b.budget_fen)||0)),cleanText(b.status||'draft',40),
       b.planned_start?parseOccurredAt(b.planned_start):null,b.planned_end?parseOccurredAt(b.planned_end):null,
       cleanText(b.created_by||'admin',80),
       b.source_template_id?Number(b.source_template_id):null,
       b.recommended_poster_id?Number(b.recommended_poster_id):null]
    );
    if (b.source_template_id) {
      pool.query('UPDATE marketing_templates SET use_count = use_count + 1 WHERE id = $1', [Number(b.source_template_id)]).catch(() => {});
    }
    res.json({ok:true,plan:r.rows[0]});
  });

  app.get('/api/growth/campaign-plans', async (req, res) => {
    if (!rqa(req, res)) return;
    const sid = cleanText(req.query.store_id||'',128);
    const st = cleanText(req.query.status||'',40);
    const r = await pool.query(`SELECT * FROM growth_campaign_plans WHERE ($1='' OR store_id=$1) AND ($2='' OR status=$2) ORDER BY created_at DESC LIMIT 200`,[sid,st]);
    res.json({ok:true,plans:r.rows});
  });

  app.get('/api/growth/marketing-templates', async (req, res) => {
    if (!rqa(req, res)) return;
    const r = await pool.query('SELECT id, name, category, description, actions, expected_roi, budget_range, duration_days, success_rate, use_count, channel, target_audience, payload_template FROM marketing_templates ORDER BY success_rate DESC NULLS LAST, use_count DESC');
    res.json({ok:true,templates:r.rows});
  });

  app.post('/api/growth/marketing-templates', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO marketing_templates(name,category,description,actions,expected_roi,budget_range,duration_days,success_rate,channel,target_audience,payload_template)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [cleanText(b.name,200),cleanText(b.category,80),cleanText(b.description,1000),
       JSON.stringify(b.actions||[]),Number(b.expected_roi)||0,cleanText(b.budget_range,100),
       Math.max(1,Math.floor(Number(b.duration_days)||7)),Number(b.success_rate)||0,
       cleanText(b.channel,80),cleanText(b.target_audience||'all',200),
       JSON.stringify(b.payload_template||{})]
    );
    res.json({ok:true,template:r.rows[0]});
  });

  app.patch('/api/growth/campaign-plans/:id/status', async (req, res) => {
    const auth = authPhaseApi(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    const id = cleanText(req.params.id, 128);
    const status = cleanText(req.body.status, 40);
    if (!['draft','active','completed','cancelled'].includes(status)) {
      return res.status(400).json({ ok: false, error: 'invalid_status' });
    }
    const before = await pool.query(
      `SELECT * FROM growth_campaign_plans WHERE (plan_id=$1 OR campaign_id=$1) LIMIT 1`,
      [id]
    );
    if (!before.rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
    const r = await pool.query(
      `UPDATE growth_campaign_plans SET status=$1, updated_at=NOW() WHERE (plan_id=$2 OR campaign_id=$2) RETURNING *`,
      [status, id]
    );
    const plan = r.rows[0];
    let execution = null;
    if (status === 'active' && before.rows[0].status !== 'active') {
      const previous = before.rows[0];
      const actionKey = `manual_activate_${cleanText(plan.plan_id || plan.campaign_id || id, 120)}_${Date.now()}`;
      const plannedStart = previous.planned_start ? new Date(previous.planned_start) : null;
      const plannedEnd = previous.planned_end ? new Date(previous.planned_end) : null;
      const validDays = plannedStart && plannedEnd ? Math.max(1, Math.ceil((plannedEnd.getTime() - plannedStart.getTime()) / 86400000)) : 7;
      const payload = {
        store_id: previous.store_id || '',
        plan_id: previous.plan_id || '',
        campaign_id: previous.campaign_id || '',
        channel: previous.channel || 'miniprogram',
        target_audience: previous.target_audience || 'all',
        budget_fen: Number(previous.budget_fen || 0),
        coupon_value_fen: Number(previous.coupon_value_fen || previous.voucher_template_id || 0),
        valid_days: validDays,
        source_template_id: previous.source_template_id || null,
        recommended_poster_id: previous.recommended_poster_id || null,
        execution_action: '手动激活活动计划'
      };
      await pool.query(
        `INSERT INTO growth_actions (action_key, action_type, status, store_id, campaign_id, title, detail, payload, created_by)
         VALUES ($1,'campaign_activate','proposed',$2,$3,$4,$5,$6::jsonb,$7)`,
        [
          actionKey,
          previous.store_id || '',
          previous.campaign_id || '',
          previous.title || '手动激活活动',
          `活动 ${previous.title || previous.campaign_id || previous.plan_id || id} 已手动激活`,
          JSON.stringify(payload),
          auth.user?.username || previous.created_by || 'admin'
        ]
      );
      const actionRow = {
        action_key: actionKey,
        action_type: 'campaign_activate',
        store_id: previous.store_id || '',
        campaign_id: previous.campaign_id || '',
        title: previous.title || '手动激活活动',
        detail: `活动 ${previous.title || previous.campaign_id || previous.plan_id || id} 已手动激活`,
        payload
      };
      execution = await executeGrowthActionRecord(pool, actionRow, {
        username: auth.user?.username || previous.created_by || 'admin',
        role: auth.user?.role || 'admin'
      }, {}, '手动激活活动');
    }
    res.json({ ok: true, plan, execution });
  });

  app.delete('/api/growth/marketing-templates/:id', async (req, res) => {
    if (!rqa(req, res)) return;
    await pool.query('DELETE FROM marketing_templates WHERE id = $1', [Number(req.params.id)]);
    res.json({ok:true});
  });

  app.get('/api/growth/store-rankings', async (req, res) => {
    if (!rqa(req, res)) return;
    const days = Math.min(Math.max(Number(req.query.days)||7,1),90);
    const r = await pool.query(
      `SELECT dm.store_id,SUM(dm.scan_count)::int scan_count,SUM(dm.authorized_count)::int auth_count,
              SUM(dm.coupon_issued_count)::int issued_count,SUM(dm.coupon_redeemed_count)::int redeemed_count,
              SUM(dm.payment_count)::int payment_count,SUM(dm.revenue_fen)::int revenue_fen,
              COUNT(DISTINCT dm.campaign_id)::int active_campaigns
       FROM growth_daily_metrics dm WHERE dm.metric_date>=CURRENT_DATE-($1::int||' days')::interval
       GROUP BY dm.store_id ORDER BY revenue_fen DESC,scan_count DESC LIMIT 200`,[days]);
    res.json({ok:true,rankings:r.rows.map((row,i)=>({rank:i+1,...row}))});
  });

  // ── Phase 8: Content Calendar + Channel Effects ──
  app.post('/api/growth/content-calendar', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO growth_content_calendar(item_id,store_id,channel,publish_date,title,content_brief,copy_text,image_url,campaign_id,qr_scene,status,assignee_username)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(item_id) DO UPDATE SET title=EXCLUDED.title,copy_text=EXCLUDED.copy_text,status=EXCLUDED.status,updated_at=NOW() RETURNING *`,
      [cleanText(b.item_id,128),cleanText(b.store_id,128),cleanText(b.channel,80),
       b.publish_date?b.publish_date.slice(0,10):new Date().toISOString().slice(0,10),cleanText(b.title,500),
       cleanText(b.content_brief,2000),cleanText(b.copy_text,4000),cleanText(b.image_url,1000),
       cleanText(b.campaign_id,128),cleanText(b.qr_scene,255),cleanText(b.status||'draft',40),cleanText(b.assignee_username,128)]
    );
    res.json({ok:true,item:r.rows[0]});
  });

  app.get('/api/growth/content-calendar', async (req, res) => {
    if (!rqa(req, res)) return;
    const sid = cleanText(req.query.store_id||'',128);
    const ch = cleanText(req.query.channel||'',80);
    const r = await pool.query(`SELECT * FROM growth_content_calendar WHERE ($1='' OR store_id=$1) AND ($2='' OR channel=$2) ORDER BY publish_date DESC LIMIT 300`,[sid,ch]);
    res.json({ok:true,items:r.rows});
  });

  app.get('/api/growth/content-calendar/upcoming', async (req, res) => {
    if (!rqa(req, res)) return;
    const sid = cleanText(req.query.store_id||'',128);
    const r = await pool.query(`SELECT * FROM growth_content_calendar WHERE publish_date>=CURRENT_DATE AND ($1='' OR store_id=$1) ORDER BY publish_date ASC LIMIT 30`,[sid]);
    res.json({ok:true,items:r.rows});
  });

  app.get('/api/growth/channel-effects', async (req, res) => {
    if (!rqa(req, res)) return;
    const days = Math.min(Math.max(Number(req.query.days)||30,1),365);
    const r = await pool.query(
      `SELECT gc.channel,COUNT(*)::int total_items,
              COUNT(*) FILTER(WHERE gc.status='published')::int published,
              SUM(gc.result_scan_count)::int total_scans,
              SUM(gc.result_revenue_fen)::int total_revenue_fen
       FROM growth_content_calendar gc WHERE gc.publish_date>=CURRENT_DATE-($1::int||' days')::interval
       GROUP BY gc.channel ORDER BY total_revenue_fen DESC`,[days]);
    res.json({ok:true,effects:r.rows});
  });

  // ── Phase 9: POS Orders (KeruYun via Feishu bitable or direct upload) ──

  app.post('/api/growth/pos-orders', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    const { orders = [], items = [] } = b;
    if (!orders.length && !items.length) return res.status(400).json({ok:false,error:'missing orders or items'});

    const storeId = cleanText(b.store_id || '', 128);
    let ordersUpserted = 0, itemsUpserted = 0;

    if (orders.length) {
      for (const o of orders) {
            const phone = parseKeruyunPhone(o.phone || o.member_phone || '');
           const bizDate = cnDate(o.biz_date);
        await pool.query(`
          INSERT INTO pos_orders(seq_no,order_no,order_source,biz_date,order_time,checkout_time,order_status,amount_before_discount,total_discount,amount_after_discount,payment_method,payment_count,member_name,phone,order_type,table_no,diners,duration,store_name,store_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
          ON CONFLICT(order_no) DO UPDATE SET
            order_source=EXCLUDED.order_source,
            checkout_time=COALESCE(EXCLUDED.checkout_time,pos_orders.checkout_time),
            order_status=COALESCE(EXCLUDED.order_status,pos_orders.order_status),
            amount_before_discount=EXCLUDED.amount_before_discount,total_discount=EXCLUDED.total_discount,
            amount_after_discount=EXCLUDED.amount_after_discount,
            payment_method=COALESCE(EXCLUDED.payment_method,pos_orders.payment_method),
            payment_count=EXCLUDED.payment_count,
            phone=COALESCE(NULLIF(EXCLUDED.phone,''),pos_orders.phone),
            member_name=COALESCE(NULLIF(EXCLUDED.member_name,'-'),NULLIF(EXCLUDED.member_name,''),pos_orders.member_name),
            table_no=COALESCE(NULLIF(EXCLUDED.table_no,''),pos_orders.table_no),
            diners=COALESCE(EXCLUDED.diners,pos_orders.diners),
            duration=COALESCE(NULLIF(EXCLUDED.duration,''),pos_orders.duration),
            store_name=COALESCE(NULLIF(EXCLUDED.store_name,''),pos_orders.store_name),
            seq_no=COALESCE(NULLIF(EXCLUDED.seq_no,''),pos_orders.seq_no),
            synced_at=NOW()
        `, [
          cleanText(o.seq_no || '', 32), cleanText(o.order_no || '', 64),
          cleanText(o.order_source || '', 80), bizDate || null,
          parseKeruyunDateTime(o.order_time), parseKeruyunDateTime(o.checkout_time),
          cleanText(o.order_status || '', 40), parseNum(o.amount_before_discount), parseNum(o.total_discount),
          parseNum(o.amount_after_discount),
          cleanText(o.payment_method || '', 80), Number(o.payment_count) || 0,
          cleanText(o.member_name || '', 100), phone,
          cleanText(o.order_type || '', 40), cleanText(o.table_no || '', 40),
          Number(o.diners) || null, cleanText(o.duration || '', 40),
          cleanText(o.store_name || '', 200), storeId || cleanText(o.store_id || '', 128)
        ]);
        ordersUpserted++;
      }
    }

      if (items.length) {
       for (const it of items) {
         const itemBizDate = cnDate(it.biz_date);
             await pool.query(`
              INSERT INTO pos_order_items(biz_date,store_name,store_code,order_no,sku,dish_name,department,table_name,table_area,sale_type,category_mid,category,spec,unit,order_type,order_source,qty,amount_before_discount,discount,service_fee,amount_after_discount,order_time,checkout_time)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
              ON CONFLICT DO NOTHING
            `, [
              itemBizDate || null, cleanText(it.store_name || '', 200), cleanText(it.store_code || '', 64),
              cleanText(it.order_no || '', 128), cleanText(it.sku || '', 64), cleanText(it.dish_name || '', 300),
              cleanText(it.department || '', 100), cleanText(it.table_name || '', 100), cleanText(it.table_area || '', 100),
              cleanText(it.sale_type || '', 40),
              cleanText(it.category_mid || '', 100), cleanText(it.category || '', 100),
              cleanText(it.spec || '', 100), cleanText(it.unit || '', 20),
              cleanText(it.order_type || '', 40), cleanText(it.order_source || '', 200),
              parseNum(it.qty), parseNum(it.amount_before_discount),
              parseNum(it.discount), parseNum(it.service_fee), parseNum(it.amount_after_discount),
              parseKeruyunDateTime(it.order_time), parseKeruyunDateTime(it.checkout_time)
            ]);
        itemsUpserted++;
      }
    }

    const linked = await linkPosOrdersToCustomers(pool);
    res.json({ok:true, orders_upserted: ordersUpserted, items_upserted: itemsUpserted, customers_linked: linked});
  });

  app.get('/api/growth/pos-orders', async (req, res) => {
    if (!rqa(req, res)) return;
    const sid = cleanText(req.query.store_id || '', 128);
    const phone = cleanText(req.query.phone || '', 32);
    const from = req.query.from || '';
    const to = req.query.to || '';
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const conds = ['1=1'];
    const params = [];
    let pi = 1;
    if (sid) { conds.push(`store_id=$${pi++}`); params.push(sid); }
    if (phone) { conds.push(`phone=$${pi++}`); params.push(phone); }
    if (from) { conds.push(`biz_date>=$${pi++}`); params.push(from); }
    if (to) { conds.push(`biz_date<=$${pi++}`); params.push(to); }
    params.push(limit);
    const r = await pool.query(`SELECT * FROM pos_orders WHERE ${conds.join(' AND ')} ORDER BY biz_date DESC, order_time DESC LIMIT $${pi}`, params);
    res.json({ok:true, orders: r.rows});
  });

  app.get('/api/growth/pos-order-items', async (req, res) => {
    if (!rqa(req, res)) return;
    const orderNo = cleanText(req.query.order_no || '', 64);
    if (!orderNo) return res.status(400).json({ok:false,error:'missing order_no'});
    const r = await pool.query('SELECT * FROM pos_order_items WHERE order_no=$1 ORDER BY id', [orderNo]);
    res.json({ok:true, items: r.rows});
  });

  app.get('/api/growth/customer-orders', async (req, res) => {
    if (!rqa(req, res)) return;
    const phone = cleanText(req.query.phone || '', 32);
    const cid = req.query.customer_id ? Number(req.query.customer_id) : null;
    if (!phone && !cid) return res.status(400).json({ok:false,error:'missing phone or customer_id'});
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    let r;
    if (phone) {
      r = await pool.query('SELECT * FROM pos_orders WHERE phone=$1 ORDER BY biz_date DESC LIMIT $2', [phone, limit]);
    } else {
      r = await pool.query('SELECT * FROM pos_orders WHERE customer_id=$1 ORDER BY biz_date DESC LIMIT $2', [cid, limit]);
    }
    res.json({ok:true, orders: r.rows});
  });

  app.get('/api/growth/pos-linked-customers', async (req, res) => {
    if (!rqa(req, res)) return;
    const sid = cleanText(req.query.store_id || '', 128);
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const r = await pool.query(`
      SELECT po.phone, gc.id AS customer_id, gc.openid, gcp.lifecycle_stage, gcp.price_sensitivity,
             COUNT(*)::int AS order_count, SUM(po.amount_after_discount) AS total_revenue,
             MIN(po.biz_date) AS first_order, MAX(po.biz_date) AS last_order
      FROM pos_orders po
      LEFT JOIN growth_customers gc ON po.phone = gc.phone
      LEFT JOIN growth_customer_profiles gcp ON gc.id = gcp.customer_id
      WHERE po.phone <> '' AND po.biz_date >= CURRENT_DATE - ($1::int || ' days')::interval
        AND ($2='' OR po.store_id=$2)
      GROUP BY po.phone, gc.id, gc.openid, gcp.lifecycle_stage, gcp.price_sensitivity
      ORDER BY total_revenue DESC NULLS LAST LIMIT 200
    `, [days, sid]);
    res.json({ok:true, linked: r.rows});
  });

  app.post('/api/growth/pos-link-customers', async (req, res) => {
    if (!rqa(req, res)) return;
    const linked = await linkPosOrdersToCustomers(pool);
    res.json({ok:true, customers_linked: linked});
  });

  // ── POS consumption stats ──
  app.get('/api/growth/pos-stats', async (req, res) => {
    if (!rqa(req, res)) return;
    const sid = cleanText(req.query.store_id || req.query.store_name || '', 200);
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const byName = /[\u4e00-\u9fff\uff08\uff09【】]/.test(sid);
    const posCond = sid ? (byName ? `store_name = $1` : `store_id = $1`) : `$1::text = ''`;
    const itemsCond = sid ? (byName ? `store_name = $1` : `store_code = $1`) : `$1::text = ''`;
    const profCond = sid ? `store_id = $1` : `$1::text = ''`;
    const statsParams = [sid, days];

    const [
      summaryR, storeR, hourR, payR, dishR, repeatR
    ] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total_orders,
        COALESCE(SUM(amount_after_discount),0)::numeric AS total_revenue,
        ROUND(AVG(amount_after_discount),2) AS avg_check,
        COUNT(DISTINCT phone) AS distinct_phones,
        COUNT(*) FILTER (WHERE phone IS NOT NULL AND phone <> '')::int AS identified_orders
        FROM pos_orders
        WHERE ${posCond}
          AND biz_date >= CURRENT_DATE - ($2::int || ' days')::interval`, statsParams),
      pool.query(`SELECT store_id, store_name, COUNT(*)::int AS orders,
        ROUND(AVG(amount_after_discount),2) AS avg_check,
        COALESCE(SUM(amount_after_discount),0)::numeric AS total_revenue
        FROM pos_orders
        WHERE ${posCond}
          AND biz_date >= CURRENT_DATE - ($2::int || ' days')::interval
        GROUP BY store_id, store_name ORDER BY total_revenue DESC`, statsParams),
      pool.query(`SELECT EXTRACT(HOUR FROM order_time)::int AS hour, COUNT(*)::int AS orders,
        COALESCE(SUM(amount_after_discount),0)::numeric AS revenue
        FROM pos_orders
        WHERE order_time IS NOT NULL
          AND ${posCond}
          AND biz_date >= CURRENT_DATE - ($2::int || ' days')::interval
        GROUP BY 1 ORDER BY 1`, statsParams),
      pool.query(`SELECT
        CASE
          WHEN payment_method LIKE '%微信%' THEN '微信'
          WHEN payment_method LIKE '%支付宝%' THEN '支付宝'
          WHEN payment_method LIKE '%会员卡%' THEN '会员卡'
          WHEN payment_method LIKE '%现金%' THEN '现金'
          WHEN payment_method LIKE '%套餐%' THEN '套餐'
          WHEN payment_method LIKE '%代金券%' THEN '代金券'
          ELSE '其他'
        END AS pay_group,
        COUNT(*)::int AS orders,
        COALESCE(SUM(amount_after_discount),0)::numeric AS revenue
        FROM pos_orders
        WHERE ${posCond}
          AND biz_date >= CURRENT_DATE - ($2::int || ' days')::interval
        GROUP BY 1 ORDER BY orders DESC`, statsParams),
      pool.query(`SELECT category, dish_name,
        SUM(qty)::int AS total_qty,
        COALESCE(SUM(amount_after_discount),0)::numeric AS revenue
        FROM pos_order_items WHERE order_no IN (
          SELECT order_no FROM pos_orders
          WHERE ${posCond}
            AND biz_date >= CURRENT_DATE - ($2::int || ' days')::interval
        ) AND category IS NOT NULL AND category <> '-'
        GROUP BY category, dish_name
        ORDER BY revenue DESC LIMIT 15`, statsParams),
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE order_cnt = 1)::int AS one_timer,
        COUNT(*) FILTER (WHERE order_cnt = 2)::int AS two_timer,
        COUNT(*) FILTER (WHERE order_cnt >= 3)::int AS repeat_3plus,
        COUNT(*)::int AS total_customers
        FROM (
          SELECT phone, COUNT(*)::int AS order_cnt
          FROM pos_orders
          WHERE phone IS NOT NULL AND phone <> ''
            AND ${posCond}
            AND biz_date >= CURRENT_DATE - ($2::int || ' days')::interval
          GROUP BY phone
        ) sub`, statsParams)
    ]);

    const [byOrderTypeR, byOrderSourceR, byDeptR, lifecycleR, spendDistR, visitR, dishCatR, highValueR, custOrderTypeR, custOrderSourceR, custDeptR, valueTierR, repurchase30R] = await Promise.all([
      pool.query(`SELECT order_type, COUNT(*)::int AS cnt,
        COALESCE(SUM(amount_after_discount),0)::numeric AS revenue,
        COALESCE(SUM(qty),0)::int AS total_qty
        FROM pos_order_items
        WHERE ${itemsCond}
          AND biz_date >= CURRENT_DATE - ($2::int || ' days')::interval
        GROUP BY order_type ORDER BY revenue DESC`, statsParams),
      pool.query(`SELECT order_source, COUNT(*)::int AS cnt,
        COALESCE(SUM(amount_after_discount),0)::numeric AS revenue,
        COALESCE(SUM(qty),0)::int AS total_qty
        FROM pos_order_items
        WHERE ${itemsCond}
          AND biz_date >= CURRENT_DATE - ($2::int || ' days')::interval
        GROUP BY order_source ORDER BY revenue DESC`, statsParams),
      pool.query(`SELECT department, COUNT(*)::int AS cnt,
        COALESCE(SUM(amount_after_discount),0)::numeric AS revenue,
        COALESCE(SUM(qty),0)::int AS total_qty
        FROM pos_order_items
        WHERE ${itemsCond}
          AND biz_date >= CURRENT_DATE - ($2::int || ' days')::interval
          AND department IS NOT NULL AND department <> ''
        GROUP BY department ORDER BY revenue DESC`, statsParams),
      // 权威生命周期分布：直接取 growth_customer_profiles 的新6阶段（不按时间窗过滤，
      // 否则流失/沉睡客因近期无订单会被结构性漏掉，看不到真实流失情况）
      pool.query(`SELECT lifecycle_stage, COUNT(*)::int AS cnt
        FROM growth_customer_profiles
        WHERE ${profCond}
        GROUP BY lifecycle_stage ORDER BY cnt DESC`, [sid]),
      pool.query(`SELECT CASE
          WHEN avg_check < 200 THEN '0-200'
          WHEN avg_check < 400 THEN '200-400'
          WHEN avg_check < 600 THEN '400-600'
          WHEN avg_check < 800 THEN '600-800'
          ELSE '800+' END AS spend_tier, COUNT(*)::int AS cnt
        FROM (
          SELECT phone, AVG(amount_after_discount) AS avg_check
          FROM pos_orders
          WHERE phone IS NOT NULL AND phone <> ''
            AND ${posCond}
            AND biz_date >= CURRENT_DATE - ($2::int || ' days')::interval
          GROUP BY phone
        ) sub
        GROUP BY 1 ORDER BY 1`, statsParams),
      pool.query(`SELECT CASE
          WHEN EXTRACT(HOUR FROM order_time) BETWEEN 10 AND 14 THEN '午市(10-14点)'
          WHEN EXTRACT(HOUR FROM order_time) BETWEEN 17 AND 21 THEN '晚市(17-21点)'
          ELSE '其他时段' END AS visit_time, COUNT(*)::int AS cnt
        FROM pos_orders
        WHERE phone IS NOT NULL AND phone <> ''
          AND order_time IS NOT NULL
          AND ${posCond}
          AND biz_date >= CURRENT_DATE - ($2::int || ' days')::interval
        GROUP BY 1 ORDER BY cnt DESC`, statsParams),
      pool.query(`SELECT category, SUM(qty)::int AS total_qty FROM pos_order_items WHERE order_no IN (
          SELECT order_no FROM pos_orders
          WHERE phone IS NOT NULL AND phone <> ''
            AND ${posCond}
            AND biz_date >= CURRENT_DATE - ($2::int || ' days')::interval
        ) AND category IS NOT NULL AND category <> '-' GROUP BY category ORDER BY total_qty DESC LIMIT 5`, statsParams),
      pool.query(`SELECT COUNT(*)::int AS count, ROUND(AVG(pos_total_spend)::numeric, 2) AS avg_spending, ROUND(AVG(pos_order_count)::numeric, 1) AS avg_orders
        FROM growth_customer_profiles
        WHERE pos_total_spend > 0
          AND ${profCond}`, [sid]),
      pool.query(`SELECT order_type, COUNT(*)::int AS cnt
        FROM pos_order_items WHERE order_no IN (
          SELECT order_no FROM pos_orders
          WHERE phone IS NOT NULL AND phone <> ''
            AND ${posCond}
            AND biz_date >= CURRENT_DATE - ($2::int || ' days')::interval
        ) AND order_type IS NOT NULL AND order_type <> ''
        GROUP BY order_type ORDER BY cnt DESC`, statsParams),
      pool.query(`SELECT order_source, COUNT(*)::int AS cnt
        FROM pos_order_items WHERE order_no IN (
          SELECT order_no FROM pos_orders
          WHERE phone IS NOT NULL AND phone <> ''
            AND ${posCond}
            AND biz_date >= CURRENT_DATE - ($2::int || ' days')::interval
        ) AND order_source IS NOT NULL AND order_source <> ''
        GROUP BY order_source ORDER BY cnt DESC`, statsParams),
      pool.query(`SELECT department, SUM(qty)::int AS total_qty
        FROM pos_order_items WHERE order_no IN (
          SELECT order_no FROM pos_orders
          WHERE phone IS NOT NULL AND phone <> ''
            AND ${posCond}
            AND biz_date >= CURRENT_DATE - ($2::int || ' days')::interval
        ) AND department IS NOT NULL AND department <> ''
        GROUP BY department ORDER BY total_qty DESC`, statsParams),
      // 价值分级分布（VIP/regular/low），用于看板展示 VIP 维度
      pool.query(`SELECT value_tier, COUNT(*)::int AS cnt
        FROM growth_customer_profiles
        WHERE ${profCond}
        GROUP BY value_tier ORDER BY cnt DESC`, [sid]),
      // 复购率：固定30天窗口内，下单≥2次的客户占比（不受看板时间筛选影响）
      pool.query(`SELECT
          COUNT(*) FILTER (WHERE order_cnt >= 2)::int AS repurchasers,
          COUNT(*)::int AS total_with_orders
        FROM (
          SELECT phone, COUNT(*)::int AS order_cnt
          FROM pos_orders
          WHERE phone IS NOT NULL AND phone <> ''
            AND ${posCond}
            AND biz_date >= CURRENT_DATE - INTERVAL '30 days'
          GROUP BY phone
        ) sub`, [sid])
    ]);

    // 客户流失率 = (沉睡老客 + 流失低频客) / 曾消费客户总数（排除从未下单的潜在新客）
    const lcCounts = Object.fromEntries(lifecycleR.rows.map(r => [r.lifecycle_stage, r.cnt]));
    const everEngaged = (lcCounts.new || 0) + (lcCounts.active || 0) + (lcCounts.at_risk || 0) + (lcCounts.dormant || 0) + (lcCounts.churned || 0);
    const lostCount = (lcCounts.dormant || 0) + (lcCounts.churned || 0);
    const churnRate = everEngaged ? Math.round((lostCount / everEngaged) * 1000) / 10 : 0;

    const tierCounts = Object.fromEntries(valueTierR.rows.map(r => [r.value_tier, r.cnt]));
    // 复购率（30天内下单≥2次客户占比）
    const rep30 = repurchase30R.rows[0] || {};
    const repurchasers = Number(rep30.repurchasers || 0);
    const totalWithOrders30 = Number(rep30.total_with_orders || 0);
    const repurchaseRate = totalWithOrders30 ? Math.round((repurchasers / totalWithOrders30) * 1000) / 10 : 0;

    const profileInsights = {
      lifecycle: lcCounts,
      value_tier: tierCounts,
      churn_rate: churnRate,
      churn_detail: { lost: lostCount, ever_engaged: everEngaged, dormant: lcCounts.dormant || 0, churned: lcCounts.churned || 0 },
      // 统一核心客户指标看板
      customer_metrics: {
        total_customers: everEngaged,
        new_count: lcCounts.new || 0,
        active_count: lcCounts.active || 0,
        vip_count: tierCounts.vip || 0,
        churn_rate: churnRate,
        repurchase_rate: repurchaseRate,
        repurchase_detail: { repurchasers, total_with_orders_30d: totalWithOrders30 }
      },
      avg_spend_dist: Object.fromEntries(spendDistR.rows.map(r => [r.spend_tier, r.cnt])),
      top_visit_times: Object.fromEntries(visitR.rows.map(r => [r.visit_time, r.cnt])),
      top_dish_categories: Object.fromEntries(dishCatR.rows.map(r => [r.category, r.total_qty])),
      high_value_customers: highValueR.rows[0] || {},
      new_vs_returning: {
        new_pct: repeatR.rows[0] ? Math.round((repeatR.rows[0].one_timer / (repeatR.rows[0].total_customers || 1)) * 1000) / 10 : 0,
        returning_pct: repeatR.rows[0] ? Math.round(((repeatR.rows[0].two_timer + repeatR.rows[0].repeat_3plus) / (repeatR.rows[0].total_customers || 1)) * 1000) / 10 : 0
      },
      cust_order_type: Object.fromEntries(custOrderTypeR.rows.map(r => [r.order_type, r.cnt])),
      cust_order_source: Object.fromEntries(custOrderSourceR.rows.map(r => [r.order_source, r.cnt])),
      cust_dept: Object.fromEntries(custDeptR.rows.map(r => [r.department, r.total_qty]))
    };

    res.json({
      ok: true,
      summary: summaryR.rows[0] || {},
      byStore: storeR.rows,
      hourDist: hourR.rows,
      payDist: payR.rows,
      topDishes: dishR.rows,
      repeatStats: repeatR.rows[0] || {},
      profileInsights,
      byOrderType: byOrderTypeR.rows,
      byOrderSource: byOrderSourceR.rows,
      byDept: byDeptR.rows
    });
  });

  // ── Phase 9: Feishu bitable sync config for POS orders ──
  app.get('/api/growth/pos-feishu-config', async (req, res) => {
    if (!rqa(req, res)) return;
    const r = await pool.query(`SELECT data FROM hrms_state WHERE key = 'pos_feishu_config' LIMIT 1`);
    const config = r.rows?.[0]?.data || null;
    res.json({ok:true, config});
  });

  app.post('/api/growth/pos-feishu-config', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    const config = {
      orders_app_token: cleanText(b.orders_app_token || '', 200),
      orders_table_id: cleanText(b.orders_table_id || '', 200),
      items_app_token: cleanText(b.items_app_token || '', 200),
      items_table_id: cleanText(b.items_table_id || '', 200),
      store_id: cleanText(b.store_id || '', 128),
      app_id: cleanText(b.app_id || '', 80),
      app_secret: cleanText(b.app_secret || '', 200)
    };
    if (!config.orders_app_token || !config.orders_table_id)
      return res.status(400).json({ok:false,error:'missing orders_app_token or orders_table_id'});
    await pool.query(
      `INSERT INTO hrms_state (key, data, updated_at) VALUES ('pos_feishu_config', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET data = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(config)]
    );
    res.json({ok:true, config});
  });

  app.post('/api/growth/pos-feishu-sync', async (req, res) => {
    if (!rqa(req, res)) return;
    const b = req.body || {};
    const override = b.config || null;

    let config = override;
    if (!config) {
      const cr = await pool.query(`SELECT data FROM hrms_state WHERE key = 'pos_feishu_config' LIMIT 1`);
      config = cr.rows?.[0]?.data || null;
    }
    if (!config) return res.status(400).json({ok:false,error:'no pos_feishu_config found, POST /api/growth/pos-feishu-config first'});

    const LARK_APP_ID = config.app_id || process.env.BITABLE_TASK_RESP_APP_ID || process.env.LARK_APP_ID || process.env.FEISHU_APP_ID || '';
    const LARK_APP_SECRET = config.app_secret || process.env.BITABLE_TASK_RESP_APP_SECRET || process.env.LARK_APP_SECRET || process.env.FEISHU_APP_SECRET || '';
    if (!LARK_APP_ID || !LARK_APP_SECRET) return res.status(503).json({ok:false,error:'no Feishu app credentials configured'});

    let tenantToken = '';
    try {
      const tr = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET},
        {headers: {'Content-Type': 'application/json'}, timeout: 10000}
      );
      tenantToken = tr.data?.tenant_access_token || '';
    } catch (e) { return res.status(502).json({ok:false,error:'lark_token_failed',detail: e.message}); }
    if (!tenantToken) return res.status(502).json({ok:false,error:'lark_token_empty'});

    const storeId = config.store_id || '';
    let totalOrders = 0, totalItems = 0, totalLinked = 0;

    // ── Sync orders table ──
    if (config.orders_app_token && config.orders_table_id) {
        const ORDERS_FIELD_MAP = {
        '编号': 'seq_no', '订单号': 'order_no', '订单来源': 'order_source',
        '营业日': 'biz_date', '下单时间': 'order_time', '结账时间': 'checkout_time',
        '订单状态': 'order_status', '折前金额': 'amount_before_discount', '总优惠金额': 'total_discount',
        '折后金额': 'amount_after_discount', '支付方式': 'payment_method', '支付笔数': 'payment_count',
        '会员姓名': 'member_name', '会员手机号': 'phone', '订单类型': 'order_type',
        '桌台': 'table_no', '就餐人数': 'diners', '就餐时长': 'duration', '就餐时长(分钟）': 'duration',
        '门店名称': 'store_name'
      };
      let pageToken = '';
      let ordersBatch = [];
      do {
        const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.orders_app_token}/tables/${config.orders_table_id}/records?page_size=500${pageToken ? '&page_token=' + pageToken : ''}`;
        const resp = await axios.get(url, {headers: {'Authorization': 'Bearer ' + tenantToken}, timeout: 10000});
        const rd = resp.data;
        if (rd.code !== 0) return res.status(502).json({ok:false,error:'orders_bitable_error', detail: rd.msg});
        const items = rd.data?.items || [];
        for (const rec of items) {
          const f = rec.fields || {};
          const order = {store_id: storeId};
          for (const [cn, en] of Object.entries(ORDERS_FIELD_MAP)) {
            const val = f[cn];
            if (val != null) order[en] = typeof val === 'object' ? (val.text || val.link || val.name || JSON.stringify(val)) : val;
          }
          if (order.order_no) ordersBatch.push(order);
        }
         pageToken = (rd.data?.has_more && rd.data?.page_token) ? rd.data.page_token : '';
       } while (pageToken);

      if (ordersBatch.length) {
         for (const o of ordersBatch) {
          const phone = parseKeruyunPhone(o.phone || o.member_phone || '');
          const bizDate = cnDate(o.biz_date);
          try {
            await pool.query(`
              INSERT INTO pos_orders(seq_no,order_no,order_source,biz_date,order_time,checkout_time,order_status,amount_before_discount,total_discount,amount_after_discount,payment_method,payment_count,member_name,phone,order_type,table_no,diners,duration,store_name,store_id)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
              ON CONFLICT(order_no) DO UPDATE SET
                order_source=EXCLUDED.order_source,
                checkout_time=COALESCE(EXCLUDED.checkout_time,pos_orders.checkout_time),
                order_status=COALESCE(EXCLUDED.order_status,pos_orders.order_status),
                amount_before_discount=EXCLUDED.amount_before_discount,total_discount=EXCLUDED.total_discount,
                amount_after_discount=EXCLUDED.amount_after_discount,
                payment_method=COALESCE(EXCLUDED.payment_method,pos_orders.payment_method),
                payment_count=EXCLUDED.payment_count,
                phone=COALESCE(NULLIF(EXCLUDED.phone,''),pos_orders.phone),
                member_name=COALESCE(NULLIF(EXCLUDED.member_name,'-'),NULLIF(EXCLUDED.member_name,''),pos_orders.member_name),
                table_no=COALESCE(NULLIF(EXCLUDED.table_no,''),pos_orders.table_no),
                diners=COALESCE(EXCLUDED.diners,pos_orders.diners),
                duration=COALESCE(NULLIF(EXCLUDED.duration,''),pos_orders.duration),
                store_name=COALESCE(NULLIF(EXCLUDED.store_name,''),pos_orders.store_name),
                seq_no=COALESCE(NULLIF(EXCLUDED.seq_no,''),pos_orders.seq_no),
                synced_at=NOW()
            `, [
              cleanText(o.seq_no || '', 32), cleanText(o.order_no || '', 64),
              cleanText(o.order_source || '', 80), bizDate || null,
              parseKeruyunDateTime(o.order_time), parseKeruyunDateTime(o.checkout_time),
              cleanText(o.order_status || '', 40), parseNum(o.amount_before_discount), parseNum(o.total_discount),
              parseNum(o.amount_after_discount),
              cleanText(o.payment_method || '', 80), Number(o.payment_count) || 0,
              cleanText(o.member_name || '', 100), phone,
              cleanText(o.order_type || '', 40), cleanText(o.table_no || '', 40),
              Number(o.diners) || null, cleanText(o.duration || '', 40),
               cleanText(o.store_name || '', 200), (function() { var sn = cleanText(o.store_name || '', 200); var sid = storeId || cleanText(o.store_id || '', 128); if (sn && sn.includes('洪潮')) return '64822111'; if (sn && sn.includes('马己仙')) return '51866138'; return sid; })()
            ]);
            totalOrders++;
          } catch (e) { console.error('[pos-feishu-sync] order upsert error:', e.message, o.order_no); }
        }
      }
    }

    // ── Sync items table ──
    if (config.items_app_token && config.items_table_id) {
       const ITEMS_FIELD_MAP = {
        '营业日期': 'biz_date', '营业日': 'biz_date', '门店名称': 'store_name', '菜品名称': 'dish_name',
        '出品部门': 'department', '桌台名称': 'table_name', '桌台区域': 'table_area',
        '销售类型': 'sale_type', '菜品编码': 'sku', '大类名称': 'category',
        '中类名称': 'category_mid', '规格': 'spec', '单位': 'unit',
        '订单号': 'order_no', '订单类型': 'order_type', '订单来源': 'order_source',
        '销售数量': 'qty', '折前金额': 'amount_before_discount',
        '优惠金额': 'discount', '服务费分摊收入': 'service_fee',
        '折后金额': 'amount_after_discount', '下单时间': 'order_time',
        '结账时间': 'checkout_time'
      };
      let pageToken = '';
      let itemsBatch = [];
      let itemsPageCount = 0;
      do {
        const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.items_app_token}/tables/${config.items_table_id}/records?page_size=500${pageToken ? '&page_token=' + pageToken : ''}`;
        const resp = await axios.get(url, {headers: {'Authorization': 'Bearer ' + tenantToken}, timeout: 15000});
        const rd = resp.data;
        if (rd.code !== 0) return res.status(502).json({ok:false,error:'items_bitable_error', detail: rd.msg});
        const records = rd.data?.items || [];
        itemsPageCount++;
        console.log(`[pos-feishu-sync] items page ${itemsPageCount}: got ${records.length} records, has_more=${rd.data?.has_more}, total=${rd.data?.total}`);
        for (const rec of records) {
          const f = rec.fields || {};
          const item = {};
          for (const [cn, en] of Object.entries(ITEMS_FIELD_MAP)) {
            const val = f[cn];
            if (val != null) item[en] = typeof val === 'object' ? (val.text || val.link || val.name || JSON.stringify(val)) : val;
          }
          if (item.order_no) itemsBatch.push(item);
        }
        pageToken = (rd.data?.has_more && rd.data?.page_token) ? rd.data.page_token : '';
      } while (pageToken);

      if (itemsBatch.length) {
        for (const it of itemsBatch) {
            const itemBizDate = cnDate(it.biz_date);
           try {
             await pool.query(`
              INSERT INTO pos_order_items(biz_date,store_name,store_code,order_no,sku,dish_name,department,table_name,table_area,sale_type,category_mid,category,spec,unit,order_type,order_source,qty,amount_before_discount,discount,service_fee,amount_after_discount,order_time,checkout_time)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
              ON CONFLICT DO NOTHING
            `, [
              itemBizDate || null, cleanText(it.store_name || '', 200), (function() { var sn = cleanText(it.store_name || '', 200); if (sn && sn.includes('洪潮')) return '64822111'; if (sn && sn.includes('马己仙')) return '51866138'; return cleanText(it.store_code || '', 64); })(),
              cleanText(it.order_no || '', 128), cleanText(it.sku || '', 64), cleanText(it.dish_name || '', 300),
              cleanText(it.department || '', 100), cleanText(it.table_name || '', 100), cleanText(it.table_area || '', 100),
              cleanText(it.sale_type || '', 40),
              cleanText(it.category_mid || '', 100), cleanText(it.category || '', 100),
              cleanText(it.spec || '', 100), cleanText(it.unit || '', 20),
              cleanText(it.order_type || '', 40), cleanText(it.order_source || '', 200),
              parseNum(it.qty), parseNum(it.amount_before_discount),
              parseNum(it.discount), parseNum(it.service_fee), parseNum(it.amount_after_discount),
              parseKeruyunDateTime(it.order_time), parseKeruyunDateTime(it.checkout_time)
            ]);
            totalItems++;
          } catch (e) { console.error('[pos-feishu-sync] item upsert error:', e.message, it.order_no); }
        }
      }
    }

    totalLinked = await linkPosOrdersToCustomers(pool);
    const snapshotRows = await refreshSalesGrowthSnapshot(pool, 7).catch(e => { console.error('[pos-feishu-sync] snapshot refresh error:', e.message); return 0; });
    res.json({ok:true, orders_synced: totalOrders, items_synced: totalItems, customers_linked: totalLinked, snapshot_rows: snapshotRows});
  });

  // ── Snapshot refresh (manual trigger) ────────────────────────────
  app.post('/api/growth/snapshot/refresh', async (req, res) => {
    if (!authPhaseApi(req).ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const days = Math.min(Math.max(parseInt(req.body?.days || '7', 10) || 7, 1), 90);
    const rows = await refreshSalesGrowthSnapshot(pool, days);
    return res.json({ ok: true, rows_upserted: rows, days_covered: days });
  });

  // ── Phase 4: A/B tests ─────────────────────────────────────────────
  app.get('/api/growth/ab-tests', async (req, res) => {
    if (!authPhaseApi(req).ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const storeCode = cleanText(req.query.store_code || '', 128);
    const status = cleanText(req.query.status || '', 40);
    const r = await pool.query(
      `SELECT * FROM ab_test_tasks
        WHERE ($1 = '' OR store_code = $1)
          AND ($2 = '' OR status = $2)
        ORDER BY created_at DESC
        LIMIT 100`,
      [storeCode, status]
    );
    const tasks = [];
    for (const row of r.rows || []) {
      const outcome = await computeAbTestOutcome(pool, row).catch(() => null);
      const daily = await pool.query(`SELECT * FROM ab_test_results WHERE test_id = $1 ORDER BY result_date ASC, variant ASC`, [row.id]).catch(() => ({ rows: [] }));
      tasks.push({ ...row, metrics: outcome?.byVariant || {}, results: daily.rows || [] });
    }
    return res.json({ ok: true, tasks });
  });

  app.post('/api/growth/ab-tests', async (req, res) => {
    const auth = authPhaseApi(req);
    if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error || 'unauthorized' });
    const b = req.body || {};
    const testName = cleanText(b.test_name, 255);
    const storeCode = cleanText(b.store_code, 128);
    const testType = cleanText(b.test_type || 'sms_copy', 80);
    const targetMetric = cleanText(b.target_metric || 'redemption_rate', 80);
    const startDate = safeDateOnly(b.start_date) || todayShanghaiYmd();
    const endDate = safeDateOnly(b.end_date) || ymdAddDays(startDate, 7);
    if (!testName || !storeCode) return res.status(400).json({ ok: false, error: 'missing_test_name_or_store_code' });
    const created = await pool.query(
      `INSERT INTO ab_test_tasks (
         test_name, store_code, test_type, target_metric,
         variant_a, variant_b, rotation_config, start_date, end_date,
         min_sample_size, created_by, status
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,'running')
       RETURNING *`,
      [
        testName,
        storeCode,
        testType,
        targetMetric,
        JSON.stringify(b.variant_a || {}),
        JSON.stringify(b.variant_b || {}),
        JSON.stringify(b.rotation_config || { method: 'time', a_days: [1, 2, 3], b_days: [4, 5, 6, 0] }),
        startDate,
        endDate,
        Math.max(1, Math.floor(Number(b.min_sample_size) || 30)),
        cleanText(auth.user?.username || 'system', 80)
      ]
    );
    const task = created.rows[0];
    const autoSeed = b.auto_seed !== false;
    if (autoSeed) {
      const audience = await listAbAudienceForSendDate(pool, storeCode, startDate, 7);
      await queueAbSmsAssignments(pool, task, audience, { sendDate: startDate });
      await refreshAbTestResults(pool, task);
      if (safeDateOnly(endDate) <= todayShanghaiYmd()) await evaluateAbTask(pool, task);
    }
    return res.json({ ok: true, task: (await pool.query(`SELECT * FROM ab_test_tasks WHERE id = $1`, [task.id])).rows[0] });
  });

  app.post('/api/growth/ab-tests/bootstrap-first', async (req, res) => {
    const auth = authPhaseApi(req);
    if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error || 'unauthorized' });
    const existing = await pool.query(`SELECT * FROM ab_test_tasks WHERE test_name = $1 ORDER BY id DESC LIMIT 1`, ['7日未到店短信召回A/B']);
    if (existing.rows?.length) {
      const task = existing.rows[0];
      await refreshAbTestResults(pool, task);
      if (safeDateOnly(task.end_date) <= todayShanghaiYmd()) await evaluateAbTask(pool, task);
      return res.json({ ok: true, task: existing.rows[0], reused: true });
    }
    const startDate = ymdAddDays(todayShanghaiYmd(), -7);
    const endDate = todayShanghaiYmd();
    const created = await pool.query(
      `INSERT INTO ab_test_tasks (
         test_name, store_code, test_type, target_metric,
         variant_a, variant_b, rotation_config, start_date, end_date,
         min_sample_size, created_by, status
       ) VALUES ($1,$2,'sms_copy','redemption_rate',$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,30,$8,'running')
       RETURNING *`,
      [
        '7日未到店短信召回A/B',
        '51866138',
        JSON.stringify({ label: '文案A', content: '锅气十足，今晚来尝尝？烧鹅刚出炉，专属8折券已发' }),
        JSON.stringify({ label: '文案B', content: '{姓名}，已有7天没来了，准备了一张减8元券，3天内有效' }),
        JSON.stringify({ method: 'hash', a_days: [1, 2, 3], b_days: [4, 5, 6, 0] }),
        startDate,
        endDate,
        cleanText(auth.user?.username || 'system', 80)
      ]
    );
    const task = created.rows[0];
    const audience = await listAbAudienceForSendDate(pool, '51866138', startDate, 7);
    const queued = await queueAbSmsAssignments(pool, task, audience, { sendDate: startDate });
    await refreshAbTestResults(pool, task);
    const evaluated = await evaluateAbTask(pool, task);
    return res.json({ ok: true, task: evaluated?.task || task, queued, evaluated });
  });

  app.post('/api/growth/ab-tests/:id/refresh', async (req, res) => {
    const auth = authPhaseApi(req);
    if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error || 'unauthorized' });
    const id = Number(req.params.id || 0);
    if (!id) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const taskRes = await pool.query(`SELECT * FROM ab_test_tasks WHERE id = $1 LIMIT 1`, [id]);
    if (!taskRes.rows?.length) return res.status(404).json({ ok: false, error: 'task_not_found' });
    const task = taskRes.rows[0];
    const refreshed = await refreshAbTestResults(pool, task);
    const evaluated = safeDateOnly(task.end_date) <= todayShanghaiYmd() ? await evaluateAbTask(pool, task) : null;
    const latest = await pool.query(`SELECT * FROM ab_test_tasks WHERE id = $1`, [id]);
    return res.json({ ok: true, task: latest.rows[0], refreshed, evaluated });
  });

  app.get('/api/growth/learnings', async (req, res) => {
    if (!authPhaseApi(req).ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const storeCode = cleanText(req.query.store_code || '', 128);
    const channel = cleanText(req.query.channel || '', 80);
    const r = await pool.query(
      `SELECT * FROM growth_learnings
        WHERE ($1 = '' OR store_code = $1)
          AND ($2 = '' OR channel = $2)
        ORDER BY created_at DESC
        LIMIT 200`,
      [storeCode, channel]
    );
    return res.json({ ok: true, learnings: r.rows });
  });

  // ── Phase 6: Manual learning insert + seed ───────────────────────
  app.post('/api/growth/learnings', async (req, res) => {
    const auth = authPhaseApi(req);
    if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
    const b = req.body || {};
    const channel = cleanText(b.channel, 80);
    const variable = cleanText(b.variable, 120);
    const winningValue = cleanText(b.winning_value, 500);
    if (!channel || !variable || !winningValue) {
      return res.status(400).json({ ok: false, error: 'missing channel, variable, or winning_value' });
    }
    const r = await pool.query(
      `INSERT INTO growth_learnings (
         source_type, source_id, store_code, channel, scene, audience_tag, variable,
         winning_value, losing_value, effect_desc, sample_size, confidence, valid_until
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        cleanText(b.source_type || 'manual', 80),
        cleanText(b.source_id || `manual_${Date.now()}`, 200),
        cleanText(b.store_code, 128),
        channel,
        b.scene ? cleanText(b.scene, 80) : null,
        b.audience_tag ? cleanText(b.audience_tag, 120) : null,
        variable,
        winningValue,
        b.losing_value ? cleanText(b.losing_value, 500) : null,
        b.effect_desc ? cleanText(b.effect_desc, 255) : null,
        Math.max(0, Math.floor(Number(b.sample_size) || 0)),
        cleanText(b.confidence || 'medium', 20),
        b.valid_until ? safeDateOnly(b.valid_until) : ymdAddDays(todayShanghaiYmd(), 90)
      ]
    );
    return res.json({ ok: true, learning: r.rows[0] || null });
  });

  app.post('/api/growth/learnings/seed', async (req, res) => {
    const auth = authPhaseApi(req);
    if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
    const today = todayShanghaiYmd();
    const validUntil = ymdAddDays(today, 180);
    const seeds = [
      // SMS · 晚市 · 7日未到店
      ['manual','seed_sms_01','51866138','sms','晚市','7日未到店','文案风格','个性化称呼（含姓名）','无称呼通用文案','核销率+22%',120,'high'],
      ['manual','seed_sms_02','51866138','sms','晚市','7日未到店','折扣类型','减8元券','8折券','核销率+11%',98,'medium'],
      ['manual','seed_sms_03','51866138','sms','晚市','7日未到店','发送时段','17:00-18:00','11:00-12:00','核销率+18%',84,'medium'],
      ['manual','seed_sms_04','64822111','sms','晚市','7日未到店','文案风格','个性化称呼（含姓名）','无称呼通用文案','核销率+19%',67,'medium'],
      ['manual','seed_sms_05','51866138','sms','午市','新客','折扣类型','单人套餐+赠品','直接打折','核销率+14%',55,'medium'],
      // SMS · 节假日
      ['manual','seed_sms_06','51866138','sms','节假日','全部客户','文案类型','节日祝福+优惠券','纯优惠券','核销率+9%',200,'high'],
      ['manual','seed_sms_07','64822111','sms','节假日','7日未到店','有效期','3天有效期','7天有效期','核销率+16%',76,'medium'],
      // 小红书
      ['manual','seed_xhs_01','51866138','xiaohongshu',null,null,'内容策略','烟火气风格+真实场景图','精修美食图','点击率+31%',1800,'high'],
      ['manual','seed_xhs_02','51866138','xiaohongshu','午市',null,'文案风格','打工人共鸣标题','直白菜品介绍','曝光量+45%',2200,'high'],
      ['manual','seed_xhs_03','64822111','xiaohongshu',null,null,'封面图风格','顾客就餐实拍','摆盘特写','收藏率+22%',1200,'medium'],
      ['manual','seed_xhs_04','51866138','xiaohongshu','晚市',null,'发布时段','18:00-20:00','12:00-14:00','互动率+27%',950,'high'],
      // 企业微信
      ['manual','seed_wxwork_01','51866138','wechat_work','晚市','7日未到店','消息频率','每月1次','每周1次','取消关注率-38%',180,'high'],
      ['manual','seed_wxwork_02','51866138','wechat_work',null,'高价值客户','内容类型','专属会员权益','通用促销信息','核销率+33%',90,'high'],
      ['manual','seed_wxwork_03','64822111','wechat_work','午市','新客','首次触达时机','到店后3天内','到店后7天内','复购率+25%',63,'medium'],
      // 大众点评
      ['manual','seed_dianping_01','51866138','dianping',null,null,'评价回复','个性化回复+感谢','模板统一回复','好评率+8%',320,'high'],
      ['manual','seed_dianping_02','51866138','dianping',null,null,'封面图','顾客实拍授权图','商家官拍图','点击率+19%',4500,'high'],
      ['manual','seed_dianping_03','64822111','dianping',null,null,'团购设置','单人套餐（性价比优先）','多人套餐','核销率+41%',220,'high'],
      // 券设计
      ['manual','seed_coupon_01','51866138','sms',null,'老客户','券面值','减10元（门槛40）','减8元（无门槛）','核销率+17%',145,'high'],
      ['manual','seed_coupon_02','51866138','sms',null,'新客','有效期','7天','30天','核销率+29%',88,'medium'],
      ['manual','seed_coupon_03','64822111','miniprogram',null,'7日未到店','券样式','菜品绑定券（烧鹅专用）','通用代金券','核销率+23%',72,'medium'],
      // 内容主题
      ['manual','seed_content_01','51866138','sms','晚市','全部客户','主推菜品','本周热卖（数据支撑）','固定招牌菜','到店率+12%',310,'high'],
      ['manual','seed_content_02','51866138','xiaohongshu',null,null,'话题选择','本地探店+区域话题','品牌自建话题','曝光+67%',3100,'high'],
      ['manual','seed_content_03','64822111','xiaohongshu','午市',null,'图片数量','9张（含菜品+环境+顾客）','3张精选图','互动率+18%',780,'medium'],
      // 活动设计
      ['manual','seed_activity_01','51866138','sms',null,'高频客户（月均3次+）','活动类型','升级权益（生日月双倍积分）','一次性折扣','留存率+28%',95,'high'],
      ['manual','seed_activity_02','51866138','wechat_work',null,'沉睡客户（90天未到店）','召回方式','定向发放高价值券（满50减20）','通用消息推送','召回率+19%',48,'medium'],
      ['manual','seed_activity_03','64822111','sms',null,'节前7天','触达节点','节前3天发券','节当天发券','核销率+34%',156,'high'],
      // 门店差异化
      ['manual','seed_store_01','51866138','sms','晚市','7日未到店','短信内容场景化','提及具体菜品（烧鹅/荔枝木）','不提菜品','核销率+15%',134,'high'],
      ['manual','seed_store_02','64822111','xiaohongshu',null,null,'达人合作','本地素人探店（1k-5k粉丝）','KOL付费推广','ROI+2.3倍',8,'medium'],
      // 时间策略
      ['manual','seed_time_01','51866138','sms','午市','上班族','发送时间','工作日11:00','工作日08:00','开率+22%',267,'high'],
      ['manual','seed_time_02','51866138','sms','晚市','家庭客','发送时间','周五17:00','周一17:00','核销率+19%',189,'high'],
      ['manual','seed_time_03','51866138','xiaohongshu',null,null,'发帖时间','周四晚20:00（周末预热）','周一早09:00','互动量+38%',1650,'high'],
    ];
    let inserted = 0;
    for (const [srcType, srcId, storeCode, channel, scene, audienceTag, variable,
                 winVal, loseVal, effectDesc, sampleSize, confidence] of seeds) {
      await pool.query(
        `INSERT INTO growth_learnings (
           source_type, source_id, store_code, channel, scene, audience_tag, variable,
           winning_value, losing_value, effect_desc, sample_size, confidence, valid_until
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT DO NOTHING`,
        [srcType, srcId, storeCode, channel, scene, audienceTag, variable,
         winVal, loseVal, effectDesc, sampleSize, confidence, validUntil]
      ).catch(() => {});
      inserted++;
    }
    const count = await pool.query(`SELECT COUNT(*)::int AS cnt FROM growth_learnings`);
    return res.json({ ok: true, seeded: inserted, total: count.rows[0]?.cnt || 0 });
  });

  // ── Phase 5: content system ───────────────────────────────────────
  app.get('/api/growth/content-suggestions', async (req, res) => {
    if (!authPhaseApi(req).ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const storeCode = cleanText(req.query.store_code || '', 128);
    const weekStart = safeDateOnly(req.query.week_start || '');
    const r = await pool.query(
      `SELECT * FROM growth_content_suggestions
        WHERE ($1 = '' OR store_code = $1)
          AND ($2 = '' OR week_start = $2::date)
        ORDER BY week_start DESC, created_at DESC
        LIMIT 50`,
      [storeCode, weekStart]
    );
    return res.json({ ok: true, suggestions: r.rows });
  });

  app.post('/api/growth/content-suggestions/generate', async (req, res) => {
    const auth = authPhaseApi(req);
    if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error || 'unauthorized' });
    const storeCode = cleanText(req.body?.store_code || req.query?.store_code || '51866138', 128);
    const weekStart = safeDateOnly(req.body?.week_start || req.query?.week_start || todayShanghaiYmd());
    const suggestion = await generateWeeklyContentSuggestion(pool, storeCode, weekStart, auth.user?.username || 'system');
    const pushed = await pushWeeklySuggestionToFeishu(pool, suggestion).catch(() => ({ pushed: 0 }));
    return res.json({ ok: true, suggestion, pushed });
  });

  app.get('/api/growth/content-performance', async (req, res) => {
    if (!authPhaseApi(req).ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const storeCode = cleanText(req.query.store_code || '', 128);
    const channel = cleanText(req.query.channel || '', 80);
    const r = await pool.query(
      `SELECT * FROM content_performance
        WHERE ($1 = '' OR store_code = $1)
          AND ($2 = '' OR channel = $2)
        ORDER BY created_at DESC
        LIMIT 200`,
      [storeCode, channel]
    );
    return res.json({ ok: true, items: r.rows });
  });

  app.post('/api/growth/content-performance', async (req, res) => {
    const auth = authPhaseApi(req);
    if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error || 'unauthorized' });
    const b = req.body || {};
    const contentKey = cleanText(b.content_key || `cp_${Date.now()}`, 255);
    const row = await pool.query(
      `INSERT INTO content_performance (
         content_key, suggestion_id, store_code, channel, scene, audience_tag, variable,
         content_title, content_body, winning_value, losing_value,
         impressions, clicks, orders, redemptions, revenue,
         notes, recorded_by, published_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (content_key) DO UPDATE SET
         impressions = EXCLUDED.impressions,
         clicks = EXCLUDED.clicks,
         orders = EXCLUDED.orders,
         redemptions = EXCLUDED.redemptions,
         revenue = EXCLUDED.revenue,
         notes = EXCLUDED.notes,
         recorded_by = EXCLUDED.recorded_by,
         published_at = EXCLUDED.published_at,
         updated_at = NOW()
       RETURNING *`,
      [
        contentKey,
        b.suggestion_id ? Number(b.suggestion_id) : null,
        cleanText(b.store_code, 128),
        cleanText(b.channel, 80),
        cleanText(b.scene, 80),
        cleanText(b.audience_tag, 120),
        cleanText(b.variable, 120),
        cleanText(b.content_title, 500),
        cleanText(b.content_body, 4000),
        cleanText(b.winning_value, 500),
        cleanText(b.losing_value, 500),
        Math.max(0, Math.floor(Number(b.impressions) || 0)),
        Math.max(0, Math.floor(Number(b.clicks) || 0)),
        Math.max(0, Math.floor(Number(b.orders) || 0)),
        Math.max(0, Math.floor(Number(b.redemptions) || 0)),
        Number(Number(b.revenue || 0).toFixed(2)),
        cleanText(b.notes, 2000),
        cleanText(auth.user?.username || 'system', 80),
        b.published_at ? parseOccurredAt(b.published_at) : new Date()
      ]
    );
    const perf = row.rows[0];
    const impressions = Number(perf.impressions || 0);
    const redemptions = Number(perf.redemptions || 0);
    const effectPct = impressions > 0 ? Number(((redemptions / impressions) * 100).toFixed(2)) : 0;
    if (cleanText(perf.winning_value, 500)) {
      await pool.query(
        `INSERT INTO growth_learnings (
           source_type, source_id, store_code, channel, scene, audience_tag, variable,
           winning_value, losing_value, effect_desc, sample_size, confidence, valid_until
         ) VALUES ('campaign',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          String(perf.id),
          cleanText(perf.store_code, 128),
          cleanText(perf.channel, 80),
          cleanText(perf.scene, 80),
          cleanText(perf.audience_tag, 120),
          cleanText(perf.variable || '内容策略', 120),
          cleanText(perf.winning_value, 500),
          cleanText(perf.losing_value, 500),
          cleanText(`核销率${effectPct}%`, 255),
          impressions,
          impressions >= 100 ? 'high' : 'medium',
          ymdAddDays(todayShanghaiYmd(), 90)
        ]
      ).catch(() => {});
    }
    return res.json({ ok: true, item: perf });
  });

  app.get('/api/growth/content-performance-v2', async (req, res) => {
    if (!authPhaseApi(req).ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const storeCode = cleanText(req.query.store_code || '', 128);
    const channel = cleanText(req.query.channel || '', 80);
    const r = await pool.query(
      `SELECT * FROM content_performance
        WHERE ($1 = '' OR store_code = $1)
          AND ($2 = '' OR channel = $2)
        ORDER BY created_at DESC
        LIMIT 200`,
      [storeCode, channel]
    );
    return res.json({ ok: true, items: r.rows });
  });

  app.post('/api/growth/content-performance-v2', async (req, res) => {
    const auth = authPhaseApi(req);
    if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error || 'unauthorized' });
    const b = req.body || {};
    const contentKey = cleanText(b.content_key || `cp_${Date.now()}`, 255);
    const row = await pool.query(
      `INSERT INTO content_performance (
         content_key, suggestion_id, content_date, store_code, store_id, channel, platform,
         content_type, variant_tag, dish_name, content_title, content_body,
         scene, audience_tag, variable, winning_value, losing_value,
         impressions, clicks, orders, redemptions, revenue,
         notes, created_by, recorded_by, published_at
       ) VALUES ($1,$2,$3,$4,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING *`,
      [
        contentKey,
        b.suggestion_id ? Number(b.suggestion_id) : null,
        safeDateOnly(b.content_date || b.published_at || todayShanghaiYmd()) || todayShanghaiYmd(),
        cleanText(b.store_code, 128),
        cleanText(b.channel, 80),
        cleanText(b.content_type || 'weekly_suggestion', 80),
        cleanText(b.variant_tag || 'A', 16),
        cleanText(b.dish_name || b.content_title, 255),
        cleanText(b.content_title, 500),
        cleanText(b.content_body, 4000),
        cleanText(b.scene, 80),
        cleanText(b.audience_tag, 120),
        cleanText(b.variable, 120),
        cleanText(b.winning_value, 500),
        cleanText(b.losing_value, 500),
        Math.max(0, Math.floor(Number(b.impressions) || 0)),
        Math.max(0, Math.floor(Number(b.clicks) || 0)),
        Math.max(0, Math.floor(Number(b.orders) || 0)),
        Math.max(0, Math.floor(Number(b.redemptions) || 0)),
        Number(Number(b.revenue || 0).toFixed(2)),
        cleanText(b.notes, 2000),
        cleanText(auth.user?.username || 'system', 80),
        cleanText(auth.user?.username || 'system', 80),
        b.published_at ? parseOccurredAt(b.published_at) : new Date()
      ]
    );
    const perf = row.rows[0];
    const impressions = Number(perf.impressions || 0);
    const redemptions = Number(perf.redemptions || 0);
    const effectPct = impressions > 0 ? Number(((redemptions / impressions) * 100).toFixed(2)) : 0;
    if (cleanText(perf.winning_value, 500)) {
      await pool.query(
        `INSERT INTO growth_learnings (
           source_type, source_id, store_code, channel, scene, audience_tag, variable,
           winning_value, losing_value, effect_desc, sample_size, confidence, valid_until
         ) VALUES ('campaign',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          String(perf.id),
          cleanText(perf.store_code, 128),
          cleanText(perf.channel, 80),
          cleanText(perf.scene, 80),
          cleanText(perf.audience_tag, 120),
          cleanText(perf.variable || '内容策略', 120),
          cleanText(perf.winning_value, 500),
          cleanText(perf.losing_value, 500),
          cleanText(`核销率${effectPct}%`, 255),
          impressions,
          impressions >= 100 ? 'high' : 'medium',
          ymdAddDays(todayShanghaiYmd(), 90)
        ]
      ).catch(() => {});
    }
    return res.json({ ok: true, item: perf });
  });

  // ── Phase 7a: Churn predictions ──────────────────────────────────
  app.get('/api/growth/churn-predictions', async (req, res) => {
    if (!authPhaseApi(req).ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const storeCode = cleanText(req.query.store_code || '', 128);
    const riskLevel = cleanText(req.query.risk_level || '', 20);
    const predDate = safeDateOnly(req.query.prediction_date || '');
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const r = await pool.query(
      `SELECT * FROM growth_churn_predictions
        WHERE ($1 = '' OR store_code = $1)
          AND ($2 = '' OR risk_level = $2)
          AND ($3 = '' OR prediction_date = $3::date)
        ORDER BY prediction_date DESC, churn_score ASC
        LIMIT $4`,
      [storeCode, riskLevel, predDate, limit]
    );
    const summary = { total: r.rows.length, high: 0, medium: 0, low: 0 };
    r.rows.forEach(x => { if (summary[x.risk_level] !== undefined) summary[x.risk_level]++; });
    return res.json({ ok: true, predictions: r.rows, summary });
  });

  app.post('/api/growth/churn-predictions/compute', async (req, res) => {
    const auth = authPhaseApi(req);
    if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
    const storeCode = cleanText(req.body?.store_code || req.query?.store_code || '', 128);
    const result = await computeChurnScores(pool, storeCode);
    return res.json({ ok: true, ...result });
  });

  // ── Phase 7b: Menu health reports ────────────────────────────────
  app.get('/api/growth/menu-health-reports', async (req, res) => {
    if (!authPhaseApi(req).ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const storeCode = cleanText(req.query.store_code || '', 128);
    const reportMonth = safeMonthOnly(req.query.report_month || '');
    const r = await pool.query(
      `SELECT id, report_month, store_code, generated_by, created_at,
              report_json->'summary' AS summary,
              report_json->'recommendations' AS recommendations
         FROM growth_menu_health_reports
        WHERE ($1 = '' OR store_code = $1)
          AND ($2 = '' OR report_month = $2)
        ORDER BY report_month DESC, created_at DESC
        LIMIT 50`,
      [storeCode, reportMonth]
    );
    return res.json({ ok: true, reports: r.rows });
  });

  app.get('/api/growth/menu-health-reports/:month', async (req, res) => {
    if (!authPhaseApi(req).ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const month = safeMonthOnly(req.params.month || '');
    const storeCode = cleanText(req.query.store_code || '', 128);
    if (!month) return res.status(400).json({ ok: false, error: 'invalid_month' });
    const r = await pool.query(
      `SELECT * FROM growth_menu_health_reports
        WHERE report_month = $1 AND ($2 = '' OR store_code = $2)
        LIMIT 10`,
      [month, storeCode]
    );
    return res.json({ ok: true, reports: r.rows });
  });

  app.post('/api/growth/menu-health-reports/generate', async (req, res) => {
    const auth = authPhaseApi(req);
    if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
    const storeCode = cleanText(req.body?.store_code || req.query?.store_code || '', 128);
    const reportMonth = safeMonthOnly(req.body?.report_month || req.query?.report_month || todayShanghaiYmd().slice(0, 7));
    const report = await generateMenuHealthReport(pool, storeCode, reportMonth);
    return res.json({ ok: true, report });
  });

  // ── Phase 7c: Pricing tests (A/B test system extension) ──────────
  app.get('/api/growth/price-tests', async (req, res) => {
    if (!authPhaseApi(req).ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const storeCode = cleanText(req.query.store_code || '', 128);
    const status = cleanText(req.query.status || '', 40);
    const r = await pool.query(
      `SELECT * FROM ab_test_tasks
        WHERE test_type IN ('price_test', 'price_bundle')
          AND ($1 = '' OR store_code = $1)
          AND ($2 = '' OR status = $2)
        ORDER BY created_at DESC
        LIMIT 100`,
      [storeCode, status]
    );
    const tasks = [];
    for (const row of r.rows || []) {
      const outcome = await computeAbTestOutcome(pool, row).catch(() => null);
      tasks.push({ ...row, metrics: outcome?.byVariant || {} });
    }
    return res.json({ ok: true, tasks });
  });

  app.post('/api/growth/price-tests', async (req, res) => {
    const auth = authPhaseApi(req);
    if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
    const b = req.body || {};
    const testName = cleanText(b.test_name, 255);
    const storeCode = cleanText(b.store_code, 128);
    if (!testName || !storeCode) return res.status(400).json({ ok: false, error: 'missing test_name or store_code' });
    const startDate = safeDateOnly(b.start_date) || todayShanghaiYmd();
    const endDate = safeDateOnly(b.end_date) || ymdAddDays(startDate, 14);
    // price_test variant_a/b must include: { label, dish_name, price_fen, description }
    // price_bundle: { label, bundle_name, items, price_fen }
    const testType = b.test_type === 'price_bundle' ? 'price_bundle' : 'price_test';
    const targetMetric = cleanText(b.target_metric || 'revenue_per_order', 80);
    const r = await pool.query(
      `INSERT INTO ab_test_tasks (
         test_name, store_code, test_type, target_metric,
         variant_a, variant_b, rotation_config, start_date, end_date,
         min_sample_size, created_by, status
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,'running')
       RETURNING *`,
      [
        testName, storeCode, testType, targetMetric,
        JSON.stringify(b.variant_a || {}),
        JSON.stringify(b.variant_b || {}),
        JSON.stringify(b.rotation_config || { method: 'store', note: '不同门店或不同日期轮换' }),
        startDate, endDate,
        Math.max(1, Math.floor(Number(b.min_sample_size) || 50)),
        cleanText(auth.user?.username || 'system', 80)
      ]
    );
    return res.json({ ok: true, task: r.rows[0] });
  });

  let __growthAbCronLast = '';
  let __growthContentCronLast = '';
  let __growthChurnCronLast = '';
  let __growthMenuCronLast = '';
  let __growthSnapshotCronLast = '';
  if (!globalThis.__growthPhase45Timers) {
    globalThis.__growthPhase45Timers = true;
    setInterval(async () => {
      const nowYmd = todayShanghaiYmd();
      try {
        const running = await pool.query(`SELECT * FROM ab_test_tasks WHERE status = 'running' ORDER BY id DESC LIMIT 20`);
        for (const task of running.rows || []) {
          await refreshAbTestResults(pool, task).catch(() => null);
          if (safeDateOnly(task.end_date) <= nowYmd) await evaluateAbTask(pool, task).catch(() => null);
        }
      } catch (e) {
        console.warn('[growth-phase4] ab cron failed:', e?.message);
      }
      try {
        const now = new Date(Date.now() + 8 * 3600000);
        const weekday = now.getUTCDay();
        const hour = now.getUTCHours();
        if (weekday === 1 && hour >= 1 && __growthContentCronLast !== nowYmd) {
          __growthContentCronLast = nowYmd;
          const stores = await pool.query(`SELECT DISTINCT store_code FROM pos_order_items WHERE biz_date >= CURRENT_DATE - INTERVAL '30 days' AND store_code IS NOT NULL AND store_code <> '' LIMIT 20`);
          for (const row of stores.rows || []) {
            const suggestion = await generateWeeklyContentSuggestion(pool, cleanText(row.store_code, 128), nowYmd, 'weekly_cron').catch(() => null);
            if (suggestion) await pushWeeklySuggestionToFeishu(pool, suggestion).catch(() => null);
          }
        }
      } catch (e) {
        console.warn('[growth-phase5] weekly content cron failed:', e?.message);
      }
      // Phase 7a: weekly churn scoring (Monday 02:00 CST = UTC weekday 1, hour 18)
      try {
        const now = new Date(Date.now() + 8 * 3600000);
        const weekday = now.getUTCDay();
        const hour = now.getUTCHours();
        if (weekday === 1 && hour >= 18 && __growthChurnCronLast !== nowYmd) {
          __growthChurnCronLast = nowYmd;
          const storeRows = await pool.query(
            `SELECT DISTINCT store_code FROM growth_churn_predictions
              WHERE prediction_date >= CURRENT_DATE - INTERVAL '30 days'
             UNION
             SELECT DISTINCT COALESCE(gcp.store_id, gc.last_store_id, '') AS store_code
               FROM growth_customer_profiles gcp
               FULL JOIN growth_customers gc ON gc.id = gcp.customer_id
              WHERE COALESCE(gcp.store_id, gc.last_store_id, '') <> ''
              LIMIT 20`
          );
          for (const row of storeRows.rows || []) {
            await computeChurnScores(pool, cleanText(row.store_code, 128)).catch(() => null);
          }
          console.log(`[growth-phase7a] weekly churn scores computed for ${storeRows.rows.length} stores`);
        }
      } catch (e) {
        console.warn('[growth-phase7a] churn cron failed:', e?.message);
      }
      // Phase 7b: monthly menu health report (1st of month at 03:00 CST = UTC day 1 of month, hour 19)
      try {
        const now = new Date(Date.now() + 8 * 3600000);
        const dayOfMonth = now.getUTCDate();
        const hour = now.getUTCHours();
        const curMonth = nowYmd.slice(0, 7);
        if (dayOfMonth === 1 && hour >= 19 && __growthMenuCronLast !== curMonth) {
          __growthMenuCronLast = curMonth;
          const storeRows = await pool.query(
            `SELECT DISTINCT store_code FROM pos_order_items
              WHERE biz_date >= CURRENT_DATE - INTERVAL '60 days'
                AND store_code IS NOT NULL AND store_code <> ''
              LIMIT 20`
          );
          for (const row of storeRows.rows || []) {
            await generateMenuHealthReport(pool, cleanText(row.store_code, 128), curMonth).catch(() => null);
          }
          console.log(`[growth-phase7b] monthly menu health reports generated for ${storeRows.rows.length} stores`);
        }
      } catch (e) {
        console.warn('[growth-phase7b] menu health cron failed:', e?.message);
      }
      // Daily snapshot safety-net: 02:15 CST = UTC 18:15 (runs even if pos-feishu-sync missed)
      try {
        const now = new Date(Date.now() + 8 * 3600000);
        const hour = now.getUTCHours();
        if (hour >= 18 && __growthSnapshotCronLast !== nowYmd) {
          __growthSnapshotCronLast = nowYmd;
          const rows = await refreshSalesGrowthSnapshot(pool, 3).catch(e => { console.error('[growth-snapshot] cron error:', e.message); return 0; });
          console.log(`[growth-snapshot] daily refresh: ${rows} rows upserted`);
        }
      } catch (e) {
        console.warn('[growth-snapshot] cron failed:', e?.message);
      }
    }, 10 * 60 * 1000);
  }

  // ── POS Feishu sync cron: daily at 01:10 Asia/Shanghai ──
  const POS_SYNC_CRON_KEY = 'pos_feishu_sync';
  let lastPosSyncDate = '';
  function shouldRunPosSync() {
    const now = new Date(Date.now() + 8 * 3600000);
    const today = now.toISOString().slice(0, 10);
    const hour = now.getUTCHours();
    return hour === 17 && today !== lastPosSyncDate; // UTC 17:00 = CST 01:00
  }
  setInterval(async () => {
    if (!shouldRunPosSync()) return;
    const now = new Date(Date.now() + 8 * 3600000);
    lastPosSyncDate = now.toISOString().slice(0, 10);
    console.log(`[pos-sync-cron] Starting daily POS Feishu sync at ${now.toISOString()}`);
    try {
      const resp = await axios.post(`http://127.0.0.1:${process.env.PORT || 3000}/api/growth/pos-feishu-sync`, {}, {
        headers: {'Authorization': 'Bearer ' + (process.env.MINIPROGRAM_SYNC_SECRET || ''), 'Content-Type': 'application/json'},
        timeout: 300000
      });
      const data = resp.data;
      if (data && data.ok) {
        console.log(`[pos-sync-cron] Success: ${data.orders_synced} orders, ${data.items_synced} items, ${data.customers_linked} linked`);
      } else {
        throw new Error(data?.error || 'unknown_error');
      }
    } catch (e) {
      console.error('[pos-sync-cron] Failed:', e.message);
      try {
        await pool.query(`INSERT INTO growth_sync_failures (source, event_type, payload, error_message) VALUES ($1,$2,$3,$4)`,
          [POS_SYNC_CRON_KEY, 'daily_sync_failed', '{}', e.message || String(e)]);
        await pool.query(`INSERT INTO growth_alerts (alert_key, alert_type, severity, title, message, suggested_action, status)
          VALUES ($1,$2,$3,$4,$5,$6,'open')
          ON CONFLICT (alert_key) DO UPDATE SET severity=EXCLUDED.severity, message=EXCLUDED.message, suggested_action=EXCLUDED.suggested_action, status='open', updated_at=NOW()`,
          ['pos_sync_failed', 'pos_sync_failed', 'high', 'POS数据同步失败', '每日凌晨POS飞书同步失败：' + (e.message || String(e)).slice(0, 200), '检查飞书应用权限、表字段、网络连接；手动调 POST /api/growth/pos-feishu-sync 重试']);
      } catch (_) {}
    }
  }, 60 * 1000);
  console.log('[pos-sync-cron] Scheduled: daily at ~01:10 CST, failure alerts to growth_sync_failures');
}
