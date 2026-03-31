/**
 * 用户明确要营销/活动/方案类回答时，禁止被「营运诊断」或「确定性营收分析」短路，
 * 必须走 marketing_planner / marketing_executor + DB 上下文。
 */
export function isMarketingPlanningIntent(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return /(营销策划|营销方案|营销活动|营销计划|推广方案|活动策划|活动计划|活动方案|引流|拉新|会员.?活动|促销活动|外卖.*(营收|增长)|ROI|给我.*(方案|计划)|制定.*(方案|计划)|怎么.*(营销|推广)|如何.*(营销|推广))/i.test(t);
}
