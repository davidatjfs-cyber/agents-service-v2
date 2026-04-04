/**
 * Random Inspection Scheduler — 随机抽检
 *
 * 仅以 agent_v2_configs.config_key = **random_inspections**（数组）为准，由 Agent Ops 控制台维护。
 * 可选字段：enabled、replyRequirements / replyHint（展示在任务卡上）。
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getConfig } from './config-service.js';
import { sendCard, sendText } from './feishu-client.js';
import { formatTaskCardAuditSection } from './task-reply-audit-hint.js';

const _timers = new Map();
const _status = new Map();

// ── helpers ──

function randomInspectionsGloballyOff() {
  const v = String(process.env.ENABLE_RANDOM_INSPECTIONS || '').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

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
  if (randomInspectionsGloballyOff()) {
    logger.info('random-inspection: ENABLE_RANDOM_INSPECTIONS off, skip send');
    return;
  }
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
  // 按配置角色顺序排列，便于「主责任人」与定时任务一致（先勾选的角色优先）
  const staffSorted = [];
  for (const role of roles) {
    for (const u of staff) {
      if (u.role === role && u.username && !staffSorted.find((x) => x.username === u.username)) staffSorted.push(u);
    }
  }
  const usernames = staffSorted.map((u) => u.username).filter(Boolean);
  let assigneeUsername = '';
  let assigneeRole = roles[0] || 'store_manager';
  for (const role of roles) {
    const u = staff.find((s) => s.role === role);
    if (u?.username) {
      assigneeUsername = u.username;
      assigneeRole = role;
      break;
    }
  }

  if (config?.enabled === false) {
    logger.info({ type: config?.type }, 'random-inspection: item disabled, skip send');
    return;
  }

  const taskType = String(config?.type || '食安抽检').trim();
  const taskDesc = String(config?.description || '请完成本次食安抽检').trim();
  const replyExtra = String(config?.replyRequirements || config?.replyHint || '').trim();
  const auditSection = formatTaskCardAuditSection(replyExtra);
  const timeWindow = Math.max(1, Math.floor(Number(config?.timeWindow) || 15));
  const timeNow = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const deadlineAt = new Date(Date.now() + timeWindow * 60000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  // 先生成任务 ID，再下发卡片，保证后续“直接回复”可精确落库到该任务
  const taskId = `INSP-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;

  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `🔔 随机抽检 · ${taskType}` }, template: 'yellow' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**门店**：${pickedStore}\n**类型**：${taskType}\n**任务**：${taskDesc}` } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: `**时间**：${timeNow}\n**时限**：${timeWindow}分钟内完成\n**截止**：${deadlineAt}` } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: '📸 请在本对话直接回复：**文字说明**（建议附照片）。' } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: auditSection } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `小年 · ${taskType} · 任务ID：${taskId.slice(0, 18)}` }] }
    ]
  };

  const textFallback = `🔔 随机抽检通知\n\n门店：${pickedStore}\n类型：${taskType}\n任务：${taskDesc}\n时间：${timeNow}\n时限：${timeWindow}分钟内完成\n截止：${deadlineAt}\n\n请在本对话回复文字说明（建议附照片）。\n${auditSection.replace(/\*\*/g, '')}`;

  if (!usernames.length) {
    logger.warn({ store: pickedStore, roles }, 'random-inspection: no staff found');
    return;
  }

  const sentMessageIds = [];
  const sentOpenIds = [];

  for (const username of usernames) {
    try {
      const openId = await lookupOpenId(username);
      if (!openId) continue;
      sentOpenIds.push(openId);
      // Try card first, fallback to text
      try {
        const r = await sendCard(openId, card);
        const msgId = r?.data?.message_id
          || r?.data?.data?.message_id
          || r?.data?.data?.message_id;
        if (msgId) sentMessageIds.push(msgId);
      } catch {
        await sendText(openId, '小年：' + textFallback, 'open_id').catch(() => {});
      }
    } catch (e) {
      logger.warn({ err: e?.message, username }, 'random-inspection: send failed');
    }
  }

  // Create master_task
  try {
      await query(
        `INSERT INTO master_tasks (task_id, status, source, category, store, assignee_username, assignee_role, title, detail, source_data, feishu_msg_ids, dispatched_at, timeout_at, remind_count, last_reminder_at)
         VALUES ($1, 'pending_response', 'random_inspection', $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, NOW(), NOW() + INTERVAL '${timeWindow} minutes', 0, NOW())`,
        [
          taskId,
          taskType,
          pickedStore,
          assigneeUsername || usernames[0] || '',
          assigneeRole,
          `${pickedStore} · ${taskType}`,
          `类型：${taskType}\n任务：${taskDesc}\n时限：${timeWindow}分钟`,
          JSON.stringify({ taskType, taskDesc, assignee_open_ids: [...new Set(sentOpenIds)] }),
          JSON.stringify(sentMessageIds)
        ]
      );
    logger.info({ taskId, store: pickedStore, type: taskType }, 'random-inspection: task created');
  } catch (e) {
    logger.warn({ err: e?.message }, 'random-inspection: failed to create master_task');
  }

  logger.info({ store: pickedStore, usernames, type: taskType }, '✅ random-inspection sent');
}

// ── scheduling ──

function clearTimerKey(key) {
  const prev = _timers.get(key);
  if (prev) clearTimeout(prev);
  _timers.delete(key);
}

/**
 * 先按随机间隔 sleep，再执行；执行前再次读 DB 对应下标，避免控制台清空后仍用旧闭包无限发。
 */
function scheduleNext(key, index) {
  (async () => {
    if (randomInspectionsGloballyOff()) {
      clearTimerKey(key);
      _status.delete(key);
      return;
    }
    const raw = await getConfig('random_inspections');
    const inspections = Array.isArray(raw) ? raw : [];
    const config = inspections[index];
    if (!config || config.enabled === false || !String(config.type || '').trim()) {
      clearTimerKey(key);
      _status.delete(key);
      logger.info({ key, index }, 'random-inspection: config slot empty/disabled — stop');
      return;
    }

    const minH = Math.max(1, Number(config?.intervalMinHours) || 2);
    const maxH = Math.max(minH, Number(config?.intervalMaxHours) || 4);
    const intervalH = minH + Math.random() * (maxH - minH);
    let nextExec = new Date(Date.now() + intervalH * 3600000);
    const cstH = Number(nextExec.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false }));
    if (cstH < 8 || cstH >= 23) {
      const hoursUntilNext = cstH >= 23 ? (24 - cstH + 8) : (8 - cstH);
      const base = new Date(nextExec.getTime() + hoursUntilNext * 3600000);
      base.setMinutes(0, 0, 0);
      nextExec = new Date(base.getTime() + Math.random() * 6 * 3600000);
    }
    const ms = Math.max(1000, nextExec.getTime() - Date.now());

    const status = _status.get(key) || { key, runCount: 0, lastRunAt: null, lastError: null };
    status.nextExecutionAt = nextExec.toISOString();
    _status.set(key, status);

    clearTimerKey(key);
    const timer = setTimeout(async () => {
      if (randomInspectionsGloballyOff()) {
        clearTimerKey(key);
        _status.delete(key);
        return;
      }
      if (!isWorkingHour()) {
        logger.info({ key }, 'random-inspection: outside working hours, reschedule');
        scheduleNext(key, index);
        return;
      }
      const raw2 = await getConfig('random_inspections');
      const list2 = Array.isArray(raw2) ? raw2 : [];
      const cfg2 = list2[index];
      if (!cfg2 || cfg2.enabled === false || !String(cfg2.type || '').trim()) {
        clearTimerKey(key);
        _status.delete(key);
        logger.info({ key, index }, 'random-inspection: config removed before run — stop chain');
        return;
      }
      logger.info({ key, index }, 'random-inspection: executing');
      const st = _status.get(key) || { key, runCount: 0, lastRunAt: null, lastError: null };
      st.lastRunAt = new Date().toISOString();
      st.runCount = (st.runCount || 0) + 1;
      try {
        await sendSafetyCheck(cfg2);
        st.lastError = null;
      } catch (e) {
        st.lastError = e?.message;
        logger.error({ err: e?.message, key }, 'random-inspection: execution failed');
      }
      _status.set(key, st);
      scheduleNext(key, index);
    }, ms);
    _timers.set(key, timer);
    logger.info({ key, nextExec: nextExec.toISOString(), intervalH: intervalH.toFixed(1) }, 'random-inspection: scheduled');
  })().catch((e) => logger.error({ err: e?.message, key }, 'random-inspection: scheduleNext failed'));
}

// ── public API ──

export async function startRandomInspections() {
  for (const [, timer] of _timers) clearTimeout(timer);
  _timers.clear();
  _status.clear();

  if (randomInspectionsGloballyOff()) {
    logger.info('random-inspection: ENABLE_RANDOM_INSPECTIONS off — no timers');
    return;
  }

  const raw = await getConfig('random_inspections');
  const inspections = Array.isArray(raw) ? raw : [];
  if (!inspections.length) {
    logger.info('random-inspection: random_inspections empty or missing, skipping (no legacy fallback)');
    return;
  }

  let started = 0;
  for (let i = 0; i < inspections.length; i++) {
    const insp = inspections[i];
    if (insp?.enabled === false) continue;
    const type = String(insp?.type || '').trim();
    if (!type) continue;
    const store = String(insp?.store || '').trim();
    const brand = String(insp?.brand || '').trim();
    const key = `随机抽检_${store || brand || '全门店'}_${type}_${i + 1}`;
    scheduleNext(key, i);
    started += 1;
  }

  logger.info({ slots: inspections.length, started }, '✅ Random inspection scheduler started');
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
