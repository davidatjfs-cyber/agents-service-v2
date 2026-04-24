/**
 * 任务卡责任人 → 飞书 open_id：与 daily_reports / 飞书表 / 用户绑定 的门店别名对齐。
 * 避免「发卡用 fuzzy、催办用精确」导致洪潮（大宁久光↔久光简称）、马已仙/马己仙 等反复踩坑。
 */
import { expandAgentStoreLabels } from '../config/store-mapping.js';
import { query } from './db.js';

function majixianTypos(s) {
  const t = String(s || '').trim();
  if (!t) return [];
  const out = new Set([t]);
  if (t.includes('马已仙')) out.add(t.replace(/马已仙/g, '马己仙'));
  if (t.includes('马己仙')) out.add(t.replace(/马己仙/g, '马已仙'));
  return [...out];
}

/** 汇总门店字段所有应参与匹配的写法（含品牌规范名、飞书简称、错别字变体） */
export function collectStoreLookupVariants(storeRaw) {
  const set = new Set();
  for (const label of expandAgentStoreLabels(storeRaw)) {
    for (const v of majixianTypos(label)) {
      const x = v.trim();
      if (x) set.add(x);
    }
  }
  return [...set];
}

function uniq(ids) {
  return [...new Set((ids || []).filter(Boolean))];
}

/**
 * 解析任务责任人飞书 open_id：username 优先；门店+角色用别名集合精确匹配，再对 role 全表做「任务店名变体 ∩ 用户店名变体」交集。
 */
export async function resolveAssigneeOpenIdsForTask(task) {
  const un = String(task?.assignee_username || '').trim();
  if (un) {
    const r = await query(
      `SELECT open_id FROM feishu_users
       WHERE lower(username) = lower($1) AND registered = true AND open_id IS NOT NULL AND trim(open_id) <> ''
         AND open_id NOT LIKE '%probe%'
       LIMIT 3`,
      [un]
    );
    if (r.rows?.length) return uniq(r.rows.map((x) => x.open_id));
  }
  const role = String(task?.assignee_role || 'store_manager').trim();
  const variants = collectStoreLookupVariants(String(task?.store || ''));
  if (!variants.length) return [];

  const r2 = await query(
    `SELECT open_id FROM feishu_users
     WHERE registered = true AND open_id IS NOT NULL AND trim(open_id) <> '' AND role = $1
       AND trim(store) = ANY($2::text[])
       AND open_id NOT LIKE '%probe%'`,
    [role, variants]
  );
  if (r2.rows?.length) return uniq(r2.rows.map((x) => x.open_id));

  const taskSet = new Set(variants);
  const r3 = await query(
    `SELECT open_id, store FROM feishu_users
     WHERE registered = true AND open_id IS NOT NULL AND trim(open_id) <> '' AND role = $1
       AND open_id NOT LIKE '%probe%'`,
    [role]
  );
  const out = [];
  for (const row of r3.rows || []) {
    const rowSet = new Set(collectStoreLookupVariants(row.store));
    for (const v of taskSet) {
      if (rowSet.has(v)) {
        out.push(row.open_id);
        break;
      }
    }
  }
  return uniq(out);
}
