/**
 * 出品经理开档/收档/原料收货 —— 按「业务日期」统计，与聊天确定性回复、飞书表「日期」列一致。
 *
 * 旧逻辑用 agent_messages.created_at::date，轮询在午夜后写入时会落到「次日」，导致执行力日评误判未提交。
 */
import { query } from '../utils/db.js';
import { expandAgentStoreLabels } from '../config/store-mapping.js';
import { sameStore, ext, resolveBitableBusinessYmd } from './deterministic-replies.js';

function storeMatchesRow(displayStore, rowStoreRaw) {
  const rowStore = ext(rowStoreRaw);
  if (!rowStore) return false;
  const labels = expandAgentStoreLabels(displayStore);
  return labels.some((lab) => sameStore(rowStore, lab));
}

function materialConfigKeyForBrand(brandZh) {
  if (brandZh === '洪潮') return 'material_hongchao';
  if (brandZh === '马己仙') return 'material_majixian';
  return '';
}

/**
 * 单日：是否有业务日期 = dateYmd 的开档报告
 */
export async function pmHasOpeningReportBizDate(displayStore, dateYmd) {
  const r = await query(
    `SELECT agent_data, created_at FROM agent_messages
     WHERE content_type = 'opening_report'
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN ($1::date - 2) AND ($1::date + 2)`,
    [dateYmd]
  );
  for (const row of r.rows || []) {
    const fields = row.agent_data?.fields || {};
    if (!storeMatchesRow(displayStore, fields.store)) continue;
    const biz = resolveBitableBusinessYmd(fields.date, row.created_at);
    if (biz === dateYmd) return true;
  }
  return false;
}

/**
 * 单日：是否有业务日期 = dateYmd 的收档报告
 */
export async function pmHasClosingReportBizDate(displayStore, dateYmd) {
  const r = await query(
    `SELECT agent_data, created_at FROM agent_messages
     WHERE content_type = 'closing_report'
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN ($1::date - 2) AND ($1::date + 2)`,
    [dateYmd]
  );
  for (const row of r.rows || []) {
    const fields = row.agent_data?.fields || {};
    if (!storeMatchesRow(displayStore, fields.store)) continue;
    const biz = resolveBitableBusinessYmd(fields.date, row.created_at);
    if (biz === dateYmd) return true;
  }
  return false;
}

/**
 * 单日：是否有业务日期 = dateYmd 的原料收货（feishu_generic_records，与 buildMaterialReportReply 同源）
 */
export async function pmHasMaterialReportBizDate(displayStore, brandZh, dateYmd) {
  const key = materialConfigKeyForBrand(brandZh);
  if (!key) return false;
  const r = await query(
    `SELECT fields, created_at FROM feishu_generic_records
     WHERE config_key = $1
     ORDER BY updated_at DESC
     LIMIT 5000`,
    [key]
  );
  for (const row of r.rows || []) {
    const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
    if (!storeMatchesRow(displayStore, f['门店'] || f['所属门店'])) continue;
    const biz = resolveBitableBusinessYmd(f['收货日期'] || f['日期'], row.created_at);
    if (biz === dateYmd) return true;
  }
  return false;
}

export async function getPMReportStatusByBizDate(store, brandZh, dateYmd) {
  const [opening, closing, material] = await Promise.all([
    pmHasOpeningReportBizDate(store, dateYmd),
    pmHasClosingReportBizDate(store, dateYmd),
    pmHasMaterialReportBizDate(store, brandZh, dateYmd)
  ]);
  return { opening, closing, material };
}

function collectDistinctBizDays(rows, displayStore, fieldDateKeys, startYmd, endYmd) {
  const days = new Set();
  for (const row of rows || []) {
    const fields = row.agent_data?.fields || {};
    if (!storeMatchesRow(displayStore, fields.store)) continue;
    let biz = '';
    for (const k of fieldDateKeys) {
      const v = fields[k];
      if (v != null && String(v).trim() !== '') {
        biz = resolveBitableBusinessYmd(v, row.created_at);
        break;
      }
    }
    if (!biz) biz = resolveBitableBusinessYmd(null, row.created_at);
    if (biz && biz >= startYmd && biz <= endYmd) days.add(biz);
  }
  return days.size;
}

/**
 * 月度：开档/收档各自在 [startYmd,endYmd] 内有多少个不同业务日有记录
 */
export async function countDistinctOpeningBizDays(displayStore, startYmd, endYmd) {
  const r = await query(
    `SELECT agent_data, created_at FROM agent_messages
     WHERE content_type = 'opening_report'
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= $1::date - 2
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= $2::date + 2`,
    [startYmd, endYmd]
  );
  return collectDistinctBizDays(r.rows, displayStore, ['date'], startYmd, endYmd);
}

export async function countDistinctClosingBizDays(displayStore, startYmd, endYmd) {
  const r = await query(
    `SELECT agent_data, created_at FROM agent_messages
     WHERE content_type = 'closing_report'
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= $1::date - 2
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= $2::date + 2`,
    [startYmd, endYmd]
  );
  return collectDistinctBizDays(r.rows, displayStore, ['date'], startYmd, endYmd);
}

export async function countDistinctMaterialBizDays(displayStore, brandZh, startYmd, endYmd) {
  const key = materialConfigKeyForBrand(brandZh);
  if (!key) return 0;
  const r = await query(
    `SELECT fields, created_at FROM feishu_generic_records
     WHERE config_key = $1
     ORDER BY updated_at DESC
     LIMIT 15000`,
    [key]
  );
  const days = new Set();
  for (const row of r.rows || []) {
    const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
    if (!storeMatchesRow(displayStore, f['门店'] || f['所属门店'])) continue;
    const biz = resolveBitableBusinessYmd(f['收货日期'] || f['日期'], row.created_at);
    if (biz && biz >= startYmd && biz <= endYmd) days.add(biz);
  }
  return days.size;
}
