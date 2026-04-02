/**
 * Random Inspection Scheduler — 随机抽检
 * Ported from V1 agents.js
 *
 * Reads config from agent_v2_configs.ops_scheduled_tasks:
 * {
 *   "randomInspections": [
 *     { "type": "食安抽检", "description": "...", "brand": "洪潮",
 *       "intervalMinHours": 2, "intervalMaxHours": 4, "timeWindow": 15,
 *       "assigneeRoles": ["store_manager","store_production_manager"] }
 *   ]
 * }
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getConfig } from './config-service.js';
import { sendCard, sendText } from './feishu-client.js';

const _timers = new Map();
const _status = new Map();

// ── helpers ──

function storeKey(v) { return String(v || '').trim().toLowerCase().replace(/\s+/g, ''); }

function sameStore(a, b) {
  const x = storeKey(a), y = storeKey(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function isWorkingHour() {
  const h = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false }));
  return h >= 8 && h < 23;
}

// ── get active stores from DB ──

async function getActiveStores() {
  try {
    const r = await query(`SELECT DISTINCT store FROM daily_reports WHERE date >= CURRENT_DATE - 30 AND store IS NOT NULL`);
    return r.rows.map(x => x.store);
  } catch { return []; }
}

async function getStoreStaff(storeName, roles) {
  try {
    const r = await query(
      `SELECT username, role, store FROM feishu_users WHERE registered = true`,
    );
    return (r.rows || []).filter(u => sameStore(u.store, storeName) && roles.includes(u.role));
  } catch { return []; }
}

async function lookupOpenId(username) {
  try {
    const r = await query(`SELECT open_id FROM feishu_users WHERE username = $1 AND registered = true LIMIT 1`, [username]);
    return r.rows?.[0]?.open_id || null;
  } catch { return null; }
}

// ── get store mapping (brand → stores) ──

async function getStoreMapping() {
  return await getConfig('store_mapping');
}

async function getStoresForBrand(brand) {
  const stores = await getActiveStores();
  const mapping = await getStoreMapping();
  const brands = mapping?.store_brands || {};
  // brands: { "洪潮大宁久光店": "洪潮", ... }
  return stores.filter(s => {
    const b = brands[s];
    if (b && b === brand) return true;
    // fuzzy: store name includes brand
    return storeKey(s).includes(storeKey(brand));
  });
}

// ── send safety check card ──

async function sendSafetyCheck(config) {
  const configStore = String(config?.store || '').trim();
  const configBrand = String(config?.brand || '').trim();

  let targetStores;
  if (configStore) {
    const all = await getActiveStores();
    targetStores = all.filter(s => sameStore(s, configStore));
  } else if (configBrand) {
    targetStores = await getStoresForBrand(configBrand);
  } else {
    targetStores = await getActiveStores();
  }

  if (!targetStores.length) {
    logger.info({ store: configStore, brand: configBrand }, 'random-inspection: no stores matched');
    return;
  }

  // Pick random store
  const pickedStore = targetStores[Math.floor(Math.random() * targetStores.length)];
  const roles = Array.isArray(config?.assigneeRoles) && config.assigneeRoles.length
    ? config.assigneeRoles
    : ['store_manager', 'store_production_manager'];

  const staff = await getStoreStaff(pickedStore, roles);
  const usernames = [...new Set(staff.map(u => u.username).filter(Boolean))];

  const taskType = String(config?.type || '食安抽检').trim();
  const taskDesc = String(config?.description || '请完成本次食安抽检').trim();
  const timeWindow = Math.max(1, Math.floor(Number(config?.timeWindow) || 15));
  const timeNow = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const deadlineAt = new Date(Date.now() + timeWindow * 60000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `🔔 随机抽检 · ${taskType}` }, template: 'yellow' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**门店**：${pickedStore}\n**类型**：${taskType}\n**任务**：${taskDesc}` } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: `**时间**：${timeNow}\n**时限**：${timeWindow}分钟内完成\n**截止**：${deadlineAt}` } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: '📸 请拍照发送至本对话。' } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `小年 · ${taskType}` }] }
    ]
  };

  const textFallback = `🔔 随机抽检通知\n\n门店：${pickedStore}\n类型：${taskType}\n任务：${taskDesc}\n时间：${timeNow}\n时限：${timeWindow}分钟内完成\n截止：${deadlineAt}\n\n请拍照发送至本对话。`;

  if (!usernames.length) {
    logger.warn({ store: pickedStore, roles }, 'random-inspection: no staff found');
    return;
  }

  for (const username of usernames) {
    try {
      const openId = await lookupOpenId(username);
      if (!openId) continue;
      // Try card first, fallback to text
      try {
        await sendCard(openId, card);
      } catch {
        await sendText(null, '小年：' + textFallback, openId).catch(() => {});
      }
    } catch (e) {
      logger.warn({ err: e?.message, username }, 'random-inspection: send failed');
    }
  }

  // Create master_task
  try {
    const taskId = `INSP-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
    await query(
      `INSERT INTO master_tasks (task_id, status, source, category, store, assignee_username, assignee_role, title, detail, dispatched_at, timeout_at)
       VALUES ($1, 'pending_response', 'random_inspection', $2, $3, $4, $5, $6, $7, NOW(), NOW() + INTERVAL '${timeWindow} minutes')`,
      [taskId, taskType, pickedStore, usernames[0], roles[0],
       `${pickedStore} ${taskType}`, `类型：${taskType}\n任务：${taskDesc}\n时限：${timeWindow}分钟`]
    );
    logger.info({ taskId, store: pickedStore, type: taskType }, 'random-inspection: task created');
  } catch (e) {
    logger.warn({ err: e?.message }, 'random-inspection: failed to create master_task');
  }

  logger.info({ store: pickedStore, usernames, type: taskType }, '✅ random-inspection sent');
}

// ── scheduling ──

function scheduleNext(key, config) {
  const minH = Math.max(1, Number(config?.intervalMinHours) || 2);
  const maxH = Math.max(minH, Number(config?.intervalMaxHours) || 4);
  const intervalH = minH + Math.random() * (maxH - minH);
  let nextExec = new Date(Date.now() + intervalH * 3600000);

  // Clamp to working hours 08:00-23:00 CST
  const cstH = Number(nextExec.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false }));
  if (cstH < 8 || cstH >= 23) {
    const hoursUntilNext = cstH >= 23 ? (24 - cstH + 8) : (8 - cstH);
    const base = new Date(nextExec.getTime() + hoursUntilNext * 3600000);
    base.setMinutes(0, 0, 0);
    nextExec = new Date(base.getTime() + Math.random() * 6 * 3600000);
  }

  const ms = nextExec.getTime() - Date.now();
  const status = _status.get(key) || { key, runCount: 0, lastRunAt: null, lastError: null };
  status.nextExecutionAt = nextExec.toISOString();
  _status.set(key, status);

  const timer = setTimeout(async () => {
    if (!isWorkingHour()) {
      logger.info({ key }, 'random-inspection: skipping outside working hours');
      scheduleNext(key, config);
      return;
    }
    logger.info({ key }, 'random-inspection: executing');
    const st = _status.get(key) || {};
    st.lastRunAt = new Date().toISOString();
    st.runCount = (st.runCount || 0) + 1;
    try {
      await sendSafetyCheck(config);
      st.lastError = null;
    } catch (e) {
      st.lastError = e?.message;
      logger.error({ err: e?.message, key }, 'random-inspection: execution failed');
    }
    _status.set(key, st);
    scheduleNext(key, config);
  }, ms);

  _timers.set(key, timer);
  logger.info({ key, nextExec: nextExec.toISOString(), intervalH: intervalH.toFixed(1) }, 'random-inspection: scheduled');
}

// ── public API ──

export async function startRandomInspections() {
  // Clear existing timers
  for (const [, timer] of _timers) clearTimeout(timer);
  _timers.clear();
  _status.clear();

  const cfg = await getConfig('ops_scheduled_tasks');
  const inspections = cfg?.randomInspections;
  if (!Array.isArray(inspections) || !inspections.length) {
    logger.info('random-inspection: no randomInspections configured, skipping');
    return;
  }

  for (let i = 0; i < inspections.length; i++) {
    const insp = inspections[i];
    const type = String(insp?.type || '').trim();
    if (!type) continue;
    const store = String(insp?.store || '').trim();
    const brand = String(insp?.brand || '').trim();
    const key = `随机抽检_${store || brand || '全门店'}_${type}_${i + 1}`;
    scheduleNext(key, insp);
  }

  logger.info({ count: inspections.length }, '✅ Random inspection scheduler started');
}

export function getRandomInspectionStatus() {
  return {
    started: _timers.size > 0,
    activeTimers: _timers.size,
    tasks: Array.from(_status.entries()).map(([k, v]) => ({ key: k, ...v }))
  };
}

export async function triggerManualInspection(config) {
  await sendSafetyCheck(config || {});
}
