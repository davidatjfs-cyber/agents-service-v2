#!/usr/bin/env node
// NOTE: If package.json has "type": "module", rename this to .cjs or run with --input-type=commonjs
/**
 * One-time migration: re-extract dissatisfaction_dish + unsatisfied_items
 * from feishu_generic_records into table_visit_records using the correct
 * Bitable field names and complex value parser.
 */
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/hrms' });

function extractBitableFieldText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number') return String(val);
  if (Array.isArray(val)) {
    const parts = [];
    for (const item of val) {
      if (typeof item === 'string') { parts.push(item); continue; }
      if (item && typeof item === 'object') {
        if (Array.isArray(item.text_arr) && item.text_arr.length) {
          parts.push(...item.text_arr.map(t => String(t || '').trim()).filter(Boolean));
        } else if (item.text) {
          parts.push(String(item.text).trim());
        }
      }
    }
    return parts.join('，').trim();
  }
  if (typeof val === 'object' && val.text) return String(val.text).trim();
  return String(val).trim();
}

function extractDissatisfactionDishFromFields(fields) {
  const candidates = [
    fields['今天 不满意菜品'],
    fields['今天不满意菜品'],
    fields['今日不满意菜品'],
    fields['不满意菜品'],
    fields['不满意菜品/问题'],
  ];
  for (const v of candidates) {
    const text = extractBitableFieldText(v);
    if (text) return text;
  }
  return '';
}

function extractDissatisfactionReasonFromFields(fields) {
  const candidates = [
    fields['满意或不满意的主要原因是什么？'],
    fields['满意或不满意的主要原因'],
    fields['不满意项'],
    fields['不满意原因'],
    fields['备注'],
  ];
  for (const v of candidates) {
    const text = extractBitableFieldText(v);
    if (text) return text;
  }
  return '';
}

(async () => {
  console.log('[resync] Starting table_visit_records re-sync from feishu_generic_records...');
  
  const tableId = 'tblpx5Efqc6eHo3L'; // 桌访表 table_id
  const g = await pool.query(
    `SELECT record_id, fields FROM feishu_generic_records WHERE table_id = $1`,
    [tableId]
  );
  
  console.log(`[resync] Found ${g.rows.length} raw records to process`);
  
  let updated = 0;
  let withDish = 0;
  let withReason = 0;
  
  for (const row of g.rows) {
    const fields = row.fields && typeof row.fields === 'object' ? row.fields : {};
    const recordId = String(row.record_id || '').trim();
    if (!recordId) continue;
    
    const dish = extractDissatisfactionDishFromFields(fields);
    const reason = extractDissatisfactionReasonFromFields(fields);
    
    if (dish) withDish++;
    if (reason) withReason++;
    
    try {
      const r = await pool.query(
        `UPDATE table_visit_records
         SET dissatisfaction_dish = $1,
             unsatisfied_items = $2,
             updated_at = NOW()
         WHERE feishu_record_id = $3`,
        [dish, reason, recordId]
      );
      if (r.rowCount > 0) updated++;
    } catch (e) {
      // skip
    }
  }
  
  console.log(`[resync] Done. Updated: ${updated}, with dish: ${withDish}, with reason: ${withReason}`);
  
  // Verify
  const verify = await pool.query(
    `SELECT count(*) as total,
            count(CASE WHEN coalesce(dissatisfaction_dish,'') != '' THEN 1 END) as with_dish,
            count(CASE WHEN coalesce(unsatisfied_items,'') != '' THEN 1 END) as with_reason
     FROM table_visit_records`
  );
  console.log('[resync] Verification:', verify.rows[0]);
  
  await pool.end();
  process.exit(0);
})().catch(e => {
  console.error('[resync] Fatal:', e.message);
  process.exit(1);
});
