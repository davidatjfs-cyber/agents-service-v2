// ═══════════════════════════════════════════════════════
// Bitable Polling Engine — V2
// Migrated from V1 agents.js, adapted for V2 architecture
// Polls Feishu Bitable tables and syncs records to DB
// ═══════════════════════════════════════════════════════
import axios from 'axios';
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getConfig } from './config-service.js';

// ── Bitable Table Configurations ──
const BITABLE_CONFIGS = {
  'ops_checklist': {
    appId: process.env.BITABLE_OPS_APP_ID || 'cli_a91dae9f9578dcb1',
    appSecret: process.env.BITABLE_OPS_APP_SECRET || 'sjpAzPwu4KixvhbAOD7w4ee1oEKRRBQF',
    appToken: process.env.BITABLE_OPS_APP_TOKEN || 'PtVObRtoPaMAP3stIIFc8DnJngd',
    tableId: process.env.BITABLE_OPS_TABLE_ID || 'tblxHI9ZAKONOTpp',
    name: '运营检查表(含开收档)',
    type: 'checklist',
    pollingInterval: 60000,
    sortField: '["_id DESC"]'
  },
  'table_visit': {
    appId: process.env.BITABLE_TABLEVISIT_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_TABLEVISIT_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_TABLEVISIT_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_TABLEVISIT_TABLE_ID || 'tblpx5Efqc6eHo3L',
    name: '桌访表',
    type: 'table_visit',
    pollingInterval: 300000,
    sortField: '["日期 DESC"]'
  },
  'bad_review': {
    appId: process.env.BITABLE_TABLEVISIT_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_TABLEVISIT_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_TABLEVISIT_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: 'tblgReexNjWJOJB6',
    name: '差评报告DB',
    type: 'bad_review',
    pollingInterval: 300000,
    sortField: '["创建日期 DESC"]'
  },
  'closing_reports': {
    appId: process.env.BITABLE_CLOSING_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_CLOSING_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_CLOSING_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_CLOSING_TABLE_ID || 'tblXYfSBRrgNGohN',
    name: '收档报告DB',
    type: 'closing_report',
    pollingInterval: 300000,
    sortField: '["日期 DESC"]'
  },
  'opening_reports': {
    appId: process.env.BITABLE_OPENING_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_OPENING_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_OPENING_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_OPENING_TABLE_ID || 'tbl32E6d0CyvLvfi',
    name: '开档报告',
    type: 'opening_report',
    pollingInterval: 300000,
    sortField: '["日期 DESC"]'
  },
  'meeting_reports': {
    appId: process.env.BITABLE_MEETING_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_MEETING_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_MEETING_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_MEETING_TABLE_ID || 'tblZXgaU0LpSye2m',
    name: '例会报告',
    type: 'meeting_report',
    pollingInterval: 300000,
    sortField: '["日期 DESC"]'
  },
  'material_majixian': {
    appId: process.env.BITABLE_MATERIAL_MJX_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_MATERIAL_MJX_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_MATERIAL_MJX_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_MATERIAL_MJX_TABLE_ID || 'tblz4kW1cY22XRlL',
    name: '马己仙原料收货日报',
    type: 'material_report',
    brand: 'majixian',
    pollingInterval: 300000,
    sortField: '["日期 DESC"]'
  },
  'material_hongchao': {
    appId: process.env.BITABLE_MATERIAL_HC_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_MATERIAL_HC_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_MATERIAL_HC_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_MATERIAL_HC_TABLE_ID || 'tbllcV1evqTJyzlN',
    name: '洪潮原料收货日报',
    type: 'material_report',
    brand: 'hongchao',
    pollingInterval: 300000,
    sortField: '["日期 DESC"]'
  },
  'loss_report': {
    appId: process.env.BITABLE_LOSS_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_LOSS_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_LOSS_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_LOSS_TABLE_ID || 'tblLCxLO0ZbV7uyo',
    name: '报损单',
    type: 'loss_report',
    pollingInterval: 300000,
    sortField: '["创建日期 DESC"]'
  },
  'task_responses': {
    appId: process.env.BITABLE_TABLEVISIT_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_TABLEVISIT_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_TASK_RESP_APP_TOKEN || 'BTAjbflrlaMRHesADUfc8usznqh',
    tableId: process.env.BITABLE_TASK_RESP_TABLE_ID || 'tblT86H1uuTJydne',
    name: '异常任务回复',
    type: 'task_response',
    pollingInterval: 60000,
    sortField: '["_id DESC"]'
  }
};

// ── Token Cache (per config key) ──
const _tokenCache = new Map();
const BASE_URL = 'https://open.feishu.cn/open-apis';

async function getBitableTenantToken(configKey = 'ops_checklist') {
  const config = BITABLE_CONFIGS[configKey];
  if (!config) return '';
  const cached = _tokenCache.get(configKey);
  if (cached && Date.now() < cached.expires) return cached.token;
  try {
    const resp = await axios.post(BASE_URL + '/auth/v3/tenant_access_token/internal', {
      app_id: config.appId, app_secret: config.appSecret
    }, { timeout: 10000 });
    const token = resp.data?.tenant_access_token || '';
    const expires = Date.now() + (resp.data?.expire || 7000) * 1000;
    _tokenCache.set(configKey, { token, expires });
    logger.info({ configKey }, 'bitable token refreshed');
    return token;
  } catch (e) {
    logger.error({ configKey, err: e?.message }, 'bitable token failed');
    return '';
  }
}

// ── Fetch Records from Bitable API ──
async function getBitableRecords(configKey, options = {}) {
  const config = BITABLE_CONFIGS[configKey];
  if (!config) return { ok: false, error: 'invalid_config' };
  const token = await getBitableTenantToken(configKey);
  if (!token) return { ok: false, error: 'no_token' };
  const { pageSize = 200, pageToken, filter } = options;
  const params = { page_size: pageSize, user_id_type: 'open_id' };
  if (pageToken) params.page_token = pageToken;
  if (filter) params.filter = filter;
  if (config.sortField) params.sort = config.sortField;
  else params.sort = JSON.stringify(["_id DESC"]);
  try {
    const resp = await axios.get(
      `${BASE_URL}/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records`,
      { headers: { Authorization: `Bearer ${token}` }, params, timeout: 15000 }
    );
    return {
      ok: true,
      records: resp.data?.data?.items || [],
      hasMore: resp.data?.data?.has_more || false,
      nextPageToken: resp.data?.data?.page_token || '',
      total: resp.data?.data?.total || 0
    };
  } catch (e) {
    logger.error({ configKey, err: e?.response?.data || e?.message }, 'bitable fetch failed');
    return { ok: false, error: String(e?.message || e) };
  }
}

// ── Dedup: track processed record IDs ──
const _processedIds = new Set();
const DEDUP_MAX = 50000;
const DEDUP_CLEAN = 10000;

async function seedDedup() {
  if (_processedIds.size > 0) return;
  try {
    const r = await query(
      `SELECT DISTINCT app_token || '_' || table_id || '_' || record_id AS key
       FROM feishu_generic_records WHERE created_at > NOW() - INTERVAL '30 days' LIMIT 50000`
    );
    for (const row of r.rows) _processedIds.add(row.key);
    logger.info({ count: _processedIds.size }, 'bitable dedup seeded');
  } catch (e) {
    logger.error({ err: e?.message }, 'bitable dedup seed failed');
  }
}

// ── Poll a single Bitable table ──
async function pollBitableTable(configKey) {
  const config = BITABLE_CONFIGS[configKey];
  if (!config?.tableId) return;
  await seedDedup();
  logger.info({ configKey }, 'bitable polling...');

  const allRecords = [];
  let pageToken = '';
  let page = 0;
  while (page < 20) {
    const result = await getBitableRecords(configKey, { pageSize: 200, pageToken });
    if (!result.ok) { logger.error({ configKey, error: result.error }, 'poll failed'); return; }
    allRecords.push(...(result.records || []));
    if (!result.hasMore || !result.nextPageToken) break;
    pageToken = result.nextPageToken;
    page++;
  }

  let newCount = 0;
  for (const record of allRecords) {
    const recordId = record.record_id;
    const dedupKey = `${config.appToken}_${config.tableId}_${recordId}`;
    if (_processedIds.has(dedupKey)) continue;

    // Save to feishu_generic_records (shared with V1)
    try {
      await query(
        `INSERT INTO feishu_generic_records (app_token, table_id, record_id, config_key, fields, raw, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NOW(), NOW())
         ON CONFLICT (app_token, table_id, record_id) DO UPDATE SET
           config_key = COALESCE(EXCLUDED.config_key, feishu_generic_records.config_key),
           fields = EXCLUDED.fields, raw = EXCLUDED.raw, updated_at = NOW()`,
        [config.appToken || '', config.tableId || '', recordId, configKey,
         JSON.stringify(record.fields || {}), JSON.stringify(record)]
      );
      newCount++;
    } catch (e) {
      if (!String(e?.message || '').includes('duplicate')) {
        logger.error({ configKey, recordId, err: e?.message }, 'save generic record failed');
      }
    }

    // Process type-specific data
    try {
      await processRecord(configKey, config.type, record, config.brand);
    } catch (e) {
      logger.error({ configKey, recordId, err: e?.message }, 'process record failed');
    }

    _processedIds.add(dedupKey);
    // Prevent memory bloat
    if (_processedIds.size > DEDUP_MAX) {
      const oldest = Array.from(_processedIds).slice(0, DEDUP_CLEAN);
      oldest.forEach(id => _processedIds.delete(id));
    }
  }

  if (newCount > 0) logger.info({ configKey, newCount, total: allRecords.length }, 'bitable new records');
}

// ── Process record by type → save structured data ──
async function processRecord(configKey, type, record, brand) {
  const fields = record.fields || {};
  const recordId = record.record_id;

  const upsertMsg = async (contentType, content, agentData) => {
    await query(`
      WITH updated AS (
        UPDATE agent_messages SET content=$1, agent_data=$2::jsonb, updated_at=NOW()
        WHERE record_id=$3 AND content_type=$4 RETURNING id
      )
      INSERT INTO agent_messages (direction,channel,content_type,content,agent_data,record_id)
      SELECT 'in','feishu',$4,$1,$2::jsonb,$3
      WHERE NOT EXISTS (SELECT 1 FROM updated)
    `, [content, JSON.stringify(agentData), recordId, contentType]);
  };

  switch (type) {
    case 'checklist':
      await upsertMsg('bitable_submission', `${extractText(fields['检查类型'])}提交（Bitable）`, {
        configKey, recordId, type: 'checklist',
        fields: { store: extractText(fields['所属门店']), checkType: extractText(fields['检查类型']),
                  checkStatus: extractText(fields['检查状态']), checkRemark: extractText(fields['检查说明']),
                  submitter: extractText(fields['提交人']), submitTime: extractText(fields['提交日期']) }
      });
      break;
    case 'table_visit':
      await upsertMsg('table_visit', '桌访记录', {
        type: 'table_visit', recordId,
        fields: { store: extractText(fields['门店']), date: extractText(fields['日期']),
                  table_no: extractText(fields['桌号']), satisfaction: extractText(fields['满意度']),
                  product_issue: extractText(fields['产品不满意项']), service_issue: extractText(fields['服务不满意项']) }
      });
      break;
    case 'bad_review':
      await upsertMsg('bad_review', '差评记录', {
        type: 'bad_review', recordId,
        fields: { store: extractText(fields['门店']), date: extractText(fields['创建日期'] || fields['日期']),
                  platform: extractText(fields['平台']), content: extractText(fields['评价内容']),
                  rating: extractText(fields['评分']), category: extractText(fields['差评分类']) }
      });
      break;
    case 'closing_report':
      await upsertMsg('closing_report', '收档报告', {
        type: 'closing_report', recordId,
        fields: { store: extractText(fields['门店']), date: extractText(fields['日期']),
                  station: extractText(fields['档口']), responsible: extractText(fields['本档口值班负责人']),
                  inventory_check: extractText(fields['本档口库存检查']), cleaning_status: extractText(fields['本档口清洁卫生']),
                  equipment_status: extractText(fields['设备使用情况']), issues: extractText(fields['异常情况说明']) }
      });
      break;
    case 'opening_report':
      await upsertMsg('opening_report', '开档报告', {
        type: 'opening_report', recordId,
        fields: { store: extractText(fields['门店']), date: extractText(fields['日期']),
                  station: extractText(fields['档口']), responsible: extractText(fields['本档口值班负责人']),
                  preparation_time: extractText(fields['开档时间']), cleaning_status: extractText(fields['本档口清洁卫生']),
                  equipment_status: extractText(fields['设备使用情况']), issues: extractText(fields['异常情况说明']) }
      });
      break;
    case 'meeting_report':
      await upsertMsg('meeting_report', '例会报告', {
        type: 'meeting_report', recordId,
        fields: { store: extractText(fields['门店']), date: extractText(fields['日期']),
                  meeting_type: extractText(fields['会议类型']), organizer: extractText(fields['组织人']),
                  participants: extractText(fields['参会人员']), topics: extractText(fields['会议议题']),
                  decisions: extractText(fields['决议事项']), action_items: extractText(fields['行动项']) }
      });
      break;
    case 'material_report':
      await upsertMsg('material_report', `${brand || ''}原料收货日报`, {
        type: 'material_report', recordId, brand: brand || '',
        fields: { store: extractText(fields['门店']), date: extractText(fields['日期']),
                  material_name: extractText(fields['原料名称']), supplier: extractText(fields['供应商']),
                  quantity: extractText(fields['数量']), unit_price: extractText(fields['单价']),
                  total_price: extractText(fields['总价']), quality_check: extractText(fields['质量检查']),
                  receiver: extractText(fields['收货人']) }
      });
      break;
    case 'loss_report':
      await upsertMsg('loss_report', '报损单', {
        type: 'loss_report', recordId,
        fields: { store: extractText(fields['门店']), date: extractText(fields['创建日期'] || fields['日期']),
                  item: extractText(fields['报损物品']), quantity: extractText(fields['数量']),
                  reason: extractText(fields['报损原因']), amount: extractText(fields['金额']) }
      });
      break;
    case 'task_response':
      await processTaskResponse(fields, recordId);
      break;
    default:
      await upsertMsg('generic_bitable', `通用数据 - ${configKey}`, { configKey, recordId, fields });
  }
}

// ── Task Response: link back to master_tasks ──
async function processTaskResponse(fields, recordId) {
  const taskId = extractText(fields['任务编号']);
  const reply = extractText(fields['回复说明']);
  const status = extractText(fields['处理状态']);
  if (!taskId) return;
  try {
    // Update master_tasks status if reply provided
    if (reply) {
      await query(
        `UPDATE master_tasks SET status = CASE WHEN $1 = '已处理' THEN 'closed' WHEN $1 = '已回复' THEN 'pending_response' ELSE status END,
         closed_at = CASE WHEN $1 = '已处理' THEN NOW() ELSE closed_at END
         WHERE task_id = $2`,
        [status, taskId]
      );
    }
    // Log the response
    await query(
      `INSERT INTO agent_messages (direction,channel,content_type,content,agent_data,record_id)
       VALUES ('in','feishu','task_response',$1,$2::jsonb,$3)
       ON CONFLICT DO NOTHING`,
      [`任务回复: ${taskId}`, JSON.stringify({ taskId, reply, status, recordId, fields }), recordId]
    );
  } catch (e) {
    logger.error({ taskId, err: e?.message }, 'process task response failed');
  }
}

// ── Extract text from Bitable complex field values ──
function extractText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (Array.isArray(val)) {
    return val.map(item => {
      if (typeof item === 'string') return item;
      if (item?.text) return item.text;
      if (item?.name) return item.name;
      if (Array.isArray(item?.text_arr)) return item.text_arr.map(t => t?.text || '').join('');
      return JSON.stringify(item);
    }).join(', ');
  }
  if (val?.text) return val.text;
  if (val?.name) return val.name;
  return JSON.stringify(val);
}

// ── Main poll-all scheduler ──
const POLL_ORDER = [
  'ops_checklist', 'bad_review', 'closing_reports', 'opening_reports',
  'meeting_reports', 'material_majixian', 'material_hongchao', 'table_visit',
  'loss_report', 'task_responses'
];

export async function pollAllBitableTables() {
  const featureFlags = await getConfig('feature_flags').catch(() => null) || {};
  if (featureFlags.bitable_polling === false) {
    logger.info('bitable polling disabled by feature flag');
    return;
  }
  const known = new Set(POLL_ORDER);
  const finalKeys = [
    ...POLL_ORDER.filter(k => BITABLE_CONFIGS[k]),
    ...Object.keys(BITABLE_CONFIGS).filter(k => !known.has(k) && BITABLE_CONFIGS[k]?.type !== 'task_response')
  ];
  for (const configKey of finalKeys) {
    try {
      await pollBitableTable(configKey);
    } catch (e) {
      logger.error({ configKey, err: e?.message }, 'bitable poll error');
    }
  }
}

// ── Start polling loop ──
let _pollInterval = null;

export function startBitablePolling(intervalMs = 120000) {
  if (_pollInterval) return;
  logger.info({ intervalMs }, 'starting bitable polling');
  // Initial poll after 10s
  setTimeout(() => pollAllBitableTables().catch(e => logger.error({ err: e?.message }, 'initial poll failed')), 10000);
  // Then every intervalMs
  _pollInterval = setInterval(() => {
    pollAllBitableTables().catch(e => logger.error({ err: e?.message }, 'poll cycle failed'));
  }, intervalMs);
}

export function stopBitablePolling() {
  if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
}

// ── Stats for admin panel ──
export function getBitableStatus() {
  return {
    configs: Object.entries(BITABLE_CONFIGS).map(([k, v]) => ({
      key: k, name: v.name, type: v.type, tableId: v.tableId,
      hasCredentials: !!(v.appId && v.appSecret && v.appToken && v.tableId)
    })),
    processedCount: _processedIds.size,
    polling: !!_pollInterval
  };
}
