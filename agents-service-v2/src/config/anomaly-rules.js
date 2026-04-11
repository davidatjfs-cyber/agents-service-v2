/**
 * 10类异常规则配置 — 总部主管定标
 * 
 * 每条规则包含：
 *   key          唯一标识
 *   name         中文名
 *   frequency    检测频率 daily|weekly|monthly|realtime
 *   brands       适用品牌 (null=全部)
 *   thresholds   阈值配置 { medium, high } (按品牌可不同)
 *   dataSource   数据来源表/字段
 *   assignTo     触发后派给谁 { role, title }
 *   hrFollowUp   月底HR绩效跟进
 *   evidence     验收所需证据
 *   autoActions  Agent可自动执行的动作
 *   notes        特殊说明
 */

export const ANOMALY_RULES = [
  // ─── 1. 实收营收异常（周度）───
  {
    key: 'revenue_achievement',
    name: '实收营收异常',
    frequency: 'weekly',
    brands: null,
    thresholds: {
      // 实际达成率 vs 理论达成率差值 >= 10% 触发
      medium: { achievement_gap_pct: 10 },
      high: { achievement_gap_pct: 15 }
    },
    dataSource: {
      table: 'daily_reports',
      fields: ['actual_revenue'],
      target: 'revenue_targets.target_revenue',
      calc: '周实收 vs 周目标（月目标×7/当月天数），差值>=阈值触发'
    },
    assignTo: { role: 'ops', title: '运营' },
    notifyTarget: { role: 'store_manager', title: '店长' },
    hrFollowUp: true,
    hrTiming: 'month_end',
    evidence: {
      required: ['营收提升方案（文字）'],
      optional: ['数据截图']
    },
    autoActions: ['trigger', 'remind', 'follow_up', 'pdca_generate'],
    notes: '每周一05:00触发（rhythm-engine），统计上一完整自然周'
  },

  // ─── 1b. 实收营收异常（月度）───
  {
    key: 'revenue_achievement_monthly',
    name: '月度实收营收达成异常',
    frequency: 'monthly',
    brands: null,
    thresholds: {
      medium: { achievement_gap_pct: 10 },
      high: { achievement_gap_pct: 15 }
    },
    dataSource: {
      table: 'daily_reports',
      fields: ['actual_revenue'],
      target: 'revenue_targets.target_revenue',
      calc: '上月全月实收 vs 月目标，差值>=阈值触发'
    },
    assignTo: { role: 'ops', title: '运营' },
    notifyTarget: { role: 'store_manager', title: '店长' },
    hrFollowUp: true,
    hrTiming: 'on_trigger',
    evidence: {
      required: ['营收提升方案（文字）'],
      optional: ['数据截图']
    },
    autoActions: ['trigger', 'remind', 'follow_up', 'pdca_generate'],
    notes: '每月1日08:00触发，统计上月全月'
  },

  // ─── 2. 人效值异常 ───
  {
    key: 'labor_efficiency',
    name: '人效值异常',
    frequency: 'weekly',
    brands: null,
    thresholds: {
      '洪潮': { medium: { below: 1100 }, high: { below: 1000 } },
      '马己仙': { medium: { below: 1400 }, high: { below: 1300 } }
    },
    dataSource: {
      table: 'daily_reports',
      fields: ['efficiency'],
      calc: '人效 = actual_revenue / labor_total'
    },
    assignTo: { role: 'ops', title: '运营' },
    notifyTarget: [
      { role: 'store_manager', title: '店长' },
      { role: 'kitchen_manager', title: '出品经理' }
    ],
    hrFollowUp: true,
    hrTiming: 'month_end',
    evidence: {
      required: ['每天每小时人效值明细', '低人效时段优化行动方案'],
      optional: []
    },
    autoActions: ['trigger', 'remind', 'follow_up', 'pdca_generate'],
    notes: '按品牌不同阈值'
  },

  // ─── 3. 充值异常 ───
  {
    key: 'recharge_zero',
    name: '充值异常',
    frequency: 'daily',
    brands: null,
    thresholds: {
      medium: { zero_days: 1 },
      high: { consecutive_zero_days: 2 }
    },
    dataSource: {
      table: 'daily_reports',
      fields: ['recharge_count', 'recharge_amount'],
      calc: '当日充值=0为medium，连续2天=0为high'
    },
    assignTo: { role: 'ops', title: '运营' },
    notifyTarget: { role: 'store_manager', title: '店长' },
    hrFollowUp: true,
    hrTiming: 'on_trigger',
    evidence: {
      required: ['服务员推销充值的视频'],
      optional: ['推销技能分析报告']
    },
    autoActions: ['trigger', 'remind', 'follow_up'],
    notes: '每天统计'
  },

  // ─── 4. 桌访产品异常（产品投诉过多） ───
  {
    key: 'table_visit_product',
    name: '桌访产品异常',
    frequency: 'weekly',
    brands: null,
    thresholds: {
      // 1周内同一产品投诉次数
      medium: { same_product_complaints: 2 },
      high: { same_product_complaints: 4 }
    },
    dataSource: {
      table: 'table_visit_records + feishu_generic_records（与聊天「桌访」合并去重，同源）',
      fields: [
        '今天不满意菜品（BI 唯一计分来源；飞书列名须与此一致，或经入库写入 fields 同名键）',
        '今天 不满意菜品（唯一允许的空格变体）',
        'dissatisfaction_dish（仅经 syntheticFieldsFromStructuredRow 映射到「今天不满意菜品」后参与 BI）',
        '不满意的主要原因是什么（与菜品列联判「不满意」行，规则见 deterministic-replies）'
      ],
      calc:
        '调度：每周一 05:00（Asia/Shanghai）周频 BI。窗口：shanghaiLastCompletedWeekBounds = 仅「上周一～上周日」。菜品名仅拆分「今天不满意菜品」列内容；周度扣分按产品维度累计（≥4→10，≥2→5）。'
    },
    assignTo: { role: 'ops', title: '运营' },
    notifyTarget: { role: 'kitchen_manager', title: '出品经理' },
    hrFollowUp: true,
    hrTiming: 'on_trigger',
    evidence: {
      required: ['差评产品操作过程问题点', '出错点分析', '整改方案'],
      optional: ['操作视频']
    },
    autoActions: ['trigger', 'remind', 'follow_up', 'pdca_generate'],
    notes:
      '与 deterministic-replies 桌访合并口径一致；引擎与 periodic-scoring 周汇总均按「产品维度累计扣分」执行，勿按「全店只扣一档」理解。'
  },

  // ─── 5. 桌访占比异常 ───
  {
    key: 'table_visit_ratio',
    name: '桌访占比异常',
    frequency: 'weekly',
    brands: null,
    thresholds: {
      // 桌访率 = 桌访数量 / 堂食订单数
      medium: { below_pct: 50 },
      high: { below_pct: 40 }
    },
    dataSource: {
      table: ['table_visit_records', 'daily_reports'],
      fields: ['桌访数量', 'dine_orders'],
      calc: '桌访数/堂食订单数 * 100'
    },
    assignTo: { role: 'ops', title: '运营' },
    notifyTarget: { role: 'store_manager', title: '店长' },
    hrFollowUp: true,
    hrTiming: 'month_end',
    evidence: {
      required: ['每天桌访数量', '分配到具体责任人', '未完成人员及原因'],
      optional: []
    },
    autoActions: ['trigger', 'remind', 'follow_up'],
    notes: '每周+月底各统计一次'
  },

  // ─── 6. 总实收毛利率异常 ───
  {
    key: 'gross_margin',
    name: '总实收毛利率异常',
    frequency: 'monthly',
    brands: null,
    thresholds: {
      '洪潮': { medium: { below_pct: 69 }, high: { below_pct: 68 } },
      '马己仙': { medium: { below_pct: 64 }, high: { below_pct: 63 } }
    },
    dataSource: {
      table: 'daily_reports',
      fields: ['actual_margin'],
      calc: '每月5号前统计上月实收毛利率，需新增输入渠道'
    },
    assignTo: { role: 'ops', title: '运营' },
    notifyTarget: { role: 'kitchen_manager', title: '出品经理' },
    hrFollowUp: true,
    hrTiming: 'on_trigger',
    evidence: {
      required: ['盘点表', '原料去向分析（门店库存 vs 浪费）'],
      optional: ['整改方案']
    },
    autoActions: ['trigger', 'remind'],
    notes: '⚠️ 需新增monthly_margin输入渠道（营业日报或独立表单）'
  },

  // ─── 7. 差评报告产品异常 ───
  {
    key: 'bad_review_product',
    name: '差评报告产品异常',
    frequency: 'weekly',
    brands: null,
    thresholds: {
      // 1周内产品相关差评
      medium: { count: 1 },
      high: { count: 2 }
    },
    dataSource: {
      table: 'feishu_generic_records',
      config: 'bad_review',
      fields: ['差评类型=产品'],
      calc: '大众点评差评中关于产品的，1周内1条medium,2条high'
    },
    assignTo: { role: 'ops', title: '运营' },
    notifyTarget: { role: 'kitchen_manager', title: '出品经理' },
    hrFollowUp: true,
    hrTiming: 'on_trigger',
    evidence: {
      required: ['差评产品操作过程问题点', '出错点分析', '整改方案'],
      optional: []
    },
    autoActions: ['trigger', 'remind', 'follow_up', 'pdca_generate'],
    notes: '数据从差评报告获取'
  },

  // ─── 8. 差评报告服务异常 ───
  {
    key: 'bad_review_service',
    name: '差评报告服务异常',
    frequency: 'weekly',
    brands: null,
    thresholds: {
      medium: { count_per_week: 1 },
      high: { count_per_week: 2 }
    },
    dataSource: {
      table: 'feishu_generic_records',
      config: 'bad_review',
      fields: ['差评类型=服务'],
      calc: '大众点评差评中关于服务的，每自然周独立计算不跨周：1条=medium(5分)；2条=high(20分，即2×10)；3条=30分(3×10)；次周清零重新统计'
    },
    assignTo: { role: 'ops', title: '运营' },
    notifyTarget: { role: 'store_manager', title: '店长' },
    hrFollowUp: true,
    hrTiming: 'on_trigger',
    evidence: {
      required: ['差评案例培训材料', '员工培训照片'],
      optional: []
    },
    autoActions: ['trigger', 'remind', 'follow_up'],
    notes: '每自然周独立计算，不跨周累计；1条5分、2条20分（2×10）、3条30分（3×10）；次周清零重新统计'
  },

  // ─── 9. 洪潮久光包房使用异常 ───
  {
    key: 'hongchao_jiuguang_private_room',
    name: '洪潮久光包房使用异常',
    frequency: 'weekly',
    brands: ['洪潮'],
    thresholds: {
      target_uses: 28,
      medium: { below: 22 },
      high: { below: 20 }
    },
    dataSource: {
      table: 'daily_reports',
      fields: ['private_room_uses'],
      calc: '上周一～上周日，2间包房合计使用次数；每周目标28次，<22触发medium，<20触发high'
    },
    assignTo: { role: 'store_manager', title: '店长' },
    notifyTarget: { role: 'store_manager', title: '店长' },
    hrFollowUp: true,
    hrTiming: 'on_trigger',
    evidence: {
      required: ['包房使用明细', '未达标原因分析'],
      optional: ['整改方案']
    },
    autoActions: ['trigger', 'remind'],
    notes: '仅适用于洪潮久光门店（大宁久光），每周一检测上周使用次数'
  },

  // ─── 10. 食品安全评价异常 ───
  {
    key: 'food_safety',
    name: '食品安全评价异常',
    frequency: 'realtime',
    brands: null,
    thresholds: {
      // 任何食安关键词立即触发
      high: { keywords: ['异物', '异味', '不舒服', '拉肚子', '头发', '虫', '变质', '过期', '发霉', '食物中毒'] }
    },
    dataSource: {
      table: ['table_visit_records', 'feishu_generic_records'],
      config: ['table_visit', 'bad_review'],
      fields: ['评价内容', '差评内容'],
      calc: '关键词匹配，任何命中立即触发'
    },
    assignTo: { role: 'ops', title: '运营' },
    notifyTarget: [
      { role: 'store_manager', title: '店长' },
      { role: 'kitchen_manager', title: '出品经理' }
    ],
    hrFollowUp: true,
    hrTiming: 'immediate',
    evidence: {
      required: [
        '食品安全调查报告',
        '情况属实性确认（店长承诺书 或 属实确认）',
        '责任人确认',
        '整改方案（不少于200字，含调查过程+整改措施）',
        '整改照片'
      ],
      optional: ['视频']
    },
    autoActions: ['trigger'],
    humanRequired: ['investigation_confirm', 'penalty_score', 'case_close'],
    workflow: {
      step1: '触发食品安全调查报告 → 发给店长+出品经理',
      step2_a: '情况不属实 → 店长签承诺书（隐瞒不报承担全责）→ 发总部营运确认 → 结案',
      step2_b: '情况属实 → 店长确认责任人',
      step3: '责任人在厨房 → 出品经理扣20分/次；责任人在前厅 → 店长扣20分/次',
      step4: '不确定前厅/后厨 → 店长+出品经理各扣20分',
      step5: '责任代表（前厅=店长，后厨=厨师长）提交整改方案（>=200字）'
    },
    notes: '最高优先级，立即触发，需人工审批结案。红色通道。'
  },

  // ─── 11. 客流量/订单数异常 ───
  {
    key: 'traffic_decline',
    name: '客流量/订单数异常',
    frequency: 'weekly',
    brands: null,
    thresholds: {
      // 环比下降超过10%
      medium: { wow_decline_pct: 10 },
      high: { wow_decline_pct: 20 }
    },
    dataSource: {
      table: 'daily_reports',
      fields: ['dine_traffic', 'dine_orders'],
      calc: '本周堂食客流/订单 vs 上周，环比下降>=10%触发'
    },
    assignTo: { role: 'marketing', title: '市场部Agent' },
    notifyTarget: { role: 'store_manager', title: '店长' },
    hrFollowUp: false,
    evidence: {
      required: ['客流提升计划', '店长沟通确认记录'],
      optional: ['活动方案']
    },
    autoActions: ['trigger', 'remind', 'generate_suggestions', 'follow_up'],
    notes: '由Marketing Agent负责，给店长提升客流建议，沟通确定提升计划'
  }
];

// ─── 升级链配置 ───
export const ESCALATION_CONFIG = {
  red_channel: {
    trigger_conditions: [
      'severity=high AND 未响应超过24h',
      '连续3天关键指标异常（营收/人效/毛利）',
      '食品安全异常（任何级别立即升级）',
      '重大客诉'
    ],
    escalate_to: ['hq_manager', 'admin'],
    by_brand: true,
    by_store: true
  },
  levels: [
    { level: 1, target_role: 'ops', timeout_hours: 24 },
    { level: 2, target_role: 'hq_manager', timeout_hours: 48 },
    { level: 3, target_role: 'admin', timeout_hours: null }
  ]
};

// ─── SLA配置 ───
export const SLA_CONFIG = {
  high: { close_within_hours: 24, first_response_hours: 4 },
  medium: { close_within_hours: 72, first_response_hours: 12 },
  low: { close_within_hours: 168, first_response_hours: 24 },
  food_safety: { close_within_hours: 12, first_response_hours: 1 }
};

// ─── 推送对象配置 ───
export const PUSH_CONFIG = {
  daily_rhythm: {
    morning_standup: { to: ['hq_manager', 'admin'] },
    patrol: { to: ['hq_manager', 'admin'] },
    end_of_day: { to: ['hq_manager', 'admin'] }
  },
  weekly_report: {
    store_level: { to: ['store_manager', 'kitchen_manager'], scope: 'own_store' },
    hq_level: { to: ['hq_manager', 'admin'], scope: 'all_stores' }
  },
  monthly_report: {
    store_level: { to: ['store_manager', 'kitchen_manager'], scope: 'own_store' },
    hq_level: { to: ['hq_manager', 'admin'], scope: 'all_stores' }
  },
  anomaly_alert: {
    to_assignee: true,
    to_notify_target: true,
    red_channel: { to: ['hq_manager', 'admin'] }
  }
};

// ─── 自动决策边界 ───
export const AUTO_DECISION_BOUNDARY = {
  auto: [
    'anomaly_trigger',
    'remind',
    'follow_up_tracking',
    'pdca_generate',
    'trend_monitoring',
    'suggestions_generate'
  ],
  human_required: [
    'payment_approval',
    'marketing_campaign_approval',
    'food_safety_investigation',
    'serious_complaint_handling',
    'penalty_approval'
  ],
  human_escalate_to: ['hq_manager', 'admin']
};
