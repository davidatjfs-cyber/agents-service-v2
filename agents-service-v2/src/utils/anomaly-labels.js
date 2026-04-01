import { ANOMALY_RULES } from '../config/anomaly-rules.js';

const KEY_ALIASES = {
  table_visit_prod: 'table_visit_product'
};

/** 飞书/任务展示用：规则中文名（含历史别名） */
export function anomalyRuleLabelZh(ruleKey) {
  const raw = String(ruleKey || '').trim();
  const k = KEY_ALIASES[raw] || raw;
  const r = ANOMALY_RULES.find((x) => x.key === k);
  return r?.name || raw;
}
