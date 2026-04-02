import { query } from '../utils/db.js';

const RULES = {
  revenue_anomaly: { medium:20, high:40, role:'store_manager' },
  efficiency_anomaly: { medium:10, high:20, role:'store_manager' },
  recharge_anomaly: { medium:1, high:2, role:'store_manager' },
  table_visit_anomaly: { medium:5, high:10, role:'store_production_manager' },
  margin_anomaly: { medium:20, high:40, role:'store_production_manager' },
  product_review: { medium:5, high:10, role:'store_production_manager' },
  service_review: { medium:5, high:10, role:'store_manager' },
};

export function calcDeductions(anomalies, role) {
  let t=0; const d=[];
  for (const a of anomalies) { const r=RULES[a.category]; if(!r||r.role!==role) continue; const p=r[a.severity]||0; t+=p; d.push({...a,points:p}); }
  return {total:t,details:d};
}

export function storeRating(rate) {
  if(rate>0.95) return 'A'; if(rate>0.90) return 'B'; if(rate>=0.85) return 'C'; return 'D';
}

export function calcBonus(score, brand, rating) {
  const base = brand==='majixin' ? 1500 : 2000;
  if(rating==='D') return {bonus:0,note:'wage_80pct'};
  if(rating==='C') return {bonus:0,note:'no_bonus'};
  return {bonus:Math.round(score/100*base),note:'normal'};
}
