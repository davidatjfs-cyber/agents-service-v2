/**
 * 与 agents-service-v2/src/utils/cron-run-monitor.js 中 CRON_JOB_LABEL_ZH 保持同步，
 * 供 HRMS 数据中心等接口展示中文任务名。
 */
export const CRON_JOB_LABEL_ZH = {
  kpi_yesterday: '昨日 KPI 计算',
  morning_briefing: '每日晨报推送',
  daily_execution_rating: '执行力日评',
  food_safety_daily_scan: '食安日扫',
  daily_task_completion_report: '每日任务达成率报告',
  daily_bi_anomaly: '日频 BI 异常检测',
  bitable_actual_gross_margin: '飞书实际毛利率表同步',
  weekly_bi_anomaly: '周频 BI 异常检测',
  weekly_store_scoring: '周度门店评分',
  monthly_anomaly_item_bonus: '月度异常项加分',
  monthly_gross_margin_check: '月度毛利率检测',
  monthly_comprehensive_rating: '月度综合评级',
  rhythm_weekly_report: '总部周报节奏',
  rhythm_monthly_evaluation: '总部月度评估节奏',
  monthly_revenue_anomaly: '月度营收异常检测',
  daily_attendance_report: '考勤日报',
  escalation_scan: '任务升级扫描',
  task_card_reminders: '任务卡片催办',
  daily_inspection_tick: '每日巡检调度（整轮）'
};

export function cronJobLabelZh(jobKey) {
  const k = String(jobKey || '').trim();
  return CRON_JOB_LABEL_ZH[k] || k;
}
