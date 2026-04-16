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

function normKey(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * 人工录入/飞书昵称常见混用：「马已仙」(已) 与规范「马己仙」(己)
 * 不入库则桌访 ILIKE、门店归一化会对不上 structured 表与 feishu_generic_records。
 */
export function normalizeStoreOcrTypos(s) {
  return String(s || '').replace(/马已仙/g, '马己仙');
}

/**
 * 用户/绑定里的简称 → 与 daily_reports、结构化桌访对齐的规范店名
 */
export function resolveAgentCanonicalStore(input) {
  const s = normalizeStoreOcrTypos(String(input || '').trim());
  if (!s) return s;
  if (/洪潮|洪潮门店|大宁久光/.test(s)) return '洪潮大宁久光店';
  if (/马己仙|马己仙门店|音乐广场/.test(s)) return '马己仙上海音乐广场店';
  const k = normKey(s);
  for (const dr of Object.keys(STORE_TO_FEISHU)) {
    if (normKey(dr) === k) return dr;
    const fs = STORE_TO_FEISHU[dr];
    if (normKey(fs) === k) return dr;
  }
  return s;
}

/**
 * 桌访/日报匹配用：规范名 + 飞书简称 + 用户原样（避免「马己仙」对不上「马己仙大宁店」）
 */
export function expandAgentStoreLabels(input) {
  const raw = normalizeStoreOcrTypos(String(input || '').trim());
  const canon = resolveAgentCanonicalStore(raw);
  const out = new Set([raw, canon].filter(Boolean));
  const f1 = toFeishuStoreName(canon);
  if (f1) out.add(f1);
  const f2 = toFeishuStoreName(raw);
  if (f2) out.add(f2);
  for (const [dr, fs] of Object.entries(STORE_TO_FEISHU)) {
    if (canon === dr) {
      out.add(dr);
      out.add(fs);
    }
  }
  return [...out];
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

/** bitable 轮询写入的 brand 可能是 majixian/hongchao，与执行力/聊天侧 马己仙/洪潮 对齐 */
export function normalizeAgentMaterialBrand(raw) {
  const b = String(raw || '').trim();
  const l = b.toLowerCase();
  if (!b) return '';
  if (l === 'majixian' || b === '马己仙') return '马己仙';
  if (l === 'hongchao' || b === '洪潮') return '洪潮';
  return b;
}
