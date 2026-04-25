// ═══════════════════════════════════════════════════════
// Bitable Polling Engine — V2
// Migrated from V1 agents.js, adapted for V2 architecture
// Polls Feishu Bitable tables and syncs records to DB
// ═══════════════════════════════════════════════════════
import axios from 'axios';
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { notifyAdminsDataIssue } from './admin-data-alert.js';
import { getConfig } from './config-service.js';
import { parseFeishuRatioOrPercentString } from '../utils/feishu-percent.js';
import { applyPllmDecision } from './proactive-v2/pllm-workflow.js';

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
    // 勿按「日期」排序：现网表头多为「记录日期」无「日期」列时会导致 OpenAPI 报错、整表拉取失败
    sortField: '["_id DESC"]'
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
    sortField: '["收货日期 DESC"]'
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
    sortField: '["收货日期 DESC"]'
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
    // Base 常为 BTA*。优先显式的 BITABLE_TASK_RESP_APP_*；
    // 若未配置，则优先回退到历史上真正承载这套多维表的桌访应用，而不是通用 FEISHU/LARK 机器人应用。
    // 否则在现网 FEISHU_APP_ID 指向其它 app（如 ops app）时，会因 token 与 Base 不匹配而报 99991663。
    appId:
      process.env.BITABLE_TASK_RESP_APP_ID ||
      process.env.BITABLE_TABLEVISIT_APP_ID ||
      'cli_a9fc0d13c838dcd6',
    appSecret:
      process.env.BITABLE_TASK_RESP_APP_SECRET ||
      process.env.BITABLE_TABLEVISIT_APP_SECRET ||
      'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_TASK_RESP_APP_TOKEN || 'BTAjbflrlaMRHesADUfc8usznqh',
    tableId: process.env.BITABLE_TASK_RESP_TABLE_ID || 'tblT86H1uuTJydne',
    name: '异常任务回复',
    type: 'task_response',
    pollingInterval: 60000,
    sortField: '["_id DESC"]'
  },
  /** 实际毛利率表：与同 Base 桌访等共用应用凭证；每日 5:00 全量刷新 + 常规轮询均会 upsert（skipDedup） */
  'actual_gross_margin': {
    appId: process.env.BITABLE_ACTUAL_MARGIN_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_ACTUAL_MARGIN_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_ACTUAL_MARGIN_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_ACTUAL_MARGIN_TABLE_ID || 'tbl4RTo9ZVTxIpLw',
    name: '实际毛利率表',
    type: 'actual_gross_margin',
    pollingInterval: 300000,
    sortField: '["毛利日期 DESC"]',
    skipDedup: true
  }
};

// ── Token Cache (per config key) ──
const _tokenCache = new Map();
const BASE_URL = 'https://open.feishu.cn/open-apis';

/** 单次 HTTP 超时（大表 15s 极易误报；可用环境变量覆盖） */
const BITABLE_HTTP_TIMEOUT_MS = (() => {
  const n = Number(process.env.BITABLE_HTTP_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 15000 ? n : 60000;
})();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 飞书 OpenAPI 与网页不同：大表/索引中常见 1254607「Data not ready」、或网络/超时。
 * 仅用于 getBitableRecords 内退避重试；多轮仍失败时由 notifyBitablePollFetchFailed 按「真失败」告警。
 */
function isTransientBitableFetchError(errText) {
  const s = String(errText || '');
  return /1254002|1254607|1255001|1255002|1255003|1255004|1255005|1255040|1254200|feishu_code_2200|internal[\s_]?error|rpc[\s_]?error|marshal[\s_]?error|data not ready|try again later|timeout|ECONNABORTED|ECONNRESET|ETIMEDOUT|socket hang up|EAI_AGAIN|429|502|503|504/i.test(
    s
  );
}

/** 1254607 specifically — "Data not ready, please try again later" — needs longer backoff than network errors */
function isDataNotReadyError(errText) {
  return /1254607|data not ready|try again later/i.test(String(errText || ''));
}

/** 1255001 InternalError — Feishu server ephemeral error, should retry with longer backoff */
function isFeishuInternalError(errText) {
  return /1254002|1255001|1255002|1255003|1255004|1255005|1255040|feishu_code_2200|internal[\s_]?error|rpc[\s_]?error|marshal[\s_]?error/i.test(String(errText || ''));
}

/** 轮询在 getBitableRecords 用尽重试后仍失败 → 视为真失败，必须通知管理员（与飞书网页能否打开无关）。
 *  1254607 "Data not ready" 和 1255001 InternalError 是飞书API正常瞬态，重试后仍失败不告警（下次轮询会自动恢复）。 */
function notifyBitablePollFetchFailed(configKey, config, error) {
  const err = String(error || '').trim() || 'unknown';

  // 1254607 "Data not ready" and 1255001 InternalError are normal Feishu transients — suppress alert
  if (isDataNotReadyError(err) || isFeishuInternalError(err)) {
    logger.info({ configKey, err: err.slice(0, 200) }, 'bitable transient error suppressed (no alert)');
    return;
  }

  const urgent =
    err === 'no_token' ||
    err === 'invalid_config' ||
    /401|403|99991663|1254045|1254004|invalid tenant|credential|sort/i.test(err);
  void notifyAdminsDataIssue({
    alertType: 'bitable_poll_fetch_failed',
    title: `飞书多维表同步失败：${config?.name || configKey}`,
    lines: [
      `配置键：${configKey}`,
      `表名：${config?.name || '-'}`,
      `app_token：${String(config?.appToken || '').slice(0, 12)}…`,
      `table_id：${config?.tableId || '-'}`,
      `错误摘要：${err.slice(0, 700)}`
    ],
    dedupeKey: `bitable_poll_fail_${configKey}`,
    priority: urgent ? 'A' : 'B',
    dedupeHours: urgent ? 2 : 6
  });
}

const TOKEN_TTL_BUFFER_MS = 5 * 60 * 1000; // 5 min buffer before expiry

async function getBitableTenantToken(configKey = 'ops_checklist', forceRefresh = false) {
  const config = BITABLE_CONFIGS[configKey];
  if (!config) return '';
  if (!forceRefresh) {
    const cached = _tokenCache.get(configKey);
    // Use buffer: refresh 5 min before actual expiry to avoid edge-case 99991663
    if (cached && Date.now() < cached.expires - TOKEN_TTL_BUFFER_MS) return cached.token;
  }
  try {
    const resp = await axios.post(BASE_URL + '/auth/v3/tenant_access_token/internal', {
      app_id: config.appId, app_secret: config.appSecret
    }, { timeout: 10000 });
    const token = resp.data?.tenant_access_token || '';
    const ttlSec = resp.data?.expire || 7000;
    const expires = Date.now() + ttlSec * 1000;
    _tokenCache.set(configKey, { token, expires });
    logger.info({ configKey, forceRefresh, ttlSec }, 'bitable token refreshed');
    return token;
  } catch (e) {
    logger.error({ configKey, err: e?.message }, 'bitable token failed');
    return '';
  }
}

function evictTokenCache(configKey) {
  _tokenCache.delete(configKey);
}

function isTokenAuthError(errText) {
  const s = String(errText || '');
  return /99991663|invalid access token|invalid.*token.*authori|token.*expired|token.*invalid/i.test(s);
}

// ── Fetch Records from Bitable API ──
async function getBitableRecords(configKey, options = {}) {
  const config = BITABLE_CONFIGS[configKey];
  if (!config) return { ok: false, error: 'invalid_config' };
  let token = await getBitableTenantToken(configKey);
  if (!token) return { ok: false, error: 'no_token' };
  const { pageSize = 200, pageToken, filter } = options;
  const params = { page_size: pageSize, user_id_type: 'open_id' };
  if (pageToken) params.page_token = pageToken;
  if (filter) params.filter = filter;
  if (config.sortField) params.sort = config.sortField;
  else params.sort = JSON.stringify(['_id DESC']);

  const MAX_RETRIES_NORMAL = 4;
  const MAX_RETRIES_DATA_NOT_READY = 2;
  let _isDataNotReady = false;
  let lastErr = 'unknown';
  let tokenRefreshed = false;

  for (let attempt = 1; ; attempt++) {
    const maxRetries = _isDataNotReady ? MAX_RETRIES_DATA_NOT_READY : MAX_RETRIES_NORMAL;
    if (attempt > maxRetries) break;
    try {
      const resp = await axios.get(
        `${BASE_URL}/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records`,
        { headers: { Authorization: `Bearer ${token}` }, params, timeout: BITABLE_HTTP_TIMEOUT_MS }
      );
      const bizCode = resp.data?.code;
      if (bizCode != null && Number(bizCode) !== 0) {
        const msg = String(resp.data?.msg || resp.data?.error || '').trim() || 'unknown';
        lastErr = `feishu_code_${bizCode}: ${msg}`;
        // Token auth error (99991663): evict cached token and retry with a fresh one
        if (isTokenAuthError(lastErr) && !tokenRefreshed) {
          logger.warn({ configKey, bizCode, attempt }, 'bitable token auth error, evicting cache and refreshing token');
          evictTokenCache(configKey);
          token = await getBitableTenantToken(configKey, true);
          if (token) {
            tokenRefreshed = true;
            continue;
          }
        }
        if (isTransientBitableFetchError(lastErr)) {
          _isDataNotReady = _isDataNotReady || isDataNotReadyError(lastErr);
        const maxNow = _isDataNotReady ? MAX_RETRIES_DATA_NOT_READY : MAX_RETRIES_NORMAL;
        if (attempt >= maxNow) {
          logger.error({ configKey, bizCode, attempt, isDataNotReady: _isDataNotReady }, 'bitable fetch exhausted retries');
          return { ok: false, error: lastErr };
        }
        const isDNR = isDataNotReadyError(lastErr);
        const isInternal = isFeishuInternalError(lastErr);
        // 1254607: 30s, 60s exponential | 1255001: 10s, 20s | others: 2s, 4s, 6s, 8s
        const delay = isDNR
          ? Math.min(120000, 30000 * Math.pow(2, attempt - 1))
          : isInternal
            ? Math.min(60000, 10000 * Math.pow(2, attempt - 1))
            : Math.min(20000, 2000 * attempt);
          logger.warn({ configKey, bizCode, attempt, delay, isDataNotReady: isDNR }, 'bitable business code transient, retrying');
          await sleep(delay);
          continue;
        }
        logger.error({ configKey, bizCode, msg }, 'bitable fetch business error');
        return { ok: false, error: lastErr };
      }
      return {
        ok: true,
        records: resp.data?.data?.items || [],
        hasMore: resp.data?.data?.has_more || false,
        nextPageToken: resp.data?.data?.page_token || '',
        total: resp.data?.data?.total || 0
      };
    } catch (e) {
      const detail = e?.response?.data;
      lastErr = detail
        ? `HTTP ${e.response?.status || '?'} ${typeof detail === 'object' ? JSON.stringify(detail).slice(0, 400) : String(detail)}`
        : String(e?.message || e);
      // Token auth error in HTTP layer: evict cache and retry
      if (isTokenAuthError(lastErr) && !tokenRefreshed) {
        logger.warn({ configKey, attempt }, 'bitable HTTP token auth error, evicting cache and refreshing token');
        evictTokenCache(configKey);
        token = await getBitableTenantToken(configKey, true);
        if (token) {
          tokenRefreshed = true;
          continue;
        }
      }
      if (isTransientBitableFetchError(lastErr)) {
        _isDataNotReady = _isDataNotReady || isDataNotReadyError(lastErr);
        const maxNow = _isDataNotReady ? MAX_RETRIES_DATA_NOT_READY : MAX_RETRIES_NORMAL;
        if (attempt >= maxNow) {
          logger.error({ configKey, attempt, isDataNotReady: _isDataNotReady, err: lastErr.slice(0, 200) }, 'bitable HTTP fetch exhausted retries');
          return { ok: false, error: lastErr };
        }
        const isDNR = isDataNotReadyError(lastErr);
        const isInternal = isFeishuInternalError(lastErr);
        const delay = isDNR
          ? Math.min(120000, 30000 * Math.pow(2, attempt - 1))
          : isInternal
            ? Math.min(60000, 10000 * Math.pow(2, attempt - 1))
            : Math.min(20000, 2000 * attempt);
        logger.warn({ configKey, attempt, delay, isDataNotReady: isDNR || isInternal, err: lastErr.slice(0, 300) }, 'bitable HTTP transient, retrying');
        await sleep(delay);
        continue;
      }
      logger.error({ configKey, err: detail || e?.message }, 'bitable fetch failed');
      return { ok: false, error: lastErr };
    }
  }
  return { ok: false, error: lastErr };
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

function bitableMaxPages(configKey) {
  if (configKey === 'table_visit') return 120;
  if (configKey === 'opening_reports' || configKey === 'closing_reports') return 80;
  return 20;
}

// ── Poll a single table, non-blocking: yields to event loop between pages ──
export async function pollBitableTable(configKey) {
  const config = BITABLE_CONFIGS[configKey];
  if (!config?.tableId) return;
  delete _lastPollSkipMeta[configKey];
  await seedDedup();
  logger.info({ configKey }, 'bitable polling...');

  const allRecords = [];
  let pageToken = '';
  let page = 0;
  let truncated = false;
  // 大表会撞上固定页数上限，表现为“轮询成功但部分门店当天查不到数据”。
  // 对桌访、开档、收档放宽页数；若仍 hit 上限且 has_more=true，则视为“疑似截断”并告警。
  const maxPages = bitableMaxPages(configKey);
  while (page < maxPages) {
    const result = await getBitableRecords(configKey, { pageSize: 200, pageToken });
    if (!result.ok) {
      logger.error({ configKey, error: result.error }, 'poll failed');
      _lastPollMeta[configKey] = { ok: false, error: String(result.error || ''), at: Date.now() };
      notifyBitablePollFetchFailed(configKey, config, result.error);
      return;
    }
    allRecords.push(...(result.records || []));
    if (!result.hasMore || !result.nextPageToken) break;
    if (page + 1 >= maxPages) {
      truncated = true;
      logger.warn({ configKey, maxPages, fetched: allRecords.length }, 'bitable polling hit page cap; records may be truncated');
      break;
    }
    pageToken = result.nextPageToken;
    page++;
    // Yield to event loop between pages so webhook requests aren't starved
    await new Promise(r => setImmediate(r));
  }

  let newCount = 0;
  for (const record of allRecords) {
    const recordId = record.record_id;
    const dedupKey = `${config.appToken}_${config.tableId}_${recordId}`;
    const wasInDedupSet = !config.skipDedup && _processedIds.has(dedupKey);

    // Save to feishu_generic_records：每条每轮都 upsert。HRMS 唤醒由数据库触发器 trg_feishu_generic_records_bitable_notify 在实质变更时 pg_notify 完成（应用层不再重复 NOTIFY）。
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
      if (!config.skipDedup && !wasInDedupSet) newCount++;
    } catch (e) {
      if (!String(e?.message || '').includes('duplicate')) {
        logger.error({ configKey, recordId, err: e?.message }, 'save generic record failed');
      }
    }

    // processRecord 始终执行（内部 upsertMsg 是幂等的），确保 agent_messages 中的
    // agent_data.fields.date 等字段被 extractText 最新逻辑正确写入，修复历史误存的 JSON 字符串问题。
    try {
      await processRecord(configKey, config.type, record, config.brand);
    } catch (e) {
      logger.error({ configKey, recordId, err: e?.message }, 'process record failed');
    }

    if (!config.skipDedup) {
      _processedIds.add(dedupKey);
      if (_processedIds.size > DEDUP_MAX) {
        const oldest = Array.from(_processedIds).slice(0, DEDUP_CLEAN);
        oldest.forEach(id => _processedIds.delete(id));
      }
    }
  }

  if (newCount > 0) {
    logger.info({ configKey, newCount, total: allRecords.length, skipDedup: !!config.skipDedup }, 'bitable new record ids this poll');
  }
  _lastPollMeta[configKey] = {
    ok: true,
    at: Date.now(),
    truncated,
    recordsThisPoll: allRecords.length,
    newCountThisPoll: newCount
  };

  if (truncated) {
    void notifyAdminsDataIssue({
      alertType: 'bitable_poll_truncated',
      title: `飞书多维表同步可能被分页截断：${config?.name || configKey}`,
      lines: [
        `配置键：${configKey}`,
        `表名：${config?.name || '-'}`,
        `已抓取记录数：${allRecords.length}`,
        `页上限：${maxPages}`,
        '现象：本轮 has_more 仍为 true，但已到代码页上限，说明该表体量超过当前轮询窗口。',
        '影响：部分门店/当天数据可能未进入 feishu_generic_records 与结构化表，导致助手查询显示“暂无数据”。'
      ],
      dedupeKey: `bitable_poll_truncated_${configKey}`,
      priority: 'A',
      dedupeHours: 2
    }).catch(() => {});
  }
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
        fields: {
          store: extractText(fields['门店']) || extractText(fields['所属门店']),
          date: extractText(fields['记录日期']) || extractText(fields['提交时间']) || extractText(fields['日期']),
          table_no: extractText(fields['桌号']),
          satisfaction: extractText(fields['今天用餐是否满意']) || extractText(fields['满意度']),
          product_issue: extractText(fields['今天不满意的菜品']) || extractText(fields['产品不满意项']),
          service_issue: extractText(fields['服务不满意项']),
          rush_dish: extractText(fields['今天催菜内容']),
          reservation: extractText(fields['是否有预定']) || extractText(fields['是否有预订']),
          first_visit: extractText(fields['是否第一次来']),
          referral: extractText(fields['哪里知道我们的']),
          sat_reason: extractText(fields['满意的主要原因是什么']),
          unsat_reason: extractText(fields['不满意的主要原因是什么']),
          favorite_dishes: extractText(fields['今天比较喜欢的菜']),
          meal_reason: extractText(fields['今天吃饭的原因'])
        }
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
        fields: { store: extractText(fields['门店']), date: extractText(fields['提交时间'] || fields['日期']),
                  station: extractText(fields['档口']), responsible: extractText(fields['本档口值班负责人']),
                  inventory_check: extractText(fields['本档口库存检查']), cleaning_status: extractText(fields['本档口清洁卫生']),
                  equipment_status: extractText(fields['设备使用情况']), issues: extractText(fields['异常情况说明']) }
      });
      break;
    case 'opening_report':
      await upsertMsg('opening_report', '开档报告', {
        type: 'opening_report', recordId,
        fields: { store: extractText(fields['门店']), date: extractText(fields['记录日期'] || fields['提交时间'] || fields['日期']),
                  station: extractText(fields['岗位'] || fields['档口']), responsible: extractText(fields['本档口值班负责人']),
                  preparation_time: extractText(fields['开档时间']), cleaning_status: extractText(fields['本档口清洁卫生']),
                  equipment_status: extractText(fields['设备使用情况']), issues: extractText(fields['异常情况说明']) }
      });
      break;
    case 'meeting_report':
      await upsertMsg('meeting_report', '例会报告', {
        type: 'meeting_report', recordId,
        fields: {
          store: extractText(fields['门店'] || fields['所属门店']),
          date: extractText(
            fields['日期'] ||
              fields['记录日期'] ||
              fields['提交时间'] ||
              fields['会议日期'] ||
              fields['例会日期'] ||
              fields['会议时间']
          ),
          meeting_score: extractText(fields['得分'] || fields['评分'] || fields['例会得分'] || ''),
          meeting_type: extractText(fields['会议类型']),
          organizer: extractText(fields['组织人']),
          participants: extractText(fields['参会人员']),
          topics: extractText(fields['会议议题']),
          decisions: extractText(fields['决议事项']),
          action_items: extractText(fields['行动项'])
        }
      });
      break;
    case 'material_report': {
      const brandZh = brand === 'majixian' ? '马己仙' : brand === 'hongchao' ? '洪潮' : brand || '';
      const storeCell = extractText(fields['门店']) || extractText(fields['所属门店']);
      const dateCell = extractText(fields['日期'] ?? fields['收货日期']);
      const rawStoreField = fields['门店'] ?? fields['所属门店'];
      const rawDateField = fields['日期'] ?? fields['收货日期'];
      if (feishuCellPresent(rawStoreField) && !String(storeCell || '').trim()) {
        void notifyAdminsDataIssue({
          alertType: 'bitable_material_store_parse_empty',
          priority: 'C',
          title: '原料表轮询：飞书门店列有内容但解析后为空',
          lines: [
            `同步配置键：${configKey}`,
            `飞书记录 ID：${recordId}`,
            `品牌：${brandZh || brand || '—'}`,
            '说明：多维表里该列有格子内容，但程序读出的门店名称为空。常见原因为列类型是人员、查找引用、公式等，需在解析逻辑里单独兼容。'
          ],
          dedupeKey: `bitable_mat_store_${recordId}`,
          dedupeHours: 72
        }).catch(() => {});
      }
      if (feishuCellPresent(rawDateField) && !String(dateCell || '').trim()) {
        void notifyAdminsDataIssue({
          alertType: 'bitable_material_date_parse_empty',
          priority: 'C',
          title: '原料表轮询：飞书日期列有内容但解析后为空',
          lines: [
            `同步配置键：${configKey}`,
            `飞书记录 ID：${recordId}`,
            `品牌：${brandZh || brand || '—'}`,
            '说明：日期列可能是特殊类型，程序未能读出业务日期，需在解析逻辑里单独处理。'
          ],
          dedupeKey: `bitable_mat_date_${recordId}`,
          dedupeHours: 72
        }).catch(() => {});
      }
      await upsertMsg('material_report', `${brandZh || brand || ''}原料收货日报`, {
        type: 'material_report',
        recordId,
        brand: brandZh || brand || '',
        fields: {
          store: storeCell,
          date: dateCell,
          material_name:
            extractText(fields['原料名称']) || extractText(fields['品名']) || extractText(fields['物料名称']),
          supplier: extractText(fields['供应商']),
          quantity: extractText(fields['数量']),
          unit_price: extractText(fields['单价']),
          total_price: extractText(fields['总价']),
          quality_check: extractText(fields['质量检查']),
          receiver: extractText(fields['收货人'])
        }
      });
      break;
    }
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
    case 'actual_gross_margin': {
      const store = extractText(fields['门店']).trim();
      const marginDateRaw = fields['毛利日期'];
      const period = periodFromMarginDate(marginDateRaw);
      const received = parseMarginPercent(extractText(fields['实收毛利率']));
      const prePct = parseMarginPercent(extractText(fields['折前毛利率']));
      const legacy = parseMarginPercent(extractText(fields['毛利率']));
      const grossMarginForScore = received ?? prePct ?? legacy;
      await upsertMsg('actual_gross_margin', store ? `实际毛利率 · ${store}` : '实际毛利率记录', {
        type: 'actual_gross_margin', recordId, configKey,
        fields: {
          margin_date: extractText(marginDateRaw),
          store,
          turnover_before_discount: extractText(fields['折前营业额']),
          actual_revenue: extractText(fields['实收营业额']),
          pre_discount_margin_pct: extractText(fields['折前毛利率']),
          actual_received_margin_pct: extractText(fields['实收毛利率']),
          gross_margin_rate: extractText(fields['折前毛利率'] || fields['毛利率']),
          consumables_ratio: extractText(fields['耗材占比率']),
          inventory_amount_month: extractText(fields['本月库存金额']),
          purchase_non_quanjincheng: extractText(fields['非权金城采购金额']),
          purchase_quanjincheng: extractText(fields['权金城采购金额']),
          purchase_consumables: extractText(fields['耗材采购金额'])
        }
      });
      if (store && period && grossMarginForScore != null) {
        await upsertMonthlyMarginRow(store, period, grossMarginForScore);
      }
      break;
    }
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
    const taskR = await query(`SELECT task_id, source, status FROM master_tasks WHERE task_id = $1 LIMIT 1`, [taskId]).catch(() => ({ rows: [] }));
    const task = taskR.rows?.[0];
    const isPllm = String(task?.source || '') === 'proactive_llm';
    const replyNorm = String(reply || '').trim();
    if (isPllm && replyNorm) {
      if (/不适合|不执行|暂不执行|不采用|不落地/.test(replyNorm)) {
        await applyPllmDecision(taskId, 'not_suitable', 'feishu_reply', replyNorm).catch(() => {});
      } else if (/执行|开始执行|已执行|安排执行|马上做/.test(replyNorm)) {
        await applyPllmDecision(taskId, 'execute', 'feishu_reply', replyNorm).catch(() => {});
      } else {
        await query(
          `UPDATE master_tasks
           SET response_text = COALESCE(NULLIF($2, ''), response_text),
               updated_at = NOW()
           WHERE task_id = $1`,
          [taskId, replyNorm]
        ).catch(() => {});
      }
    }

    // Update master_tasks status if reply provided
    if (reply) {
      const st = String(status || '').trim();
      await query(
        `UPDATE master_tasks SET status = CASE WHEN $1 = '已处理' THEN 'closed' WHEN $1 = '已回复' THEN 'pending_response' ELSE status END,
         closed_at = CASE WHEN $1 = '已处理' THEN NOW() ELSE closed_at END,
         response_text = COALESCE(NULLIF($3, ''), response_text),
         updated_at = NOW()
         WHERE task_id = $2`,
        [status, taskId, reply]
      );
      if (st === '已处理') {
        setImmediate(() => {
          import('./proactive-v2/proactive-task-outcome-on-close.js')
            .then((m) => m.scheduleProactiveOutcomeOnClose(taskId, { newStatus: 'closed' }))
            .catch(() => {});
        });
      }
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
/** 飞书单元格是否有「非空」原始值（与 extractText 结果无关，用于发现解析失败） */
function feishuCellPresent(val) {
  if (val == null) return false;
  if (typeof val === 'string') return val.trim().length > 0;
  if (typeof val === 'number') return Number.isFinite(val);
  if (Array.isArray(val)) return val.length > 0;
  return typeof val === 'object';
}

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
  if (val?.text != null) return String(val.text);
  if (val?.name != null) return String(val.name);
  // 飞书日期类型字段：{ date: "YYYY-MM-DD" } 或 { timestamp: 1744473600000 }
  // 或 { value: 1744473600000, type: "timestamp" } 等格式，统一提取可解析的值
  if (val?.date != null) return String(val.date);
  if (val?.timestamp != null) return String(val.timestamp);
  if (val?.value != null && typeof val.value !== 'object') return String(val.value);
  return JSON.stringify(val);
}

function periodFromMarginDate(raw) {
  const t = extractText(raw).trim();
  if (!t) return '';
  const n = Number(t);
  if (Number.isFinite(n) && n > 1e11) {
    const ms = n > 1e12 ? n : n * 1000;
    const sh = new Date(ms).toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(sh)) return sh.slice(0, 7);
  }
  const m = t.match(/(\d{4})[年/-\s](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  const m2 = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}`;
  return '';
}

function parseMarginPercent(s) {
  return parseFeishuRatioOrPercentString(String(s || '').replace(/%/g, '').replace(/,/g, '').trim());
}

function inferBrandFromStore(store) {
  const s = String(store || '');
  if (s.includes('马己仙')) return '马己仙';
  return '洪潮';
}

/** 与 HRMS 评分同源：写入 monthly_margins（表不存在时静默跳过） */
async function upsertMonthlyMarginRow(store, period, actualMargin) {
  const brand = inferBrandFromStore(store);
  try {
    await query(
      `INSERT INTO monthly_margins (store, brand, period, actual_margin, source)
       VALUES ($1, $2, $3, $4, 'feishu_bitable_actual_margin')
       ON CONFLICT (store, brand, period)
       DO UPDATE SET actual_margin = EXCLUDED.actual_margin, source = EXCLUDED.source`,
      [store, brand, period, actualMargin]
    );
  } catch (e) {
    const msg = String(e?.message || '');
    const code = String(e?.code || '');
    if (code === '42P01' || msg.includes('monthly_margins')) {
      logger.debug({ err: msg }, 'monthly_margins not available, skipped');
    } else {
      logger.warn({ err: msg, store, period }, 'monthly_margins upsert failed');
    }
  }
}

// ── Main poll-all scheduler ──
const POLL_ORDER = [
  'ops_checklist', 'bad_review', 'closing_reports', 'opening_reports',
  'meeting_reports', 'material_majixian', 'material_hongchao', 'table_visit',
  'loss_report', 'actual_gross_margin', 'task_responses'
];

const _lastPollTime = {};
/** 每表最近一次轮询结果（供管理端「同步新鲜度」与排障） */
const _lastPollMeta = {};
/** 本轮 pollAll 因间隔未到而跳过拉取（与「同步坏了」区分） */
const _lastPollSkipMeta = {};
let _pollRunning = false;

export function getBitableLastPollMeta() {
  const keys = new Set([...Object.keys(_lastPollMeta), ...Object.keys(_lastPollSkipMeta)]);
  const out = {};
  for (const k of keys) {
    const base = { ...(_lastPollMeta[k] || {}) };
    const sk = _lastPollSkipMeta[k];
    if (sk) {
      base.pollSkipped = true;
      base.skipAt = sk.skipAt;
      base.skipReason = sk.reason;
    }
    out[k] = base;
  }
  return out;
}

export async function pollAllBitableTables() {
  const featureFlags = await getConfig('feature_flags').catch(() => null) || {};
  if (featureFlags.bitable_polling === false) {
    logger.info('bitable polling disabled by feature flag');
    return;
  }
  // Prevent overlapping poll cycles
  if (_pollRunning) {
    logger.info('previous polling cycle still running, skip this tick');
    return;
  }
  _pollRunning = true;
  try {
    const known = new Set(POLL_ORDER);
    const finalKeys = [
      ...POLL_ORDER.filter(k => BITABLE_CONFIGS[k]),
      ...Object.keys(BITABLE_CONFIGS).filter(k => !known.has(k) && BITABLE_CONFIGS[k]?.type !== 'task_response')
    ];
    const now = Date.now();
    for (const configKey of finalKeys) {
      const config = BITABLE_CONFIGS[configKey];
      const interval = config?.pollingInterval || 120000;
      const lastTime = _lastPollTime[configKey] || 0;
      if (now - lastTime < interval) {
        _lastPollSkipMeta[configKey] = { skipAt: Date.now(), reason: 'polling_interval' };
        continue;
      }
      _lastPollTime[configKey] = now;
      try {
        await pollBitableTable(configKey);
      } catch (e) {
        logger.error({ configKey, err: e?.message }, 'bitable poll error');
      }
      // Yield to event loop between tables — critical for webhook responsiveness
      await new Promise(r => setImmediate(r));
    }
  } finally {
    _pollRunning = false;
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
