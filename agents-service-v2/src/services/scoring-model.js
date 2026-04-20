const RULES = {
  revenue_anomaly: { medium: 20, high: 40, role: 'store_manager' },
  efficiency_anomaly: { medium: 10, high: 20, roles: ['store_manager', 'store_production_manager'] },
  recharge_anomaly: { medium: 2, high: 4, role: 'store_manager' },
  // 桌访产品异常：偏厨房端（出品经理）；周汇总按产品条数用「每档 5/10 分」在 periodic-scoring 侧累加，此处仅为单条 anomaly 映射用基准分
  table_visit_anomaly: { medium: 5, high: 10, role: 'store_production_manager' },
  // 桌访占比异常：偏前厅端（店长）
  table_visit_ratio_anomaly: { medium: 5, high: 10, role: 'store_manager' },
  margin_anomaly: { medium: 20, high: 40, role: 'store_production_manager' },
  product_review: { medium: 5, high: 10, role: 'store_production_manager' },
  service_review: { medium: 5, high: 10, role: 'store_manager' },
  private_room_anomaly: { medium: 5, high: 10, role: 'store_manager' },
  food_safety: { medium: 15, high: 30, roles: ['store_manager', 'store_production_manager'] }
};

function ruleAppliesToRole(r, role) {
  if (r.roles?.length) return r.roles.includes(role);
  return r.role === role;
}

export function calcDeductions(anomalies, role) {
  let t = 0;
  const d = [];
  for (const a of anomalies) {
    const r = RULES[a.category];
    if (!r || !ruleAppliesToRole(r, role)) continue;
    const p = a.customPoints != null ? Number(a.customPoints) : r[a.severity] || 0;
    if (!p) continue;
    t += p;
    d.push({ ...a, points: p });
  }
  return { total: t, details: d };
}

export function storeRating(rate) {
  if (rate > 0.95) return 'A';
  if (rate > 0.9) return 'B';
  if (rate >= 0.85) return 'C';
  return 'D';
}

export function calcBonus(score, brand, rating) {
  const base = /马己仙|majixin/i.test(String(brand || '')) ? 1500 : 2000;
  if (rating === 'D') return { bonus: 0, note: 'wage_80pct' };
  if (rating === 'C') return { bonus: 0, note: 'no_bonus' };
  return { bonus: Math.round((score / 100) * base), note: 'normal' };
}
