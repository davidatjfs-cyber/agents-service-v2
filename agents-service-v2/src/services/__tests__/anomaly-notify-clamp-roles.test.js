import { clampNotifyRolesForRule } from '../anomaly-notify-pipeline.js';

describe('clampNotifyRolesForRule', () => {
  test('桌访产品异常仅出品经理', () => {
    expect(clampNotifyRolesForRule('table_visit_product', ['store_manager', 'store_production_manager'])).toEqual([
      'store_production_manager'
    ]);
  });
  test('服务差评仅店长', () => {
    expect(clampNotifyRolesForRule('bad_review_service', ['store_production_manager', 'store_manager'])).toEqual([
      'store_manager'
    ]);
  });
  test('人效异常沿用配置（可多岗）', () => {
    const dual = ['store_production_manager', 'store_manager'];
    expect(clampNotifyRolesForRule('labor_efficiency', dual)).toEqual(dual);
  });
});
