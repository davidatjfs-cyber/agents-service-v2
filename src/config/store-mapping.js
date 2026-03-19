/**
 * 门店名称映射 — daily_reports vs feishu_generic_records 桌访/差评
 * 
 * daily_reports 使用全称，飞书多维表格使用简称
 */

const STORE_TO_FEISHU = {
  '洪潮大宁久光店': '洪潮久光店',
  '马己仙上海音乐广场店': '马己仙大宁店'
};

const FEISHU_TO_STORE = {};
for (const [k, v] of Object.entries(STORE_TO_FEISHU)) {
  FEISHU_TO_STORE[v] = k;
}

/**
 * daily_reports 门店名 → 飞书多维表格门店名
 */
export function toFeishuStoreName(storeName) {
  return STORE_TO_FEISHU[storeName] || storeName;
}

/**
 * 飞书多维表格门店名 → daily_reports 门店名
 */
export function toDrStoreName(feishuName) {
  return FEISHU_TO_STORE[feishuName] || feishuName;
}

/**
 * 获取全部门店映射
 */
export function getAllStoreMappings() {
  return STORE_TO_FEISHU;
}
