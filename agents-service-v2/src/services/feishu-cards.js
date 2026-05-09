import { anomalyRuleLabelZh } from '../utils/anomaly-labels.js';
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

// ── Card Template Builders ──

/** 飞书 BI 扣分类卡片：岗位中文（与周度 periodic-scoring 一致） */
export function roleLabelZhForBiCard(role) {
  if (role === 'store_manager') return '店长';
  if (role === 'store_production_manager') return '出品经理';
  if (role === 'hq_manager') return '总部营运';
  if (role === 'admin') return '管理员';
  return String(role || '—');
}

/**
 * 周度 BI 异常扣分卡片；可选 taskId 时追加任务引用说明、「已查看」按钮与催办脚注（充值等即时触发与周度版式一致）。
 */
export function buildBiDeductionCard({
  store,
  assigneeName,
  role,
  period,
  reason,
  keyZh,
  severity,
  points,
  currentScore,
  remainingScore,
  taskId = null,
  dataSourceNote,
  bizDates
} = {}) {
  const roleLabel = roleLabelZhForBiCard(role);
  const color = severity === '高' ? 'red' : 'orange';
  const defaultWeeklyNote = '数据来源：异常触发汇总（anomaly_triggers）· 周度自动计算';
  const noteText = dataSourceNote != null ? dataSourceNote : defaultWeeklyNote;

  const bizDateLine = bizDates ? `**业务日期**：${bizDates}\n` : '';
  const content = `**备案类型**：BI异常情况扣分
**门店**：${store}
**岗位**：${roleLabel} · ${assigneeName}
**周期**：${period}
${bizDateLine}**异常类型**：${reason}（${keyZh}，严重度 ${severity}）

**分数情况**
• 现有分数：${currentScore} 分
• 本次扣分：${points} 分
• 剩余分数：${remainingScore} 分`;

  const elements = [{ tag: 'div', text: { tag: 'lark_md', content } }];

  if (taskId) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: noteText }] });
  } else {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: noteText }] });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📋 BI异常情况扣分' },
      template: color
    },
    elements
  };
}

/**
 * 与 BI异常情况扣分 同版式：月度「异常未触发」加分备案（绿头）
 */
export function buildBiBonusCard({
  store,
  assigneeName,
  role,
  period,
  bonusLines,
  rollupScore,
  bonusPoints,
  recordedTotal,
  dataSourceNote
} = {}) {
  const roleLabel = roleLabelZhForBiCard(role);
  const noteText =
    dataSourceNote ||
    '数据来源：anomaly_triggers 上月命中情况 · anomaly_item_monthly_bonus · 每月10日00:30';

  const content = `**备案类型**：BI异常未触发加分
**门店**：${store}
**岗位**：${roleLabel} · ${assigneeName}
**周期**：${period}

**加分项（上月对应异常未触发）**
${bonusLines}

**分数情况**
• 周度绩效参考分：${rollupScore} 分（anomaly_rollups_v2 最新）
• 本次加分：+${bonusPoints} 分
• 备案写入总分：${recordedTotal} 分（独立 score_model，不与周度行合并）`;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📋 BI异常未触发加分' },
      template: 'green'
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: noteText }] }
    ]
  };
}

export function buildAnomalyCard(store, anomalyKey, severity, detail, taskId) {
  const typeZh = anomalyRuleLabelZh(anomalyKey);
  const sevColor = severity === 'high' ? 'red' : severity === 'medium' ? 'orange' : 'yellow';
  const sevEmoji = severity === 'high' ? '🚨' : '⚠️';
  const taskHint = taskId
    ? `\n\n📌 **任务ID**：\`${taskId}\`\n✅ 与定时任务、随机抽检相同：请**引用/回复本条卡片消息**（或在新消息里带上任务ID）直接发送整改措施，系统将自动记录并审核。`
    : '';
  // 食安类需展示「来源表 + 日期 + 原文摘录」，字数显著多于其它异常
  const detailLimit = anomalyKey === 'food_safety' ? 3800 : 900;
  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: `**门店**：${store}\n**类型**：${typeZh}\n**严重度**：${sevEmoji} ${severity}` } },
    { tag: 'div', text: { tag: 'lark_md', content: `**详情**：${(detail || '').slice(0, detailLimit)}${taskHint}` } },
    { tag: 'hr' },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '⏰ 催办规则：下发后每间隔1小时提醒，共3次；仍未有效闭环将提交HR记入绩效' }] }
  ];
  if (taskId) {
    elements.splice(3, 0, {
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '✅ 已查看' }, type: 'primary', value: JSON.stringify({ action: 'ack_anomaly', taskId }) }
      ]
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `${sevEmoji} 异常告警 — ${store}` }, template: sevColor },
    elements
  };
}

export function buildTaskCard(title, detail, taskId, store) {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '📋 ' + title }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**门店**：${store || '-'}\n${detail || ''}` } },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '✅ 开始处理' }, type: 'primary', value: JSON.stringify({ action: 'start_task', taskId }) },
        { tag: 'button', text: { tag: 'plain_text', content: '🔍 查看详情' }, type: 'default', value: JSON.stringify({ action: 'view_task', taskId }) }
      ] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '任务ID：' + (taskId || '-').slice(0, 8) }] }
    ]
  };
}

export function buildApprovalTaskCard(task) {
  const taskId = task?.task_id || task?.taskId || '';
  const store = task?.store || '-';
  const title = task?.title || '待审批任务';
  const source = task?.source_data && typeof task.source_data === 'object' ? task.source_data : {};
  const aiSuggestion = source?.ai_suggestion || source?.suggestion || task?.detail || '';
  const riskDescription = source?.risk_description || source?.risk || '';

  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: `**门店**：${store}\n**任务**：${title}\n**任务ID**：${String(taskId).slice(0, 8)}` } },
    { tag: 'div', text: { tag: 'lark_md', content: `**AI建议**：${String(aiSuggestion).slice(0, 800)}` } },
    ...(riskDescription
      ? [{ tag: 'div', text: { tag: 'lark_md', content: `**风险说明**：${String(riskDescription).slice(0, 800)}` } }]
      : []),
    { tag: 'hr' },
    {
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '✅ 同意执行' }, type: 'primary', value: JSON.stringify({ action: 'approve_task', taskId }) },
        { tag: 'button', text: { tag: 'plain_text', content: '❌ 驳回' }, type: 'default', value: JSON.stringify({ action: 'reject_task', taskId }) }
      ]
    }
  ];

  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '🧾 需要审批' }, template: 'red' },
    elements
  };
}

/**
 * 差评新记录通知卡片 — 简洁信息卡（无按钮）
 * 在 Bitable 轮询检测到新差评时由 bitable-poller 调用
 */
export function buildBadReviewCard({ store, date, platform, rating, responsibility, content, weekCount, monthCount }) {
  const fmtDate = (v) => {
    if (v == null || v === '-') return '-';
    if (typeof v === 'number') {
      if (v > 1e12) return new Date(v).toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
      return new Date((v - 25569) * 86400000).toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
    }
    const s = String(v).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return s || '-';
  };
  const starNum = Math.min(Math.max(parseInt(String(rating || '').replace(/[^0-9.]/g, ''), 10) || 0, 0), 5);
  const stars = '★'.repeat(starNum) + '☆'.repeat(5 - starNum);
  const respLabels = [];
  if (responsibility?.isProduct) respLabels.push('🔴 出品问题');
  if (responsibility?.isService) respLabels.push('🟡 服务问题');
  if (!respLabels.length) respLabels.push('⚪ 无法确定');
  const respText = respLabels.join('、');

  const body = `**门店**：${store}
**差评日期**：${fmtDate(date)}
**平台**：${platform || '-'}
**星级**：${stars || '-'}
**责任归属**：${respText}

**差评内容**：
${content || '-'}

📊 本周累计差评：${weekCount}条
📊 本月累计差评：${monthCount}条`;

  return {
    header: { title: { tag: 'plain_text', content: `⭐ 新差评通知 · ${store}` }, template: 'red' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: body } },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '差评对我们很重要，下次不要再发生！' }] }
    ]
  };
}

/**
 * 不满意桌访通知卡片 — 简洁信息卡（无按钮）
 * 在 Bitable 轮询检测到新桌访含不满意菜品时由 bitable-poller 调用
 */
export function buildTableVisitCard({ store, fields, dishes, monthCount }) {
  // Format Bitable date (handles Unix timestamps, Excel serial, date strings)
  const fmtDate = (v) => {
    if (v == null) return '-';
    if (typeof v === 'number') {
      if (v > 1e12) { // milliseconds timestamp
        return new Date(v).toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
      }
      return new Date((v - 25569) * 86400000).toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
    }
    const s = String(v).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return s || '-';
  };

  // Helper: extract text from field with multiple name variations
  const ext = (variants) => {
    for (const v of variants) {
      const val = fields[v];
      if (val == null) continue;
      if (typeof val === 'string' && val.trim()) return val.trim();
      if (typeof val === 'number') return String(val);
      if (Array.isArray(val)) return val.map(x => (typeof x === 'object' && x?.text) || String(x)).join(', ');
      if (typeof val === 'object' && val.text) return String(val.text);
      if (typeof val === 'object' && val.name) return String(val.name);
    }
    return '-';
  };

  const date = ext(['就餐时间', '用餐时段', '餐段', '用餐时间']);
  const visitDate = fmtDate(fields['记录日期'] ?? fields['日期'] ?? fields['提交时间'] ?? fields['创建日期'] ?? fields['差评日期']);
  const tableNo = ext(['桌号', '台号']);
  const amount = ext(['消费金额', '消费', '金额', '人均消费', '总消费']);
  const guests = ext(['人数', '用餐人数', '就餐人数', '客人人数']);
  const reservation = ext(['是否有预定', '是否有预订', '预订', '预定']);
  const referral = ext(['哪里知道我们的', '怎么知道我们的', '来源', '渠道']);
  const firstVisit = ext(['是否第一次来', '第一次来', '第几次来']);
  const dishText = ext(['今天不满意的菜品', '今天不满意菜品', '今天 不满意的菜品', '今天 不满意菜品', '不满意菜品', '产品不满意项']);
  const reason = ext(['不满意的主要原因是什么', '不满意的主要原因', '不满意原因']);
  const mealReason = ext(['今天吃饭的原因', '吃饭的原因', '就餐原因']);
  const rushDish = ext(['今天催菜内容', '催菜内容', '催菜']);

  const hasRush = rushDish && rushDish !== '-' ? rushDish : '无';

  const body = `**门店**：${store}
**差评日期**：${visitDate}
**就餐时间**：${date}
**桌号**：${tableNo}
**消费金额**：${amount}元
**人数**：${guests}位
**是否有预订**：${reservation}
**怎么知道我们**：${referral}
**第几次来**：${firstVisit}
**今天不满意菜品**：${dishText}
**该产品本月投诉次数**：${monthCount}次
**不满意的主要原因**：${reason}
**今天吃饭的原因**：${mealReason}
**今天是否有催菜**：${hasRush}`;

  return {
    header: { title: { tag: 'plain_text', content: `🍽️ 不满意桌访通知 · ${store}` }, template: 'red' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: body } },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '差评对我们很重要，下次不要再发生' }] }
    ]
  };
}

export function buildRhythmReportCard(title, content, rhythmType) {
  return {
    header: { title: { tag: 'plain_text', content: title }, template: 'turquoise' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '🕐 ' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' | ' + (rhythmType || '') }] }
    ]
  };
}

/** 周度/月度绩效摘要卡片（仅 anomaly_rollups_v2；管理汇总勿用「—」加粗，飞书 lark_md 会误渲染成「一」） */
export function buildPerformanceSummaryCard({
  title,
  store,
  periodLabel,
  totalScore,
  role,
  detailMd,
  managementDigest = false,
  dimensionRatings = null,
  /** 周度 anomaly 卡：与 HRMS 周报一致，展示自然月至今备案次数 */
  monthlyFilingSummary = null
}) {
  const scoreBlock = managementDigest
    ? `**说明**：下列为各岗位 **上周异常触发汇总得分**（基准 100，扣减后可为负；与人力资源「执行力/态度/能力」月度模型分无关）。`
    : `**周度异常汇总得分**：**${totalScore}** 分（基准 100，按异常规则扣减，**可为负**；与月度综合模型分独立）`;

  let ratingBlock = '';
  if (
    monthlyFilingSummary &&
    typeof monthlyFilingSummary === 'object' &&
    (monthlyFilingSummary.executionCount != null || monthlyFilingSummary.attitudeCount != null)
  ) {
    const ex = Number(monthlyFilingSummary.executionCount) || 0;
    const at = Number(monthlyFilingSummary.attitudeCount) || 0;
    ratingBlock = `\n**本月累计备案（自然月至今）**\n• 工作执行力：**${ex}** 次\n• 工作态度：**${at}** 次`;
  } else if (dimensionRatings && typeof dimensionRatings === 'object') {
    const lines = [];
    if (dimensionRatings.store_rating) lines.push(`• 门店级别：${dimensionRatings.store_rating}级`);
    if (dimensionRatings.ability_rating) lines.push(`• 工作能力：${dimensionRatings.ability_rating}级`);
    if (dimensionRatings.attitude_rating) lines.push(`• 工作态度：${dimensionRatings.attitude_rating}级`);
    if (dimensionRatings.execution_rating) lines.push(`• 执行力：${dimensionRatings.execution_rating}级`);
    if (lines.length) ratingBlock = `\n**核心评级（A-D）**\n${lines.join('\n')}`;
  }

  return {
    header: { title: { tag: 'plain_text', content: title || '📊 绩效周度汇总' }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**门店**：${store || '-'}\n**周期**：${periodLabel}\n**岗位**：${role || '-'}\n${scoreBlock}` } },
      { tag: 'hr' },
      ...(ratingBlock ? [{ tag: 'div', text: { tag: 'lark_md', content: ratingBlock } }] : []),
      { tag: 'div', text: { tag: 'lark_md', content: `**扣分明细**\n${detailMd || '本周无异常扣分项。'}` } },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content:
              '数据来自上周各门店异常触发记录汇总；「本月累计备案」来自执行力日评与任务态度备案；核心评级（若有）来自人力资源综合模型。'
          }
        ]
      }
    ]
  };
}

export function buildGrowthAlertCard(alert) {
  const sevColor = alert.severity === 'high' ? 'red' : alert.severity === 'medium' ? 'orange' : 'blue';
  const sevEmoji = alert.severity === 'high' ? '🚨' : alert.severity === 'medium' ? '⚠️' : 'ℹ️';
  const storeText = alert.storeId || alert.store || '全部门店';
  const campaignText = alert.campaignId || '';
  const metrics = alert.metrics || {};
  const metricLines = [];
  if (metrics.scanCount != null) metricLines.push(`扫码：${metrics.scanCount}`);
  if (metrics.authorizedCount != null) metricLines.push(`授权：${metrics.authorizedCount}`);
  if (metrics.redeemedCount != null) metricLines.push(`核销：${metrics.redeemedCount}`);
  if (metrics.revenueFen != null && metrics.revenueFen > 0) metricLines.push(`收入：¥${(metrics.revenueFen / 100).toFixed(2)}`);
  const metricStr = metricLines.length ? `\n**指标**：${metricLines.join(' / ')}` : '';
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `${sevEmoji} 增长告警 — ${storeText}` }, template: sevColor },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**门店**：${storeText}\n**活动**：${campaignText || '-'}\n**严重度**：${sevEmoji} ${alert.severity}\n**消息**：${alert.message || ''}${metricStr}` } },
      { tag: 'div', text: { tag: 'lark_md', content: `**建议动作**：${alert.suggestedAction || ''}` } },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '🔄 增长监控自动生成，每小时刷新一次。请及时处理。' }] }
    ]
  };
}
