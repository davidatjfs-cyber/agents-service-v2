/**
 * Chairman 模块入口 — 统一导出
 */
export { generateDiagnosis } from './chairman-diagnosis.js';
export { evaluateTaskOutcome, evaluateAllPendingOutcomes } from './decision-outcome-tracker.js';
export { runTrendChecks, checkWeekdayTrend, checkMealBalance, checkDishDecline } from './trend-rules.js';
export { matchTemplates, matchDBTemplates, anomalyToScenario, formatTemplateOptions } from './action-templates.js';
export { sendWeeklyReview, generateWeeklyReview } from './weekly-review.js';
export { checkAndTriggerTraining, getTrainingTriggerRules } from './training-trigger-rules.js';
