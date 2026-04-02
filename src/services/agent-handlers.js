/**
 * Agent Handlers - 9 sub-agents + dispatcher
 * V2 aligned with V1 data sources & reply templates (2026-03-08)
 */
import { callLLM } from './llm-provider.js';
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { executeMetrics, extractTimeRangeFromText, parseTimeRange, getAllMetricDefs, quickQuery, getTimeLabelChinese } from './data-executor.js';
import { saveMemory, recallMemories, getOutcomeStats } from './agent-memory.js';
import { generateProcurementAdvice } from './procurement-agent.js';
import { getBrandForStore } from './config-service.js';
import { toFeishuStoreName } from '../config/store-mapping.js';

const NOW_CN = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const FACTUAL_BLOCKED = '抱歉，我当前无法从数据库中获取相关凭证/数据，请您登录系统手动核查。';

// ── Bitable fields 解析（feishu_generic_records.fields 为 jsonb，值可能为 string/number/array） ──
function extractBitableFieldText(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number') return String(val);
  if (Array.isArray(val)) {
    const parts = [];
    for (const item of val) {
      if (typeof item === 'string') { parts.push(item.trim()); continue; }
      if (item && typeof item === 'object') {
        if (item.text != null) parts.push(String(item.text).trim());
        else if (Array.isArray(item.text_arr)) parts.push(...item.text_arr.map(t => String(t || '').trim()).filter(Boolean));
        else if (item.date) parts.push(String(item.date).trim());
      }
    }
    return parts.filter(Boolean).join(' ');
  }
  if (typeof val === 'object' && val !== null && (val.text != null || val.date != null)) return String(val.text || val.date || '').trim();
  return '';
}

function extractBitableFieldTextFromFields(fields, key) {
  if (!fields || typeof fields !== 'object') return '';
  const raw = fields[key] ?? fields[key.replace(/[^\u4e00-\u9fa5a-zA-Z0-9_]/g, '')];
  return extractBitableFieldText(raw);
}

/** 从 Bitable 记录中取门店名（兼容多种字段名） */
function getStoreFromBitableFields(fields) {
  const keys = ['门店', '所属门店', '门店名称', '店名', '店铺'];
  for (const k of keys) {
    const v = extractBitableFieldTextFromFields(fields, k);
    if (v) return v;
  }
  return '';
}

/** 从 Bitable 字段解析出 YYYY-MM-DD，支持时间戳(ms/s)、日期字符串、{date: "YYYY-MM-DD"} */
function normalizeBitableDateFromFields(fields, dateKey = '日期') {
  const raw = fields && (fields[dateKey] ?? fields['提交时间'] ?? fields['记录日期']);
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw > 1e12 ? raw : raw * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  if (Array.isArray(raw) && raw[0]?.date) return String(raw[0].date).slice(0, 10);
  if (typeof raw === 'object' && raw?.date) return String(raw.date).slice(0, 10);
  return null;
}

/** 门店模糊匹配（与 V1 isLikelySameStore 一致） */
function isLikelySameStore(a, b) {
  const n = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
  const x = n(a), y = n(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  return false;
}

// 与 V1/HRMS 一致：用 table_id 兼容 config_key，确保无论谁写入都能查到
const OPENING_TABLE_ID = process.env.BITABLE_OPENING_TABLE_ID || 'tbl32E6d0CyvLvfi';
const CLOSING_TABLE_ID = process.env.BITABLE_CLOSING_TABLE_ID || 'tblXYfSBRrgNGohN';

/** 开档提交情况：按日统计缺失岗位。先按 table_id 拉全量再在内存按门店+日期过滤，确保有数据能查到。 */
async function getOpeningSubmissionReport(store, start, end) {
  if (!store) return null;
  try {
    const storeNorm = String(store).trim().toLowerCase().replace(/\s+/g, '').replace(/店$/, '');
    const storeKeywords = storeNorm.length >= 2 ? [storeNorm, storeNorm.slice(0, 4), '马己仙', '音乐广场', '大宁'].filter(Boolean) : [storeNorm];
    const rows = await query(
      `SELECT config_key, fields FROM feishu_generic_records
       WHERE (config_key = 'opening_reports' OR table_id = $1)
         AND created_at >= NOW() - INTERVAL '90 days'
       ORDER BY created_at DESC LIMIT 500`,
      [OPENING_TABLE_ID]
    );
    if (!rows.rows?.length) return null;
    const list = [];
    const stationToNames = new Map();
    for (const row of rows.rows) {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const rowStore = getStoreFromBitableFields(f).trim().toLowerCase().replace(/\s+/g, '');
      const storeMatch = !storeNorm || !rowStore || storeKeywords.some(kw => rowStore.includes(kw) || (storeNorm && rowStore.includes(storeNorm)));
      if (!storeMatch) continue;
      let d = normalizeBitableDateFromFields(f, '日期') ||
               normalizeBitableDateFromFields(f, '记录日期') ||
               normalizeBitableDateFromFields(f, '提交时间');
      if (!d) d = normalizeBitableDateFromFields(f);
      if (!d || d < start || d > end) continue;
      const station = extractBitableFieldTextFromFields(f, '档口') || extractBitableFieldTextFromFields(f, '岗位') || '';
      if (!station) continue;
      const responsible = extractBitableFieldTextFromFields(f, '本档口值班负责人');
      if (!stationToNames.has(station)) stationToNames.set(station, new Set());
      responsible.split(/[,，、\/]/).forEach(n => { const s = n.trim(); if (s) stationToNames.get(station).add(s); });
      list.push({ date: d, station });
    }
    const knownStations = [...new Set(list.map(x => x.station))].sort();
    if (knownStations.length === 0) return null;
    const byDate = new Map();
    for (const { date, station } of list) {
      if (!byDate.has(date)) byDate.set(date, new Set());
      byDate.get(date).add(station);
    }
    const allDates = [...new Set(list.map(x => x.date))].sort();
    const daily = allDates.map(date => {
      const submitted = byDate.get(date) || new Set();
      const missing = knownStations.filter(s => !submitted.has(s));
      const namesStr = (st) => {
        const names = [...(stationToNames.get(st) || [])];
        return names.map(n => typeof n === 'string' ? n : '').filter(Boolean).join('/') || '';
      };
      return {
        date,
        allSubmitted: missing.length === 0,
        missingList: missing.map(st => ({ station: st, names: namesStr(st) }))
      };
    });
    const totalMissing = daily.reduce((sum, d) => sum + d.missingList.length, 0);
    return { knownStations, daily, totalMissing, periodLabel: `${start}～${end}` };
  } catch (e) {
    logger.warn({ err: e?.message, store }, 'getOpeningSubmissionReport failed');
    return null;
  }
}

/** 收档情况：指定日期的各档口收档记录。按 table_id 拉取再按门店+日期过滤。 */
async function getClosingReportForDay(store, dateStr) {
  if (!store || !dateStr) return null;
  try {
    const storeNorm = String(store).trim().toLowerCase().replace(/\s+/g, '').replace(/店$/, '');
    const storeKeywords = storeNorm.length >= 2 ? [storeNorm, storeNorm.slice(0, 4), '马己仙', '音乐广场', '大宁'].filter(Boolean) : [storeNorm];
    const rows = await query(
      `SELECT fields FROM feishu_generic_records
       WHERE (config_key = 'closing_reports' OR table_id = $1)
         AND created_at >= NOW() - INTERVAL '90 days'
       ORDER BY created_at DESC LIMIT 300`,
      [CLOSING_TABLE_ID]
    );
    if (!rows.rows?.length) return { date: dateStr, items: [], emptyReason: '该日无收档记录' };
    const items = [];
    for (const row of rows.rows) {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const rowStore = getStoreFromBitableFields(f).trim().toLowerCase().replace(/\s+/g, '');
      const storeMatch = !storeNorm || !rowStore || storeKeywords.some(kw => rowStore.includes(kw) || (storeNorm && rowStore.includes(storeNorm)));
      if (!storeMatch) continue;
      const d = normalizeBitableDateFromFields(f);
      if (!d || d !== dateStr) continue;
      const station = extractBitableFieldTextFromFields(f, '档口') || extractBitableFieldTextFromFields(f, '岗位') || '';
      const score = extractBitableFieldTextFromFields(f, '得分') || extractBitableFieldTextFromFields(f, '档口收档平均得分') || '-';
      const responsible = extractBitableFieldTextFromFields(f, '本档口值班负责人');
      const issues = extractBitableFieldTextFromFields(f, '异常情况说明');
      if (station) items.push({ station, score, responsible, issues });
    }
    return { date: dateStr, items, emptyReason: items.length === 0 ? '该日无收档记录' : null };
  } catch (e) {
    logger.warn({ err: e?.message, store, dateStr }, 'getClosingReportForDay failed');
    return null;
  }
}

/** 收档提交情况（谁没收档）：先按 table_id 拉全量再在内存按门店+日期过滤。 */
async function getClosingSubmissionReport(store, start, end) {
  if (!store) return null;
  try {
    const storeNorm = String(store).trim().toLowerCase().replace(/\s+/g, '').replace(/店$/, '');
    const storeKeywords = storeNorm.length >= 2 ? [storeNorm, storeNorm.slice(0, 4), '马己仙', '音乐广场', '大宁'].filter(Boolean) : [storeNorm];
    const rows = await query(
      `SELECT config_key, fields FROM feishu_generic_records
       WHERE (config_key = 'closing_reports' OR table_id = $1)
         AND created_at >= NOW() - INTERVAL '90 days'
       ORDER BY created_at DESC LIMIT 500`,
      [CLOSING_TABLE_ID]
    );
    if (!rows.rows?.length) return null;
    const list = [];
    const stationToNames = new Map();
    for (const row of rows.rows) {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const rowStore = (extractBitableFieldTextFromFields(f, '门店') || extractBitableFieldTextFromFields(f, '所属门店') || '').trim().toLowerCase().replace(/\s+/g, '');
      const storeMatch = !storeNorm || storeKeywords.some(kw => rowStore.includes(kw) || (storeNorm && rowStore.includes(storeNorm)));
      if (!storeMatch) continue;
      let d = normalizeBitableDateFromFields(f, '日期') ||
               normalizeBitableDateFromFields(f, '记录日期') ||
               normalizeBitableDateFromFields(f, '提交时间');
      if (!d) d = normalizeBitableDateFromFields(f);
      if (!d || d < start || d > end) continue;
      if (!d || d < start || d > end) continue;
      const station = extractBitableFieldTextFromFields(f, '档口') || extractBitableFieldTextFromFields(f, '岗位') || '';
      if (!station) continue;
      const responsible = extractBitableFieldTextFromFields(f, '本档口值班负责人');
      if (!stationToNames.has(station)) stationToNames.set(station, new Set());
      responsible.split(/[,，、\/]/).forEach(n => { const s = n.trim(); if (s) stationToNames.get(station).add(s); });
      list.push({ date: d, station });
    }
    const knownStations = [...new Set(list.map(x => x.station))].sort();
    if (knownStations.length === 0) return null;
    const byDate = new Map();
    for (const { date, station } of list) {
      if (!byDate.has(date)) byDate.set(date, new Set());
      byDate.get(date).add(station);
    }
    const allDates = [...new Set(list.map(x => x.date))].sort();
    const daily = allDates.map(date => {
      const submitted = byDate.get(date) || new Set();
      const missing = knownStations.filter(s => !submitted.has(s));
      const namesStr = (st) => {
        const names = [...(stationToNames.get(st) || [])];
        return names.map(n => typeof n === 'string' ? n : '').filter(Boolean).join('/') || '';
      };
      return {
        date,
        allSubmitted: missing.length === 0,
        missingList: missing.map(st => ({ station: st, names: namesStr(st) }))
      };
    });
    const totalMissing = daily.reduce((sum, d) => sum + d.missingList.length, 0);
    return { knownStations, daily, totalMissing, periodLabel: `${start}～${end}` };
  } catch (e) {
    logger.warn({ err: e?.message, store }, 'getClosingSubmissionReport failed');
    return null;
  }
}

function matchMetrics(text, defs) {
  const t = String(text || '').toLowerCase();
  return defs.filter(d => String(d.name || '').toLowerCase().split('').some(c => t.includes(c))).slice(0, 8);
}

function detectFactDemand(text) {
  const hard = /多少|几个|数据|金额|营收|毛利|人数|占比|达成率|对比|排名|总共|合计/.test(text);
  return hard ? 'hard' : 'soft';
}

const TABLE_VISIT_TABLE_ID = process.env.BITABLE_TABLE_VISIT_TABLE_ID || 'tblpx5Efqc6eHo3L';

/** 诊断：返回 feishu_generic_records 表中有哪些 config_key/table_id 及记录数 */
export async function diagnoseFeishuRecords() {
  try {
    const r = await query(`
      SELECT config_key, table_id, COUNT(*) as cnt
      FROM feishu_generic_records
      WHERE created_at >= NOW() - INTERVAL '90 days'
      GROUP BY config_key, table_id
      ORDER BY cnt DESC
      LIMIT 20
    `);
    return r.rows || [];
  } catch (e) {
    return [];
  }
}

/** 桌访反馈：按图版本格式，100% 基于数据库。格式：数据来源+共N条+桌访桌数+简要分析+不满意TOP列表 */
async function buildDeterministicTableVisitReply(store, start, end) {
  if (!store) return '';
  const storeNorm = String(store).trim().toLowerCase().replace(/\s+/g, '');
  // 诊断：先返回表里有什么数据
  const diag = await diagnoseFeishuRecords();
  logger.info({ tableVisitDiag: diag }, 'table_visit diagnose');
  try {
    const tv = await query(
      `SELECT fields FROM feishu_generic_records
       WHERE (config_key = 'table_visit' OR table_id = $1)
         AND created_at >= NOW() - INTERVAL '90 days'
       ORDER BY created_at DESC LIMIT 500`,
      [TABLE_VISIT_TABLE_ID]
    );
    const rawRows = tv.rows || [];
    const rows = [];
    for (const r of rawRows) {
      const f = r.fields && typeof r.fields === 'object' ? r.fields : {};
      const rowStore = getStoreFromBitableFields(f).trim().toLowerCase().replace(/\s+/g, '');
      if (storeNorm && rowStore && !rowStore.includes(storeNorm) && !storeNorm.includes(rowStore)) {
        const kw = ['马己仙', '音乐广场', '大宁', storeNorm.slice(0, 4)].filter(Boolean);
        if (!kw.some(k => rowStore.includes(k))) continue;
      }
      let d = normalizeBitableDateFromFields(f, '日期') || normalizeBitableDateFromFields(f, '记录日期') || normalizeBitableDateFromFields(f, '提交时间') || normalizeBitableDateFromFields(f);
      if (!d || d < start || d > end) continue;
      const productIssue = extractBitableFieldTextFromFields(f, '产品不满意项') || extractBitableFieldTextFromFields(f, '产品不满意') || extractBitableFieldTextFromFields(f, '产品问题') || '';
      const serviceIssue = extractBitableFieldTextFromFields(f, '服务不满意项') || extractBitableFieldTextFromFields(f, '服务不满意') || extractBitableFieldTextFromFields(f, '服务问题') || '';
      const satisfaction = extractBitableFieldTextFromFields(f, '今天用餐是否满意') || extractBitableFieldTextFromFields(f, '满意度') || '';
      rows.push({ productIssue, serviceIssue, satisfaction });
    }
    if (!rows.length) return '';
    const dateLabel = start === end ? (() => {
      const [y, m, d] = start.split('-');
      return `${y}年${m}月${d}日`;
    })() : `${start}～${end}`;
    const periodWord = start === end ? '昨日' : '所选时段';
    const lines = [];
    lines.push(`【数据来源:桌访巡台记录,非大众点评】`);
    lines.push(`共${rows.length}条桌访记录。`);
    lines.push('');
    lines.push(`根据${periodWord}(${dateLabel})数据，${store}的桌访情况如下：`);
    lines.push(`- **桌访桌数**: ${rows.length}`);
    lines.push(`**简要分析**: ${periodWord}共收集了${rows.length}桌的桌访反馈。`);
    const productCount = new Map();
    const serviceCount = new Map();
    rows.forEach(r => {
      String(r.productIssue || '').split(/[,，、;；/]/).forEach(p => { const t = p.trim(); if (t) productCount.set(t, (productCount.get(t) || 0) + 1); });
      String(r.serviceIssue || '').split(/[,，、;；/]/).forEach(p => { const t = p.trim(); if (t) serviceCount.set(t, (serviceCount.get(t) || 0) + 1); });
    });
    const allIssues = [...productCount.entries(), ...serviceCount.entries()];
    const merged = new Map();
    allIssues.forEach(([k, v]) => merged.set(k, (merged.get(k) || 0) + v));
    const topList = [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    lines.push('');
    lines.push(`🔔 桌访不满意反馈 TOP:`);
    if (topList.length > 0) {
      topList.forEach(([text, count], i) => {
        lines.push(`${i + 1}. ${text} (${count}次)`);
      });
    } else {
      lines.push('暂无具体不满意项记录。');
    }
    return lines.join('\n');
  } catch (e) {
    logger.warn({ err: e?.message, store }, 'buildDeterministicTableVisitReply failed');
    return '';
  }
}

const BAD_REVIEW_TABLE_ID = process.env.BITABLE_BAD_REVIEW_TABLE_ID || 'tblgReexNjWJOJB6';

/** 差评报告：100% 从 DB 取数，确定性格式；同时支持 config_key 与 table_id 以兼容 HRMS/V2 同步 */
async function buildDeterministicBadReviewReply(store, start, end) {
  try {
    const storePattern = store ? `%${store}%` : '%';
    const storeCond = `AND (fields->>'所属门店' ILIKE $3 OR fields->>'门店' ILIKE $3)`;
    const r = await query(
      `SELECT fields, created_at FROM feishu_generic_records
       WHERE (config_key = 'bad_review' OR config_key LIKE '%差评%' OR table_id = $4)
         AND created_at::date BETWEEN $1::date AND ($2::date + INTERVAL '1 day') ${storeCond}
       ORDER BY created_at DESC LIMIT 30`,
      [start, end, storePattern, BAD_REVIEW_TABLE_ID]
    );
    const rows = r.rows || [];
    if (!rows.length) return store ? `当前门店「${store}」在${start}～${end}内暂无差评报告数据。` : `在${start}～${end}内暂无差评报告数据。`;
    const dateStr = start === end ? start : `${start}～${end}`;
    const lines = [`【数据来源:差评报告】共${rows.length}条。`, '', `根据${dateStr}数据：`];
    rows.slice(0, 15).forEach((row, i) => {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const platform = extractBitableFieldTextFromFields(f, '平台') || '';
      const cat = extractBitableFieldTextFromFields(f, '差评分类') || extractBitableFieldTextFromFields(f, '评分') || '';
      const content = extractBitableFieldTextFromFields(f, '评价内容') || extractBitableFieldTextFromFields(f, '差评内容') || '';
      const d = (row.created_at && String(row.created_at).slice(0, 10)) || '';
      lines.push(`${i + 1}. ${d} ${platform} ${cat}: ${(content || '-').slice(0, 80)}`);
    });
    return lines.join('\n');
  } catch (e) {
    logger.warn({ err: e?.message }, 'buildDeterministicBadReviewReply failed');
    return '';
  }
}

/** 例会报告：100% 从 DB 取数，确定性格式 */
async function buildDeterministicMeetingReply(store, start, end) {
  if (!store) return '';
  try {
    const r = await query(
      `SELECT fields, created_at FROM feishu_generic_records
       WHERE config_key = 'meeting_reports'
         AND (fields->>'门店' ILIKE $3 OR fields->>'所属门店' ILIKE $3)
         AND created_at::date BETWEEN $1::date AND ($2::date + INTERVAL '1 day')
       ORDER BY created_at DESC LIMIT 20`,
      [start, end, `%${store}%`]
    );
    const rows = r.rows || [];
    if (!rows.length) return `当前门店「${store}」在${start}～${end}内暂无例会报告数据。`;
    const lines = [`【数据来源:例会报告】共${rows.length}条。`, ''];
    rows.forEach((row, i) => {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const d = normalizeBitableDateFromFields(f) || String(row.created_at || '').slice(0, 10);
      const mtype = extractBitableFieldTextFromFields(f, '会议类型') || '例会';
      const attendees = extractBitableFieldTextFromFields(f, '参会人数') || '-';
      const content = extractBitableFieldTextFromFields(f, '会议内容') || '';
      lines.push(`${i + 1}. ${d} ${mtype} 参会:${attendees}人 ${content.slice(0, 60)}`);
    });
    return lines.join('\n');
  } catch (e) {
    logger.warn({ err: e?.message }, 'buildDeterministicMeetingReply failed');
    return '';
  }
}

/** 原料收货报告：100% 从 DB 取数，确定性格式 */
async function buildDeterministicMaterialReply(store, start, end) {
  if (!store) return '';
  try {
    const r = await query(
      `SELECT fields, created_at FROM feishu_generic_records
       WHERE config_key LIKE 'material_%'
         AND (fields->>'门店' ILIKE $3 OR fields->>'所属门店' ILIKE $3)
         AND created_at::date BETWEEN $1::date AND ($2::date + INTERVAL '1 day')
       ORDER BY created_at DESC LIMIT 25`,
      [start, end, `%${store}%`]
    );
    const rows = r.rows || [];
    if (!rows.length) return `当前门店「${store}」在${start}～${end}内暂无原料收货报告数据。`;
    const lines = [`【数据来源:原料收货日报】共${rows.length}条。`, ''];
    rows.slice(0, 15).forEach((row, i) => {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const d = extractBitableFieldTextFromFields(f, '收货日期') || String(row.created_at || '').slice(0, 10);
      const item = extractBitableFieldTextFromFields(f, '品名') || extractBitableFieldTextFromFields(f, '原料名称') || '';
      const qty = extractBitableFieldTextFromFields(f, '数量') || '';
      const amt = extractBitableFieldTextFromFields(f, '金额') || '';
      const supplier = extractBitableFieldTextFromFields(f, '供应商') || '';
      lines.push(`${i + 1}. ${d} ${item} ${qty}${amt ? ' ¥' + amt : ''} ${supplier}`);
    });
    return lines.join('\n');
  } catch (e) {
    logger.warn({ err: e?.message }, 'buildDeterministicMaterialReply failed');
    return '';
  }
}

/** 日期范围 → 中文具体日期（用于回复中展示），如 2026年3月4日～3月10日 */
function formatDateRangeForDisplay(start, end) {
  if (!start || !end) return '';
  const fmt = (s) => {
    const [y, m, d] = s.split('-');
    return `${y}年${m}月${d}日`;
  };
  return `${fmt(start)}～${fmt(end)}`;
}

/** 诊断：返回 daily_reports 表中有哪些门店及最新日期 */
export async function diagnoseDailyReports() {
  try {
    const r = await query(`
      SELECT store, MAX(date) as last_date, COUNT(*) as cnt
      FROM daily_reports
      WHERE date >= NOW() - INTERVAL '30 days'
      GROUP BY store
      ORDER BY cnt DESC
      LIMIT 20
    `);
    return r.rows || [];
  } catch (e) {
    return [];
  }
}

/** 营收分析：100% 从 daily_reports 取数，不经过 LLM，不含 sales_raw */
async function buildDeterministicRevenueReply(store, start, end, periodLabel) {
  if (!store) return '';
  const storeLike = `%${String(store).trim().toLowerCase().replace(/\s+/g, '')}%`;

  // 诊断：先看看 daily_reports 有什么数据
  const diag = await diagnoseDailyReports();
  logger.info({ dailyReportsDiag: diag, storeLike }, 'daily_reports diagnose');

  let rows = [];
  let querySuccess = false;
  try {
    const r = await query(
      `SELECT date, actual_revenue,
              COALESCE(pre_discount_revenue, actual_revenue) as pre_discount_revenue,
              COALESCE(total_discount, 0) as total_discount, COALESCE(budget, 0) as budget,
              COALESCE(budget_rate, 0) as budget_rate,
              actual_margin, dianping_rating, efficiency, labor_total,
              COALESCE(dine_orders, 0) as dine_orders, COALESCE(dine_traffic, 0) as dine_traffic
       FROM daily_reports
       WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) LIKE $1 AND date >= $2 AND date <= $3
       ORDER BY date DESC LIMIT 60`,
      [storeLike, start, end]
    );
    rows = r.rows || [];
    querySuccess = true;
    logger.info({ rowCount: rows.length, sampleRow: rows[0] }, 'daily_reports query success');
  } catch (e) {
    logger.warn({ err: e?.message, storeLike }, 'daily_reports first query failed, trying fallback');
    try {
      const r2 = await query(
        `SELECT date, actual_revenue, actual_margin, dianping_rating, target_revenue,
                dine_orders, target_revenue as budget
         FROM daily_reports
         WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) LIKE $1 AND date >= $2 AND date <= $3
         ORDER BY date DESC LIMIT 60`,
        [storeLike, start, end]
      );
      rows = (r2.rows || []).map(row => ({
        ...row,
        pre_discount_revenue: row.actual_revenue,
        total_discount: 0,
        budget: row.target_revenue || 0,
        budget_rate: null,
        efficiency: null,
        labor_total: null,
        dine_orders: row.dine_orders != null ? row.dine_orders : 0,
        dine_traffic: 0
      }));
    } catch (e2) {
      logger.warn({ err: e2?.message }, 'buildDeterministicRevenueReply fallback failed');
      return '';
    }
  }
  try {
    if (!rows.length) return '';
    const totalRevenue = rows.reduce((s, r) => s + (parseFloat(r.actual_revenue) || 0), 0);
    let totalPre = rows.reduce((s, r) => s + (parseFloat(r.pre_discount_revenue) || 0), 0);
    if (totalPre < totalRevenue) totalPre = totalRevenue;
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const totalDaysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    let monthBudget = 0;
    try {
      const rt = await query(
        `SELECT target_revenue FROM revenue_targets WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) LIKE $1 AND period = $2 LIMIT 1`,
        [storeLike, monthStart.slice(0, 7)]
      );
      if (rt.rows?.[0]?.target_revenue) monthBudget = parseFloat(rt.rows[0].target_revenue) || 0;
    } catch (_) {}
    let mR;
    try {
      mR = await query(
        `SELECT COALESCE(SUM(actual_revenue),0) as cum_rev, COALESCE(SUM(pre_discount_revenue),0) as cum_pre,
                COALESCE(SUM(budget),0) as b, COUNT(*) as days, COALESCE(SUM(labor_total),0) as cum_labor
         FROM daily_reports WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) LIKE $1 AND date >= $2 AND date <= $3`,
        [storeLike, monthStart, end]
      );
    } catch (_) {
      mR = await query(
        `SELECT COALESCE(SUM(actual_revenue),0) as cum_rev, COUNT(*) as days FROM daily_reports
         WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) LIKE $1 AND date >= $2 AND date <= $3`,
        [storeLike, monthStart, end]
      ).catch(() => ({ rows: [{}] }));
      if (mR.rows?.[0]) { mR.rows[0].cum_pre = mR.rows[0].cum_rev; mR.rows[0].b = 0; mR.rows[0].cum_labor = 0; }
    }
    const m = mR.rows?.[0] || {};
    let cumRev = parseFloat(m.cum_rev) || 0, cumPre = parseFloat(m.cum_pre) || 0, cumLabor = parseFloat(m.cum_labor) || 0;
    if (!monthBudget && m.b) monthBudget = parseFloat(m.b) || 0;
    const monthDays = parseInt(m.days) || 0;

    const lines = [];
    const dateRangeStr = formatDateRangeForDisplay(start, end);
    if (rows.length <= 2) {
      const row = rows[0];
      const dayStr = row.date ? `${String(row.date).slice(0, 4)}年${String(row.date).slice(5, 7)}月${String(row.date).slice(8, 10)}日` : dateRangeStr;
      if (dayStr) lines.push(`根据${rows.length === 1 ? '昨日' : '当日'}(${dayStr})数据，${store}经营情况如下：`, '');
      const actualRev = parseFloat(row.actual_revenue) || 0;
      let preDiscount = parseFloat(row.pre_discount_revenue) || 0;
      let totalDiscount = parseFloat(row.total_discount) || 0;
      if (preDiscount < actualRev) preDiscount = actualRev;
      totalDiscount = preDiscount - actualRev;
      lines.push(`- **实收营业额**: ${actualRev.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (已扣优惠)`);
      if (preDiscount > 0) lines.push(`- **折前营业额**: ${preDiscount.toLocaleString('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} (含优惠前金额)`);
      if (totalDiscount > 0) lines.push(`- **总折扣金额**: ${totalDiscount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (含优惠前金额)`);
      const dineOrders = parseInt(row.dine_orders, 10) || 0;
      const dineTraffic = parseInt(row.dine_traffic, 10) || 0;
      if (dineOrders > 0) lines.push(`- **堂食桌数**: ${dineOrders}桌`);
      if (dineTraffic > 0) lines.push(`- **堂食客流**: ${dineTraffic}人次`);
      const rate = row.budget_rate != null ? (parseFloat(row.budget_rate) * 100).toFixed(1) : null;
      if (rate != null && Number(rate) > 0) lines.push(`- **达成率**: ${rate}%`);
      lines.push('√ **补充指标**');
      if (monthBudget > 0) {
        const achRate = (cumRev / monthBudget * 100).toFixed(1);
        const theoRate = (monthDays / totalDaysInMonth * 100).toFixed(1);
        lines.push(`- **实收营业目标达成率**: ${achRate}%(累计实收¥${cumRev.toLocaleString('zh-CN', { minimumFractionDigits: 0 })} / 本月目标 ¥${monthBudget.toLocaleString('zh-CN', { minimumFractionDigits: 0 })})`);
        lines.push(`- **理论达成率**: ${theoRate}% (${monthDays}/${totalDaysInMonth}天)`);
      }
      const margin = row.actual_margin != null ? parseFloat(row.actual_margin) : null;
      lines.push(margin != null && !isNaN(margin) ? `- **毛利率**: ${margin.toFixed(1)}%` : `- **毛利率**: 暂无 (当日菜品明细未录入)`);
      const dp = row.dianping_rating != null ? parseFloat(row.dianping_rating) : null;
      if (dp != null && !isNaN(dp)) lines.push(`- **今日大众点评评分**: ${dp.toFixed(2)}`);
      const eff = row.efficiency != null ? parseFloat(row.efficiency) : null;
      const labor = row.labor_total != null ? parseFloat(row.labor_total) : null;
      if (eff != null && !isNaN(eff)) lines.push(`- **今日人效值**: ¥${Math.round(eff).toLocaleString('zh-CN')}${labor != null && !isNaN(labor) ? ` (出勤${labor.toFixed(0)}工时)` : ''}`);
      if (cumLabor > 0 && cumPre > 0) lines.push(`- **本月累计人效值**: ¥${Math.round(cumPre / cumLabor).toLocaleString('zh-CN')} (折前 ¥${Math.round(cumPre).toLocaleString('zh-CN')} / 出勤 ${cumLabor.toFixed(1)}人)`);
    } else {
      const totalDisc = totalPre - totalRevenue;
      const dateRangeStr = formatDateRangeForDisplay(start, end);
      if (dateRangeStr) lines.unshift(`根据最近7天(${dateRangeStr})数据，${store}经营情况如下：`, '');
      lines.push(`- **实收营业额**: ${totalRevenue.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} (${rows.length}天合计)`);
      if (totalPre > 0) lines.push(`- **折前营业额**: ${totalPre.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} (含优惠前金额)`);
      if (totalDisc > 0) lines.push(`- **总折扣金额**: ${totalDisc.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} (含优惠前金额)`);
      const totalDineOrders = rows.reduce((s, r) => s + (parseInt(r.dine_orders, 10) || 0), 0);
      const totalDineTraffic = rows.reduce((s, r) => s + (parseInt(r.dine_traffic, 10) || 0), 0);
      if (totalDineOrders > 0) lines.push(`- **堂食桌数**: ${totalDineOrders}桌 (${rows.length}天合计)`);
      if (totalDineTraffic > 0) lines.push(`- **堂食客流**: ${totalDineTraffic}人次`);
      const avgRate = rows.filter(r => r.budget_rate != null).length ? (rows.reduce((s, r) => s + (parseFloat(r.budget_rate) || 0), 0) / rows.length * 100).toFixed(1) : null;
      if (avgRate != null && Number(avgRate) > 0) lines.push(`- **达成率**: ${avgRate}%`);
      lines.push(`- **日均实收**: ¥${Math.round(totalRevenue / rows.length).toLocaleString('zh-CN')}`);
      if (monthBudget > 0) {
        const achRate = (cumRev / monthBudget * 100).toFixed(1);
        const theoRate = (monthDays / totalDaysInMonth * 100).toFixed(1);
        lines.push(`- **实收达成率**: ${achRate}%（累计 ¥${cumRev.toLocaleString('zh-CN', { minimumFractionDigits: 0 })} / 目标 ¥${monthBudget.toLocaleString('zh-CN', { minimumFractionDigits: 0 })}）`);
        lines.push(`- **理论达成率**: ${theoRate}%（${monthDays}/${totalDaysInMonth}天）`);
      }
      const avgMarginArr = rows.filter(r => r.actual_margin != null);
      const avgMarginVal = avgMarginArr.length ? (avgMarginArr.reduce((s, r) => s + parseFloat(r.actual_margin), 0) / avgMarginArr.length).toFixed(1) : null;
      if (avgMarginVal) lines.push(`- **平均毛利率**: ${avgMarginVal}%`);
      const dianpingRows = rows.filter(r => r.dianping_rating != null);
      const avgDianping = dianpingRows.length ? (dianpingRows.reduce((s, r) => s + parseFloat(r.dianping_rating), 0) / dianpingRows.length).toFixed(2) : null;
      if (avgDianping) lines.push(`- **大众点评均分**: ${avgDianping}`);
    }
    return lines.join('\n');
  } catch (e) {
    logger.error({ err: e?.message, stack: e?.stack, store }, 'buildDeterministicRevenueReply failed - DETAILED');
    return '';
  }
}

// ── 1. Data Auditor (对标V1: BI工具+营收汇总+销售排行+差评排行) ──
async function handleDataAuditor(text, ctx) {
  const store = ctx.store || '';
  const brand = store ? await getBrandForStore(store).catch(() => null) : null;
  const tr = extractTimeRangeFromText(text);
  const { start, end, label } = parseTimeRange(tr);
  const timeLabel = getTimeLabelChinese(tr);
  const isBusinessOverview = /生意|营业|经营|经营情况|怎么样|如何/.test(text) && !/桌访|桌数|开档|收档|差评|原料|例会|报损/.test(text);
  // 问「生意/经营怎么样」时直接返回 V1 风格确定性营收分析，不经过 LLM
  if (store && isBusinessOverview) {
    const revenueBody = await buildDeterministicRevenueReply(store, start, end, label);
    if (revenueBody) {
      saveMemory('data_auditor', store, revenueBody.slice(0, 500), { query: text.slice(0, 200) }).catch(() => {});
      const revTimeLabel = (tr && /~/.test(tr)) ? `最近7天(${formatDateRangeForDisplay(start, end)})` : timeLabel;
      return { agent: 'data_auditor', response: revenueBody, store, data: revenueBody, timeRange: tr, timeLabel: revTimeLabel, reportTitle: '营收分析', dataBacked: true };
    }
  }

  // 桌访情况：直接返回确定性反馈总结，不再经过 LLM
  if (store && /桌访|桌数|桌访情况/.test(text)) {
    const tableVisitBody = await buildDeterministicTableVisitReply(store, start, end);
    if (tableVisitBody) {
      saveMemory('data_auditor', store, tableVisitBody.slice(0, 500), { query: text.slice(0, 200) }).catch(() => {});
      return { agent: 'data_auditor', response: tableVisitBody, store, data: tableVisitBody, timeRange: tr, timeLabel, reportTitle: '桌访热点', dataBacked: true };
    }
  }

  // 差评报告：确定性回复，不经过 LLM
  if (/差评|投诉|点评/.test(text) && !/桌访|开档|收档|原料|例会/.test(text)) {
    const badReviewBody = await buildDeterministicBadReviewReply(store || '', start, end);
    if (badReviewBody) {
      return { agent: 'data_auditor', response: badReviewBody, store: store || '', data: badReviewBody, timeRange: tr, timeLabel, reportTitle: '差评报告', dataBacked: true };
    }
  }
  // 例会报告：确定性回复
  if (store && /例会|会议/.test(text)) {
    const meetingBody = await buildDeterministicMeetingReply(store, start, end);
    if (meetingBody) {
      return { agent: 'data_auditor', response: meetingBody, store, data: meetingBody, timeRange: tr, timeLabel, reportTitle: '例会报告', dataBacked: true };
    }
  }
  // 原料收货报告：确定性回复
  if (store && /原料|收货|进货|采购/.test(text)) {
    const materialBody = await buildDeterministicMaterialReply(store, start, end);
    if (materialBody) {
      return { agent: 'data_auditor', response: materialBody, store, data: materialBody, timeRange: tr, timeLabel, reportTitle: '原料收货报告', dataBacked: true };
    }
  }

  let ds = '';
  // 问「生意/经营怎么样」时优先拉取并前置营收汇总，避免只回桌访
  if (store) {
    try {
      const rev = await query(
        `SELECT date, actual_revenue, budget, budget_rate, actual_margin, pre_discount_revenue,
                dine_traffic, dine_orders, delivery_actual, efficiency
         FROM daily_reports WHERE store ILIKE $1 AND date BETWEEN $2 AND $3
         ORDER BY date DESC LIMIT 30`, [`%${store}%`, start, end]);
      if (rev.rows?.length) {
        const avg = rev.rows.reduce((s, r) => s + (parseFloat(r.actual_revenue) || 0), 0) / rev.rows.length;
        const avgRate = rev.rows.reduce((s, r) => s + (parseFloat(r.budget_rate) || 0), 0) / rev.rows.length;
        const avgMargin = rev.rows.reduce((s, r) => s + (parseFloat(r.actual_margin) || 0), 0) / rev.rows.length;
        ds += `\n[营收汇总](${label},${store}) ${rev.rows.length}天数据\n`;
        ds += `- 日均营收: ¥${Math.round(avg)} | 达成率: ${(avgRate * 100).toFixed(1)}% | 毛利率: ${(avgMargin * 100).toFixed(1)}%\n`;
        const r7 = rev.rows.slice(0, 7);
        ds += '- 近7天: ' + r7.map(r => `${String(r.date||'').slice(5,10)}:¥${r.actual_revenue||0}`).join(', ') + '\n';
      } else if (isBusinessOverview) ds += `\n[营收汇总](${label},${store}) 暂无该时间段的营业日报数据。\n`;
    } catch (e) { /* silent */ }
  }
  // 1) Metric execution (指标库匹配)
  const allDefs = await getAllMetricDefs();
  const matched = matchMetrics(text, allDefs);
  if (matched.length > 0) {
    const res = await executeMetrics(matched.map(m => m.metric_id), tr, store);
    const lines = Object.values(res).filter(r => r.value !== null).map(r => `- ${r.name}: ${r.value}${r.unit || ''}`);
    if (lines.length) ds += `\n[指标数据](${label}, ${store || '全部'})\n${lines.join('\n')}\n`;
  }
  // 3) 销售排行 (对标V1 execBiToolSalesRanking)
  if (store && /排行|排名|最好|最差|畅销|滞销|TOP|倒数/.test(text)) {
    try {
      const sortOrder = /最差|倒数|滞销|垫底/.test(text) ? 'ASC' : 'DESC';
      const sr = await query(
        `SELECT dish_name, ROUND(SUM(COALESCE(qty,0))::numeric,0) AS total_qty,
                ROUND(SUM(COALESCE(sales_amount,0))::numeric,0) AS total_sales
         FROM sales_raw WHERE store ILIKE $1 AND date BETWEEN $2 AND $3
           AND COALESCE(dish_name,'') <> ''
         GROUP BY dish_name HAVING SUM(COALESCE(qty,0)) > 0
         ORDER BY SUM(COALESCE(sales_amount,0)) ${sortOrder} LIMIT 10`,
        [`%${store}%`, start, end]);
      if (sr.rows?.length) {
        const title = sortOrder === 'ASC' ? '销售倒数TOP10' : '销售TOP10';
        ds += `\n[${title}](${store},${label})\n`;
        sr.rows.forEach((x, i) => { ds += `${i+1}. ${x.dish_name} | ¥${x.total_sales} | ${x.total_qty}份\n`; });
      }
    } catch (e) { /* sales_raw may not exist */ }
  }
  // 4) 差评报告 (对标V1: feishu_generic_records + anomaly_triggers)
  if (/差评|投诉|complaint|点评/.test(text)) {
    try {
      const br = await query(
        `SELECT fields->>'平台' as platform, fields->>'评分' as rating, fields->>'差评分类' as cat,
                fields->>'评价内容' as content, created_at
         FROM feishu_generic_records WHERE config_key='bad_review'
         ${store ? `AND (fields->>'所属门店' ILIKE $3 OR fields->>'门店' ILIKE $3)` : ''}
         AND created_at BETWEEN $1::date AND ($2::date + 1) ORDER BY created_at DESC LIMIT 15`,
        store ? [start, end, `%${store}%`] : [start, end]);
      if (br.rows?.length) {
        ds += `\n[差评报告](${store||'全部'},${label}) ${br.rows.length}条\n`;
        br.rows.slice(0, 8).forEach(r => { ds += `- ${String(r.created_at||'').slice(0,10)} ${r.platform||''} ${r.cat||''}: ${(r.content||'').slice(0,60)}\n`; });
      }
    } catch (e) { /* silent */ }
    try {
      const at = await query(
        `SELECT category, severity, description, trigger_date FROM anomaly_triggers
         WHERE ${store ? 'store ILIKE $3 AND' : ''} category IN ('product_review','service_review','bad_review_product','bad_review_service')
         AND trigger_date BETWEEN $1 AND $2 ORDER BY trigger_date DESC LIMIT 10`,
        store ? [start, end, `%${store}%`] : [start, end]);
      if (at.rows?.length) {
        ds += `\n[差评异常触发] ${at.rows.length}条\n`;
        at.rows.slice(0, 5).forEach(r => { ds += `- ${String(r.trigger_date||'').slice(0,10)} ${r.category}(${r.severity}): ${(r.description||'').slice(0,60)}\n`; });
      }
    } catch (e) { /* silent */ }
  }
  // 5) 收档报告 (feishu_generic_records)
  if (/收档|收市|闭店|closing/.test(text)) {
    try {
      const cr = await query(
        `SELECT fields->>'门店' as s, fields->>'日期' as d, fields->>'档口' as station,
                fields->>'得分' as score, fields->>'异常情况说明' as issues
         FROM feishu_generic_records WHERE config_key='closing_reports'
         ${store ? `AND (fields->>'门店' ILIKE $3 OR fields->>'所属门店' ILIKE $3)` : ''}
         AND created_at BETWEEN $1::date AND ($2::date + 1) ORDER BY created_at DESC LIMIT 15`,
        store ? [start, end, `%${store}%`] : [start, end]);
      if (cr.rows?.length) {
        ds += `\n[收档报告](${store||'全部'},${label}) ${cr.rows.length}条\n`;
        cr.rows.slice(0, 8).forEach(r => { ds += `- ${r.d||''} ${r.station||''} 得分:${r.score||'-'} ${r.issues ? '异常:'+r.issues.slice(0,40) : ''}\n`; });
      }
    } catch (e) { /* silent */ }
  }
  // 6) 开档报告 (feishu_generic_records)
  if (/开档|开市|开店|opening/.test(text)) {
    try {
      const or2 = await query(
        `SELECT fields->>'门店' as s, fields->>'日期' as d, fields->>'档口' as station,
                fields->>'得分' as score, fields->>'异常情况说明' as issues
         FROM feishu_generic_records WHERE config_key='opening_reports'
         ${store ? `AND (fields->>'门店' ILIKE $3 OR fields->>'所属门店' ILIKE $3)` : ''}
         AND created_at BETWEEN $1::date AND ($2::date + 1) ORDER BY created_at DESC LIMIT 15`,
        store ? [start, end, `%${store}%`] : [start, end]);
      if (or2.rows?.length) {
        ds += `\n[开档报告](${store||'全部'},${label}) ${or2.rows.length}条\n`;
        or2.rows.slice(0, 8).forEach(r => { ds += `- ${r.d||''} ${r.station||''} 得分:${r.score||'-'} ${r.issues ? '异常:'+r.issues.slice(0,40) : ''}\n`; });
      }
    } catch (e) { /* silent */ }
  }
  // 7) 例会报告 (feishu_generic_records)
  if (/例会|会议|meeting/.test(text)) {
    try {
      const mr = await query(
        `SELECT fields->>'门店' as s, fields->>'日期' as d, fields->>'会议类型' as mtype,
                fields->>'参会人数' as attendees, fields->>'会议内容' as content
         FROM feishu_generic_records WHERE config_key='meeting_reports'
         ${store ? `AND (fields->>'门店' ILIKE $3 OR fields->>'所属门店' ILIKE $3)` : ''}
         AND created_at BETWEEN $1::date AND ($2::date + 1) ORDER BY created_at DESC LIMIT 10`,
        store ? [start, end, `%${store}%`] : [start, end]);
      if (mr.rows?.length) {
        ds += `\n[例会报告](${store||'全部'},${label}) ${mr.rows.length}条\n`;
        mr.rows.slice(0, 6).forEach(r => { ds += `- ${r.d||''} ${r.mtype||'例会'} 参会:${r.attendees||'-'}人 ${(r.content||'').slice(0,50)}\n`; });
      }
    } catch (e) { /* silent */ }
  }
  // 8) 原料收货日报 (feishu_generic_records)
  if (/原料|收货|进货|material|采购/.test(text)) {
    try {
      const mat = await query(
        `SELECT fields->>'门店' as s, fields->>'收货日期' as d, fields->>'供应商' as supplier,
                fields->>'品名' as item, fields->>'数量' as qty, fields->>'金额' as amt,
                fields->>'异常说明' as issues
         FROM feishu_generic_records WHERE config_key LIKE 'material_%'
         ${store ? `AND (fields->>'门店' ILIKE $3 OR fields->>'所属门店' ILIKE $3)` : ''}
         AND created_at BETWEEN $1::date AND ($2::date + 1) ORDER BY created_at DESC LIMIT 15`,
        store ? [start, end, `%${store}%`] : [start, end]);
      if (mat.rows?.length) {
        ds += `\n[原料收货](${store||'全部'},${label}) ${mat.rows.length}条\n`;
        mat.rows.slice(0, 8).forEach(r => { ds += `- ${r.d||''} ${r.item||''} ${r.qty||''}${r.amt ? ' ¥'+r.amt : ''} ${r.supplier||''} ${r.issues ? '异常:'+r.issues.slice(0,30) : ''}\n`; });
      }
    } catch (e) { /* silent */ }
  }
  // 9) 报损单 (feishu_generic_records)
  if (/报损|损耗|loss|废弃/.test(text)) {
    try {
      const loss = await query(
        `SELECT fields->>'门店' as s, fields->>'创建日期' as d, fields->>'品名' as item,
                fields->>'数量' as qty, fields->>'金额' as amt, fields->>'原因' as reason
         FROM feishu_generic_records WHERE config_key='loss_report'
         ${store ? `AND (fields->>'门店' ILIKE $3 OR fields->>'所属门店' ILIKE $3)` : ''}
         AND created_at BETWEEN $1::date AND ($2::date + 1) ORDER BY created_at DESC LIMIT 15`,
        store ? [start, end, `%${store}%`] : [start, end]);
      if (loss.rows?.length) {
        ds += `\n[报损记录](${store||'全部'},${label}) ${loss.rows.length}条\n`;
        loss.rows.slice(0, 8).forEach(r => { ds += `- ${r.d||''} ${r.item||''} ${r.qty||''}${r.amt ? ' ¥'+r.amt : ''} ${r.reason||''}\n`; });
      }
    } catch (e) { /* silent */ }
  }
  if (!ds) ds = '\n[no data found]\n';
  // P2: 记忆回调
  try { const mem = await recallMemories('data_auditor', store, '', 3); if (mem.length) ds += '\n[历史分析]\n' + mem.map(m => m.content.slice(0,80)).join('\n'); } catch(e) {}
  const businessHint = isBusinessOverview
    ? '\n重要：用户问的是整体生意/经营情况，请以营收、达成率、毛利、客流为主作答；若仅有桌访等单项数据或无营收日报，需先说明「暂无该时段营业日报数据」再简述已有数据，不要只回复桌访。\n'
    : '';
  const sysPrompt = `你是"小年"，年年有喜餐饮集团AI数据审计Agent。当前时间：${NOW_CN()}。
门店：${store || '未指定'}${brand ? `（${brand}）` : ''}
时间范围：${timeLabel}（用户问的是该时间范围内的数据）
职责：1.营收/毛利/达成率分析 2.销售排行与产品结构 3.差评/投诉汇总 4.人效/客流趋势
【强制】只根据下方数据库内容回复，禁止编造、臆测或自由发挥。无数据时必须写"暂无此数据"。
${businessHint}【回复格式必须严格按以下模版，与V1一致】
1. 第一行引导句：根据[时间范围](具体日期)数据,[门店]的[经营情况/桌访情况/差评情况等]如下:
2. 每条数据单独一行，格式为：- **指标名**: 值。若下方有[桌访反馈总结]，必须包含反馈总结要点（满意/不满意条数、主要产品/服务不满意项）。
3. 最后一段必须以 **总结** 或 **分析说明** 或 **简要分析** 开头，紧跟一句总结语。
4. 禁止编造数字，无数据时写"暂无此数据"或"昨日无营业数据"。回复不超400字。
${ds}`;
  const r = await callLLM([
    { role: 'system', content: sysPrompt },
    { role: 'user', content: text }
  ], { temperature: 0.1, max_tokens: 800, purpose: 'data_auditor' });
  saveMemory('data_auditor', store, (r.content||'').slice(0,500), {query:text.slice(0,200)}).catch(()=>{});
  // V1 格式：报告类型标题（由 pipeline 拼成 小年：📊 标题 (门店 · 时间)）
  const reportTitle = inferDataAuditorReportTitle(text);
  return { agent: 'data_auditor', response: r.content || FACTUAL_BLOCKED, data: ds, store, timeRange: tr, timeLabel, reportTitle, dataBacked: ds !== '\n[no data found]\n' };
}

function inferDataAuditorReportTitle(text) {
  const t = String(text || '');
  if (/营业|生意|营收|达成|日报/.test(t)) return '营业日报分析';
  if (/桌访|桌数/.test(t)) return '桌访热点';
  if (/开档|开市/.test(t)) return '开档服务';
  if (/收档|收市|闭店/.test(t)) return '收档报告';
  if (/差评|投诉|点评/.test(t)) return '差评数据';
  if (/原料|收货|进货|采购/.test(t)) return '原料收货日报';
  if (/例会|会议/.test(t)) return '例会报告';
  if (/报损|损耗/.test(t)) return '报损记录';
  if (/排行|排名|畅销|滞销/.test(t)) return '销售排行';
  return '数据概览';
}

// ── 2. Ops Supervisor (对标V1: 巡检+照片审核+运营标准) ──
async function handleOpsSupervisor(text, ctx) {
  const store = ctx.store || '';
  const brand = store ? await getBrandForStore(store).catch(() => null) : null;
  const tr = extractTimeRangeFromText(text);
  const timeLabel = getTimeLabelChinese(tr);
  const { start, end } = parseTimeRange(tr);

  // 开档提交情况（谁没开档）：100% 基于数据库，不交给 LLM 编造
  if (store && /开档|谁没开档|开档提交|开档.*情况/.test(text)) {
    const report = await getOpeningSubmissionReport(store, start, end);
    if (report && report.knownStations.length > 0 && report.daily.length > 0) {
      const lines = [];
      lines.push(`已知岗位: ${report.knownStations.join('、')}`);
      lines.push('**开档检查缺失记录**:');
      for (const day of report.daily) {
        if (day.allSubmitted) {
          lines.push(`- ${day.date}: 全部已提交`);
        } else {
          const parts = day.missingList.map(m => {
            const names = m.names ? ` (${m.names})` : '';
            return `缺失 ${m.station}${names}`;
          });
          lines.push(`- ${day.date}: ${parts.join('；')}`);
        }
      }
      lines.push(`共缺失${report.totalMissing}次开档提交。`);
      const body = lines.join('\n');
      saveMemory('ops_supervisor', store, body.slice(0, 500), { query: text.slice(0, 200) }).catch(() => {});
      return { agent: 'ops_supervisor', response: body, store, data: body, timeLabel, reportTitle: '开档提交情况' };
    }
    if (report === null || (report && report.daily.length === 0)) {
      const noData = `当前门店「${store}」在所选时间段内暂无开档报告数据，无法统计缺失情况。请确认飞书开档报告是否已同步。`;
      return { agent: 'ops_supervisor', response: noData, store, data: '', timeLabel, reportTitle: '开档提交情况' };
    }
  }

  // 收档提交情况（谁没收档/本周谁没收档）：与开档同一模版，100% 基于数据库
  if (store && /谁没收档|收档提交|收档.*缺失|本周.*收档/.test(text)) {
    const report = await getClosingSubmissionReport(store, start, end);
    if (report && report.knownStations.length > 0 && report.daily.length > 0) {
      const lines = [];
      lines.push(`已知岗位: ${report.knownStations.join('、')}`);
      lines.push('**收档检查缺失记录**:');
      for (const day of report.daily) {
        if (day.allSubmitted) {
          lines.push(`- ${day.date}: 全部已提交`);
        } else {
          const parts = day.missingList.map(m => {
            const names = m.names ? ` (${m.names})` : '';
            return `缺失 ${m.station}${names}`;
          });
          lines.push(`- ${day.date}: ${parts.join('；')}`);
        }
      }
      lines.push(`共缺失${report.totalMissing}次收档提交。`);
      const body = lines.join('\n');
      saveMemory('ops_supervisor', store, body.slice(0, 500), { query: text.slice(0, 200) }).catch(() => {});
      return { agent: 'ops_supervisor', response: body, store, data: body, timeLabel, reportTitle: '收档提交情况' };
    }
    if (report === null || (report && report.daily.length === 0)) {
      const noData = `当前门店「${store}」在所选时间段内暂无收档报告数据，无法统计缺失情况。请确认飞书收档报告是否已同步。`;
      return { agent: 'ops_supervisor', response: noData, store, data: '', timeLabel, reportTitle: '收档提交情况' };
    }
  }

  // 收档情况（昨天收档）：单日各档口得分与异常
  if (store && /收档|收市|闭档|昨天.*收档|收档.*情况/.test(text)) {
    const dateStr = /昨[天日]/.test(text) ? start : start;
    const closing = await getClosingReportForDay(store, dateStr);
    if (closing) {
      if (closing.items && closing.items.length > 0) {
        const lines = [`${dateStr}收档情况（${store}）：`, ''];

        for (const it of closing.items) {
          let line = `- **${it.station}**：得分 ${it.score}`;
          if (it.responsible) line += `，负责人 ${it.responsible}`;
          if (it.issues) line += `；异常：${it.issues.slice(0, 80)}`;
          lines.push(line);
        }
        lines.push('');
        lines.push(`**分析说明**：${dateStr}共 ${closing.items.length} 个档口提交收档，以上为各档口得分与异常说明。`);
        const body = lines.join('\n');
        saveMemory('ops_supervisor', store, body.slice(0, 500), { query: text.slice(0, 200) }).catch(() => {});
        return { agent: 'ops_supervisor', response: body, store, data: body, timeLabel, reportTitle: '收档提交情况' };
      }
      const noData = closing.emptyReason || `该日（${dateStr}）暂无收档记录。`;
      return { agent: 'ops_supervisor', response: noData, store, data: '', timeLabel, reportTitle: '收档提交情况' };
    }
  }

  let opsData = '';
  if (store) {
    try {
      const r = await query(
        `SELECT fields->>'检查类型' as t, fields->>'得分' as s, fields->>'检查日期' as d,
                fields->>'检查结果' as result
         FROM feishu_generic_records
         WHERE (fields->>'所属门店' ILIKE $1 OR fields->>'门店' ILIKE $1)
         ORDER BY created_at DESC LIMIT 10`, [`%${store}%`]);
      if (r.rows?.length) {
        opsData += '\n[近期巡检记录]\n';
        r.rows.forEach(row => { opsData += `- ${row.d||''}${row.t||'检查'}: ${row.s||'-'}分 ${row.result||''}\n`; });
      }
    } catch (e) { /* silent */ }
    try {
      const anom = await query(
        `SELECT category, severity, description, trigger_date FROM anomaly_triggers
         WHERE store ILIKE $1 AND category IN ('food_safety','hygiene','opening_check','closing_check')
         AND trigger_date >= CURRENT_DATE - 14 ORDER BY trigger_date DESC LIMIT 8`, [`%${store}%`]);
      if (anom.rows?.length) {
        opsData += '\n[近2周运营异常]\n';
        anom.rows.forEach(r => { opsData += `- ${String(r.trigger_date||'').slice(0,10)} ${r.category}(${r.severity}): ${(r.description||'').slice(0,60)}\n`; });
      }
    } catch (e) { /* silent */ }
    try {
      const tasks = await query(
        `SELECT title, status, severity, created_at FROM master_tasks
         WHERE store ILIKE $1 AND status IN ('pending_dispatch','pending_response')
         ORDER BY created_at DESC LIMIT 5`, [`%${store}%`]);
      if (tasks.rows?.length) opsData += '\n[待处理任务] ' + tasks.rows.map(t => `${t.title}(${t.status}/${t.severity})`).join(', ');
    } catch (e) { /* silent */ }
  }
  try { const mem = await recallMemories('ops_supervisor', store, '', 3); if (mem.length) opsData += '\n[历史巡检] ' + mem.map(m => m.content.slice(0,80)).join('; '); } catch(e) {}
  const sysPrompt = `你是"小年"，年年有喜餐饮集团AI营运督导Agent。当前时间：${NOW_CN()}。
门店：${store || '未指定'}${brand ? `（${brand}）` : ''}
职责：1.开市/收市检查 2.卫生巡检 3.照片审核 4.运营标准合规 5.异常任务催办
【回复格式】用 - **项**: 值 分条，最后可加 **分析说明**：... 禁止编造数据，回复不超300字。
${opsData}`;
  const r = await callLLM([
    { role: 'system', content: sysPrompt },
    { role: 'user', content: text }
  ], { temperature: 0.2, max_tokens: 600, purpose: 'ops_supervisor' });
  saveMemory('ops_supervisor', store, (r.content||'').slice(0,500), {query:text.slice(0,200)}).catch(()=>{});
  const reportTitle = /开档|谁没|提交情况/.test(text) ? '开档提交情况' : /收档|闭市/.test(text) ? '收档提交情况' : '营运巡检';
  return { agent: 'ops_supervisor', response: r.content || '请描述巡检需求。', store, data: opsData, timeLabel, reportTitle };
}

// ── 3. Chief Evaluator (对标V1: 绩效评分+员工考核+扣分明细) ──
async function handleChiefEvaluator(text, ctx) {
  let evidence = '';
  const store = ctx.store || '', user = ctx.username || '';
  const brand = store ? await getBrandForStore(store).catch(() => null) : null;
  if (store) {
    try {
      const [anom, scores, deductions] = await Promise.all([
        query(`SELECT category, severity, COUNT(*)::int as cnt FROM anomaly_triggers
               WHERE store ILIKE $1 AND trigger_date >= CURRENT_DATE - INTERVAL '30 days'
               GROUP BY category, severity ORDER BY cnt DESC LIMIT 10`, [`%${store}%`]),
        query(`SELECT role, score, rating, deduction_total, period_start, period_end, breakdown
               FROM agent_scores WHERE store ILIKE $1 ORDER BY period_end DESC LIMIT 5`, [`%${store}%`]),
        query(`SELECT category, severity, description, trigger_date FROM anomaly_triggers
               WHERE store ILIKE $1 AND trigger_date >= CURRENT_DATE - 30
               ORDER BY trigger_date DESC LIMIT 15`, [`%${store}%`])
      ]);
      if (anom.rows?.length) {
        evidence += '\n[近30天异常汇总]\n';
        anom.rows.forEach(r => { evidence += `- ${r.category}(${r.severity}): ${r.cnt}次\n`; });
      }
      if (scores.rows?.length) {
        evidence += '\n[历史绩效评分]\n';
        scores.rows.forEach(r => {
          evidence += `- ${String(r.period_end||'').slice(0,10)} ${r.role}: ${r.score}分 ${r.rating}级 扣${r.deduction_total||0}分\n`;
        });
      }
      if (deductions.rows?.length) {
        evidence += '\n[近30天扣分明细]\n';
        deductions.rows.slice(0, 10).forEach(r => {
          evidence += `- ${String(r.trigger_date||'').slice(0,10)} ${r.category}(${r.severity}): ${(r.description||'').slice(0,50)}\n`;
        });
      }
    } catch (e) { logger.warn({ err: e?.message }, 'chief_evaluator data fetch'); }
  }
  if (!evidence) evidence = '\n[暂无绩效评分数据]';
  // P2: 记忆回调
  try { const mem = await recallMemories('chief_evaluator', store, '', 3); if (mem.length) evidence += '\n[历史评估] ' + mem.map(m => m.content.slice(0,80)).join('; '); } catch(e) {}
  const sysPrompt = `你是"小年"，年年有喜餐饮集团AI绩效考核Agent。当前时间：${NOW_CN()}。
门店：${store || '未指定'}${brand ? `（${brand}）` : ''}，用户：${ctx.name || user || '未知'}
职责：1.门店绩效评分查询 2.员工考核等级说明(A/B/C/D) 3.扣分明细查询 4.奖金规则说明 5.绩效改善建议
评级标准：A级>95分 B级>90分 C级>=85分 D级<85分
奖金规则：A/B级=得分/100×基础奖金, C级归零, D级工资8折
严格约束：只能基于真实扣分记录回答，禁止编造分数或扣分项，引用具体异常类别和日期，不超400字。
${evidence}`;
  const r = await callLLM([
    { role: 'system', content: sysPrompt },
    { role: 'user', content: text }
  ], { temperature: 0.1, max_tokens: 600, purpose: 'chief_evaluator' });
  saveMemory('chief_evaluator', store, (r.content||'').slice(0,500), {query:text.slice(0,200)}).catch(()=>{});
  return { agent: 'chief_evaluator', response: r.content || '暂无评分数据', data: evidence, store };
}
// ── 4. Train Advisor (对标V1: SOP知识库+培训任务+品牌差异化) ──
async function handleTrainAdvisor(text, ctx) {
  const store = ctx.store || '', user = ctx.username || '';
  const brand = store ? await getBrandForStore(store).catch(() => null) : null;
  let kbData = '';
  // 1) 知识库搜索
  try {
    const kb = await query(
      `SELECT title, content FROM knowledge_base
       WHERE category IN ('sop','training','procedure') AND enabled = true
       AND (title ILIKE $1 OR content ILIKE $1) LIMIT 5`,
      [`%${text.slice(0, 30)}%`]);
    if (kb.rows?.length) kbData = '\n[相关SOP/培训资料]\n' + kb.rows.map(r => `### ${r.title}\n${String(r.content).slice(0, 300)}`).join('\n');
  } catch (e) { /* KB table may not exist yet */ }
  // 2) 培训任务查询 (对标V1)
  let trainingCtx = '';
  if (user) {
    try {
      const tasks = await query(
        `SELECT task_id, type, title, status, due_date, progress_data FROM training_tasks
         WHERE assignee_username = $1 ORDER BY created_at DESC LIMIT 5`, [user]);
      if (tasks.rows?.length) {
        trainingCtx = '\n[用户培训任务]\n' + tasks.rows.map(t =>
          `- [${t.task_id}] ${t.title}(${t.type}) 状态:${t.status} 截止:${t.due_date ? String(t.due_date).slice(0,10) : '无'}`
        ).join('\n');
      }
    } catch (e) { /* training_tasks may not exist */ }
  }
  if (!kbData && !trainingCtx) kbData = '\n[暂无匹配SOP资料]';
  // P2: 记忆回调
  try { const mem = await recallMemories('train_advisor', '', text.slice(0,30), 3); if (mem.length) kbData += '\n[历史培训问答] ' + mem.map(m => m.content.slice(0,80)).join('; '); } catch(e) {}
  const sysPrompt = `你是"小年"，年年有喜餐饮集团AI培训与SOP顾问Agent。当前时间：${NOW_CN()}。
门店：${store || '未指定'}${brand ? `（${brand}）` : ''}，用户：${ctx.name || user || '未知'}
核心能力：
【SOP标准咨询】流程规范查询、操作指导、赔付退款处理、品牌差异化SOP
【培训体系】新员工入职培训、岗位技能培训、课件资料查询
【培训跟踪】跟进培训任务进度、解答培训过程疑惑、知识考核
回复结构：SOP/流程→1.问题判断 2.标准流程(1-2-3) 3.注意事项 4.参考依据 | 培训→1.进度 2.解答 3.下一步
严格约束：禁止编造员工人数/薪资日期等数据，基于知识库回答，无资料明确告知，不超400字。
${kbData}${trainingCtx}`;
  const r = await callLLM([
    { role: 'system', content: sysPrompt },
    { role: 'user', content: text }
  ], { temperature: 0.1, max_tokens: 800, purpose: 'train_advisor' });
  saveMemory('train_advisor', store, (r.content||'').slice(0,500), {query:text.slice(0,200)}).catch(()=>{});
  return { agent: 'train_advisor', response: r.content || '请描述培训需求', data: kbData + trainingCtx, store };
}
// ── 5. Appeal (对标V1: 申诉记录入库+扣分核实+公正处理) ──
async function handleAppeal(text, ctx) {
  let appealData = '';
  const store = ctx.store || '', user = ctx.username || '';
  const brand = store ? await getBrandForStore(store).catch(() => null) : null;
  try {
    const [sc, anom, prevAppeals] = await Promise.all([
      query(`SELECT role, score, rating, deduction_total, period_start, period_end FROM agent_scores
             WHERE (store ILIKE $1 OR username = $2) ORDER BY period_end DESC LIMIT 3`,
            [`%${store}%`, user]),
      query(`SELECT category, severity, description, trigger_date FROM anomaly_triggers
             WHERE (store ILIKE $1) AND trigger_date >= CURRENT_DATE - INTERVAL '60 days'
             ORDER BY trigger_date DESC LIMIT 10`, [`%${store}%`]),
      query(`SELECT reason, status, created_at FROM agent_appeals
             WHERE username = $1 ORDER BY created_at DESC LIMIT 5`, [user]).catch(() => ({ rows: [] }))
    ]);
    if (sc.rows?.length) {
      appealData += '\n[你的评分记录]\n';
      sc.rows.forEach(r => { appealData += `- ${String(r.period_end||'').slice(0,10)}: ${r.score}分 ${r.rating}级 扣${r.deduction_total||0}分\n`; });
    }
    if (anom.rows?.length) {
      appealData += '\n[近60天异常扣分项]\n';
      anom.rows.forEach(r => { appealData += `- ${String(r.trigger_date||'').slice(0,10)} ${r.category}(${r.severity}): ${(r.description||'').slice(0,50)}\n`; });
    }
    if (prevAppeals.rows?.length) {
      appealData += '\n[历史申诉记录]\n';
      prevAppeals.rows.forEach(r => { appealData += `- ${String(r.created_at||'').slice(0,10)} 状态:${r.status} 原因:${(r.reason||'').slice(0,50)}\n`; });
    }
  } catch (e) { /* silent */ }
  if (!appealData) appealData = '\n[暂无评分/扣分记录]';
  // P2: 记忆回调
  try { const mem = await recallMemories('appeal', store, '', 3); if (mem.length) appealData += '\n[历史申诉记忆] ' + mem.map(m => m.content.slice(0,80)).join('; '); } catch(e) {}
  const sysPrompt = `你是"小年"，年年有喜餐饮集团AI申诉处理Agent。当前时间：${NOW_CN()}。
门店：${store || '未指定'}${brand ? `（${brand}）` : ''}，用户：${ctx.name || user || '未知'}
职责：1.投诉处理(确认内容→转交核实→保护隐私→给出流程和时间) 2.申诉处理(确认内容→核实数据→预计处理时间)
严格约束：禁止编造任何数据，无数据时说"暂无此信息"，回复专业/公正/简短不超300字。
${appealData}`;
  const r = await callLLM([
    { role: 'system', content: sysPrompt },
    { role: 'user', content: text }
  ], { temperature: 0.2, max_tokens: 600, purpose: 'appeal' });
  // 对标V1: 申诉记录入库
  try {
    await query(`INSERT INTO agent_appeals (username, reason, status) VALUES ($1, $2, 'pending')`, [user || 'anonymous', text.slice(0, 500)]);
  } catch (e) { /* agent_appeals table may not exist */ }
  saveMemory('appeal', store, (r.content||'').slice(0,500), {query:text.slice(0,200)}).catch(()=>{});
  return { agent: 'appeal', response: r.content || '已记录，我们将在24小时内核实并回复。', data: appealData, store, appealRecorded: true };
}
// ── 6. Marketing Planner (营销策划) ──
async function handleMarketingPlanner(text, ctx) {
  let mktData = '';
  const store = ctx.store || '';
  const brand = store ? await getBrandForStore(store).catch(() => null) : null;
  try {
    const rev = await query(
      `SELECT date, actual_revenue, budget, budget_rate, pre_discount_revenue, delivery_actual,
              dine_traffic, dine_orders, efficiency
       FROM daily_reports WHERE store ILIKE $1 AND date >= CURRENT_DATE - 30
       ORDER BY date DESC LIMIT 30`, [`%${store}%`]);
    if (rev.rows?.length) {
      const avg = rev.rows.reduce((s, r) => s + (parseFloat(r.actual_revenue) || 0), 0) / rev.rows.length;
      const avgRate = rev.rows.reduce((s, r) => s + (parseFloat(r.budget_rate) || 0), 0) / rev.rows.length;
      mktData += `\n[近30天营收] 均值:${Math.round(avg)}元 达成率:${(avgRate * 100).toFixed(1)}% 天数:${rev.rows.length}`;
      const recent7 = rev.rows.slice(0, 7);
      mktData += '\n近7天: ' + recent7.map(r => `${String(r.date||'').slice(5, 10)}:${r.actual_revenue||0}`).join(', ');
    }
    const campaigns = await query(
      `SELECT title, status, start_date, end_date, target_metric, target_value
       FROM marketing_campaigns WHERE (store ILIKE $1 OR store IS NULL)
       AND status IN ('active','planned') ORDER BY start_date DESC LIMIT 5`, [`%${store}%`]);
    if (campaigns.rows?.length) {
      mktData += '\n[进行中营销活动]\n' + campaigns.rows.map(c => `${c.title}(${c.status}) ${String(c.start_date||'').slice(0,10)}-${String(c.end_date||'').slice(0,10)} 目标:${c.target_metric}=${c.target_value}`).join('\n');
    }
    const reviews = await query(
      `SELECT category, severity, COUNT(*)::int as cnt FROM anomaly_triggers
       WHERE store ILIKE $1 AND category IN ('product_review','service_review')
       AND trigger_date >= CURRENT_DATE - 30 GROUP BY category, severity`, [`%${store}%`]);
    if (reviews.rows?.length) mktData += '\n[近30天差评] ' + reviews.rows.map(r => `${r.category}(${r.severity}):${r.cnt}次`).join(', ');
  } catch (e) { logger.warn({ err: e?.message }, 'marketing_planner data'); }
  if (!mktData) mktData = '\n[暂无门店营收数据]';
  try {
    const memories = await recallMemories('marketing_planner', store, '', 3);
    if (memories.length) {
      mktData += '\n[历史方案记录]\n' + memories.map(m => {
        const score = m.outcome_score ? `(效果:${m.outcome_score}/10)` : '';
        return `${String(m.created_at||'').slice(0,10)}: ${m.content.slice(0,100)}${score}`;
      }).join('\n');
    }
    const stats = await getOutcomeStats('marketing_planner', store);
    if (stats.total > 0) mktData += `\n[历史效果] ${stats.total}次方案 平均分:${stats.avg_score||'N/A'} 成功:${stats.success_count}次`;
  } catch (e) { /* silent */ }
  const sysPrompt = `你是"小年"，年年有喜餐饮集团AI营销策划Agent。当前时间：${NOW_CN()}。
门店：${store || '未指定'}${brand ? `（${brand}）` : ''}
职责：1.分析营收/达成率/客流趋势找出根因 2.制定针对性营销方案(会员/外卖/新品/节假日) 3.评估现有活动效果 4.具体可执行建议(预算/时间/预期效果)
严格约束：禁止编造数字，必须基于真实数据分析，回复包含具体行动计划。
${mktData}`;
  const r = await callLLM([
    { role: 'system', content: sysPrompt },
    { role: 'user', content: text }
  ], { temperature: 0.4, max_tokens: 1000, purpose: 'marketing_planner' });
  // 保存记忆
  saveMemory('marketing_planner', store, (r.content || '').slice(0, 500), { query: text.slice(0, 200) }).catch(() => {});
  return { agent: 'marketing_planner', response: r.content || '请提供门店信息', data: mktData, store };
}

// ── 7. Marketing Executor (营销执行) ──
async function handleMarketingExecutor(text, ctx) {
  let execData = '';
  const store = ctx.store || '';
  const brand = store ? await getBrandForStore(store).catch(() => null) : null;
  try {
    const camps = await query(
      `SELECT id, title, status, start_date, end_date, target_metric, target_value,
              actual_value, budget_amount, spent_amount, notes
       FROM marketing_campaigns WHERE (store ILIKE $1 OR store IS NULL)
       ORDER BY start_date DESC LIMIT 10`, [`%${store}%`]);
    if (camps.rows?.length) {
      execData += '\n[营销活动清单]\n' + camps.rows.map(c => {
        const progress = c.actual_value && c.target_value ? ((parseFloat(c.actual_value) / parseFloat(c.target_value)) * 100).toFixed(0) + '%' : 'N/A';
        return `[${c.status}] ${c.title} | ${String(c.start_date||'').slice(0,10)}-${String(c.end_date||'').slice(0,10)} | 进度:${progress} | 预算:${c.budget_amount||'N/A'}/已花:${c.spent_amount||0}`;
      }).join('\n');
    }
    const tasks = await query(
      `SELECT title, status, severity, created_at FROM master_tasks
       WHERE store ILIKE $1 AND (title ILIKE '%营销%' OR title ILIKE '%活动%' OR title ILIKE '%促销%')
       ORDER BY created_at DESC LIMIT 5`, [`%${store}%`]);
    if (tasks.rows?.length) execData += '\n[相关任务] ' + tasks.rows.map(t => `${t.title}(${t.status})`).join(', ');
  } catch (e) { logger.warn({ err: e?.message }, 'marketing_executor data'); }
  if (!execData) execData = '\n[暂无营销活动数据]';
  // P2: 记忆回调
  try { const mem = await recallMemories('marketing_executor', store, '', 3); if (mem.length) execData += '\n[历史执行记录] ' + mem.map(m => m.content.slice(0,80)).join('; '); } catch(e) {}
  const sysPrompt = `你是"小年"，年年有喜餐饮集团AI营销执行Agent。当前时间：${NOW_CN()}。
门店：${store || '未指定'}${brand ? `（${brand}）` : ''}
职责：1.跟踪营销活动执行进度 2.对比实际效果与目标 3.执行调整建议 4.ROI和预算消耗汇报 5.创建执行任务闭环
严格约束：禁止编造数字，必须基于真实数据。
${execData}`;
  const r = await callLLM([
    { role: 'system', content: sysPrompt },
    { role: 'user', content: text }
  ], { temperature: 0.4, max_tokens: 800, purpose: 'marketing_executor' });
  saveMemory('marketing_executor', store, (r.content||'').slice(0,500), {query:text.slice(0,200)}).catch(()=>{});
  return { agent: 'marketing_executor', response: r.content || '请描述营销执行需求', data: execData, store };
}

// ── 8. Procurement Advisor (采购建议) ──
async function handleProcurementAdvisor(text, ctx) {
  const store = ctx.store || '';
  if (!store) {
    return { agent: 'procurement_advisor', response: '请提供门店名称以便生成采购建议。' };
  }
  const advice = await generateProcurementAdvice(store);
  let resp = `## 采购建议 - ${store}\n\n**${advice.summary || ''}**\n\n`;
  if (advice.suggestions?.length) {
    resp += advice.suggestions.map((s, i) => `${i + 1}. **${s.category}**: ${s.action === 'increase' ? '↑增加' : s.action === 'decrease' ? '↓减少' : '→维持'} — ${s.reason}${s.estimated_saving ? ` (预估节省¥${s.estimated_saving})` : ''}`).join('\n');
  }
  if (advice.warnings?.length) resp += '\n\n⚠️ ' + advice.warnings.join('\n⚠️ ');
  resp += `\n\n_下次复查: ${advice.next_review_days || 7}天后_`;
  saveMemory('procurement_advisor', store, (resp||'').slice(0,500), {query:text.slice(0,200)}).catch(()=>{});
  return { agent: 'procurement_advisor', response: resp, data: advice, store };
}

// ── 9. Master Agent (对标V1: 调度中枢+活跃任务上下文) ──
async function handleMaster(t, c) {
  const store = c.store || '';
  const brand = store ? await getBrandForStore(store).catch(() => null) : null;
  const memories = [];
  try {
    const mem = await recallMemories('master', store, '', 3);
    if (mem.length) memories.push('\n[历史记录]\n' + mem.map(m => m.content.slice(0,100)).join('\n'));
  } catch(e) { /* silent */ }
  let taskCtx = '';
  if (store) {
    try {
      const tasks = await query(
        `SELECT title, status, severity, agent FROM master_tasks
         WHERE store ILIKE $1 AND status NOT IN ('resolved','settled','cancelled')
         ORDER BY created_at DESC LIMIT 5`, [`%${store}%`]);
      if (tasks.rows?.length) {
        taskCtx = '\n[活跃任务]\n' + tasks.rows.map(t => `- ${t.title}(${t.status}/${t.severity}) → ${t.agent||'未分配'}`).join('\n');
      }
    } catch(e) { /* silent */ }
  }
  const sysPrompt = `你是"小年"，年年有喜餐饮集团AI助理（Master调度中枢）。当前时间：${NOW_CN()}。
门店：${store || '未指定'}${brand ? `（${brand}）` : ''}，用户：${c.name || c.username || '未知'}（${c.role === 'store_manager' ? '店长' : c.role === 'store_production_manager' ? '出品经理' : c.role || '员工'}）
可以帮助：数据审计、营运检查、绩效查询、SOP咨询、申诉处理、营销活动规划引导。
严格约束：禁止编造任何数据（员工人数/薪资日期/职级/品牌数等），无确切数据回复"这个信息我暂时无法查到，建议联系HR或查看系统"，回复极简不超200字。
${memories.join('')}${taskCtx}`;
  const r = await callLLM([{ role: 'system', content: sysPrompt }, { role: 'user', content: t }],
    { temperature: 0.1, max_tokens: 600, purpose: 'master' });
  saveMemory('master', store, (r.content||'').slice(0,500), {query:t.slice(0,200)}).catch(()=>{});
  return { agent: 'master', response: r.content || '您好，请描述您的需求。', store };
}
const HANDLERS={data_auditor:handleDataAuditor,ops_supervisor:handleOpsSupervisor,chief_evaluator:handleChiefEvaluator,train_advisor:handleTrainAdvisor,appeal:handleAppeal,marketing_planner:handleMarketingPlanner,marketing_executor:handleMarketingExecutor,procurement_advisor:handleProcurementAdvisor,marketing:handleMarketingPlanner,food_quality:handleOpsSupervisor,master:handleMaster};
export async function dispatchToAgent(route,text,ctx={}){const h=HANDLERS[route]||HANDLERS.master;const t0=Date.now();try{const r=await h(text,ctx);r.latencyMs=Date.now()-t0;return r;}catch(e){return{agent:route,response:'出错请重试',error:e?.message};}}
export{HANDLERS};
