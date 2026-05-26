/**
 * 每日巡检任务调度 — 读取 agent_v2_configs.daily_inspections，按配置时间与频率执行。
 * 此前仅前端落库，无任何后端 cron，导致自定义时间（如 15:51）永不触发。
 */
import cron from 'node-cron';
import { runWithCronLog } from '../utils/cron-run-monitor.js';
import { logger } from '../utils/logger.js';
import { query } from '../utils/db.js';
import { getConfig } from './config-service.js';
import { runAnomalyChecks } from './anomaly-engine.js';
import { sendText, sendCard, feishuOutboundMessageId } from './feishu-client.js';
import { resolveSingleScoringUser } from '../utils/scoring-assignee.js';
import { formatTaskCardAuditSection } from './task-reply-audit-hint.js';
import { createUnifiedTask } from './task-orchestrator.js';
import { resolveDutyBoundRecipients } from './store-duty-bindings.js';

/** 定时任务多角色时：先店长、再出品经理，其余保持配置顺序 */
const PRIMARY_ROLE_ORDER = ['store_manager', 'store_production_manager', 'front_manager'];

function orderedAssigneeRoles(roleList) {
  const rl = Array.isArray(roleList) && roleList.length ? roleList : ['store_manager'];
  const set = new Set(rl);
  return [...PRIMARY_ROLE_ORDER.filter((r) => set.has(r)), ...rl.filter((r) => !PRIMARY_ROLE_ORDER.includes(r))];
}

/**
 * 巡检摘要卡：每个门店只绑定一名主责任人（与绩效/执行力「岗位唯一」一致）。
 */
async function resolvePrimaryPatrolAssignee(store, roleList) {
  const ordered = orderedAssigneeRoles(roleList);
  const dutyRecipients = await resolveDutyBoundRecipients({
    store,
    category: 'food_safety',
    fallbackRoles: ordered
  });
  if (dutyRecipients.length) {
    const roleMatch = new Set(ordered.map((r) => r.toLowerCase()));
    for (const row of dutyRecipients) {
      const rowRole = String(row.role || '').trim().toLowerCase();
      if (rowRole && roleMatch.has(rowRole) && String(row.open_id || '').trim()) {
        return {
          username: String(row.username || '').trim(),
          role: String(row.role || ordered[0] || 'store_manager').trim(),
          open_id: String(row.open_id).trim()
        };
      }
    }
  }
  for (const role of ordered) {
    const u = await resolveSingleScoringUser(store, role);
    if (!u?.username || String(u.username).startsWith('__periodic')) continue;
    const r = await query(
      `SELECT username, role, open_id FROM feishu_users
       WHERE registered = true AND open_id IS NOT NULL AND LOWER(username) = LOWER($1)
       LIMIT 1`,
      [u.username]
    ).catch(() => ({ rows: [] }));
    const row = r.rows?.[0];
    if (row?.open_id) {
      return {
        username: String(row.username || u.username).trim(),
        role: String(row.role || role).trim(),
        open_id: String(row.open_id).trim()
      };
    }
  }
  return null;
}

/**
 * 非巡检定时卡：每个岗位类型各发一名规范责任人（马己仙出品仅黎永荣主号，不含观察号）。
 */
async function resolveScheduledCardRecipients(store, roleList) {
  const ordered = orderedAssigneeRoles(roleList);
  const dutyRecipients = await resolveDutyBoundRecipients({
    store,
    category: 'ops',
    fallbackRoles: ordered
  });
  if (dutyRecipients.length) {
    const roleMatch = new Set(ordered.map((r) => r.toLowerCase()));
    const filtered = dutyRecipients.filter((row) => {
      const rowRole = String(row.role || '').trim().toLowerCase();
      return rowRole && roleMatch.has(rowRole);
    });
    if (filtered.length) {
      return filtered
        .filter((row) => String(row.open_id || '').trim())
        .map((row) => ({
          username: String(row.username || '').trim(),
          role: String(row.role || '').trim() || ordered[0] || 'store_manager',
          open_id: String(row.open_id || '').trim()
        }));
    }
  }
  const out = [];
  const seenOpen = new Set();
  for (const role of ordered) {
    const u = await resolveSingleScoringUser(store, role);
    if (!u?.username || String(u.username).startsWith('__periodic')) continue;
    const r = await query(
      `SELECT username, role, open_id FROM feishu_users
       WHERE registered = true AND open_id IS NOT NULL AND LOWER(username) = LOWER($1)
       LIMIT 1`,
      [u.username]
    ).catch(() => ({ rows: [] }));
    const row = r.rows?.[0];
    if (!row?.open_id) continue;
    const oid = String(row.open_id).trim();
    if (seenOpen.has(oid)) continue;
    seenOpen.add(oid);
    out.push({
      username: String(row.username || u.username).trim(),
      role: String(row.role || role).trim(),
      open_id: oid
    });
  }
  return out;
}

const DEDUPE_MS = 120_000;
const _dedupe = new Map();

function storeKey(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}
function sameStore(a, b) {
  const x = storeKey(a);
  const y = storeKey(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/** 上海时区 HH:mm */
function getShanghaiHM() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const h = parts.find((p) => p.type === 'hour')?.value || '00';
  const m = parts.find((p) => p.type === 'minute')?.value || '00';
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

function getShanghaiWeekday() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' });
}

function getShanghaiDayOfMonth() {
  const d = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' });
  return parseInt(d.slice(8, 10), 10) || 1;
}

/** 双周：仅周一触发，且按日历周交替（近似） */
function biweeklyMondayOk() {
  const ymd = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
  const [y, m, d] = ymd.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const weeks = Math.floor(t / 604800000);
  return weeks % 2 === 0;
}

function normalizeTime(t) {
  if (!t) return '';
  const s = String(t).trim();
  if (s.length >= 5) return s.slice(0, 5);
  return s;
}

/** 跳过明显测试/Agent V1 残留类巡检项（可通过 DISABLE_TEST_DAILY_INSPECTIONS=0 关闭过滤） */
function shouldSkipTestLikeDailyInspectionItem(item, label, desc) {
  if (process.env.DISABLE_TEST_DAILY_INSPECTIONS === '0') return false;
  const blob = `${label || ''} ${desc || ''} ${String(item?.type || '')} ${item?.replyRequirements || ''} ${item?.replyHint || ''}`;
  return /(测试\s*112233|112233\s*检查|agent[\s_-]*v1)/i.test(blob);
}

/** 按标签关键字跳过仍留在 DB 里的早期定时项，例如 LEGACY_SCHEDULED_TASK_SKIP_LABELS=试味,晨检 */
function shouldSkipLegacyScheduledLabels(item, label, desc) {
  const raw = String(process.env.LEGACY_SCHEDULED_TASK_SKIP_LABELS || '').trim();
  if (!raw || raw === '0') return false;
  const parts = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return false;
  const blob = `${label || ''} ${desc || ''} ${String(item?.type || '')}`;
  return parts.some((p) => p && blob.includes(p));
}

/** 早期「近7天 N 条原料异常」类定时项：非 BI anomaly_triggers，不应再写入 master_tasks */
function shouldSkipDeprecatedMaterialRollupSchedule(item, label, desc) {
  const blob = `${label || ''} ${desc || ''} ${String(item?.type || '')} ${item?.replyRequirements || ''} ${item?.replyHint || ''}`;
  return /近\s*\d+\s*天.*原料|条原料.*异常|原料异常反馈/i.test(blob);
}

function frequencyMatches(freq, type) {
  const f = String(freq || 'daily').toLowerCase();
  const t = String(type || '').toLowerCase();

  // 根据 type 强制约束触发日，避免 type=weekly 但 frequency=daily 导致每天跑周度异常
  if (t === 'weekly' || t === 'patrol_am' || t === 'patrol_pm') {
    // patrol 是日频，weekly 类型只在周一触发
    if (t === 'weekly') {
      const wday = getShanghaiWeekday();
      return wday === 'Mon';
    }
    // patrol 每天可触发
    return true;
  }
  if (t === 'monthly') {
    return getShanghaiDayOfMonth() === 1;
  }
  if (t === 'biweekly') {
    const wday = getShanghaiWeekday();
    if (wday !== 'Mon') return false;
    return biweeklyMondayOk();
  }

  // 非内置类型，按 frequency 字段判断
  if (f === 'daily') return true;
  if (f === 'weekly') {
    const wday = getShanghaiWeekday();
    return wday === 'Mon';
  }
  if (f === 'biweekly') {
    const wday = getShanghaiWeekday();
    if (wday !== 'Mon') return false;
    return biweeklyMondayOk();
  }
  if (f === 'monthly') return getShanghaiDayOfMonth() === 1;
  return true;
}

async function fetchActiveStores() {
  const r = await query(
    `SELECT DISTINCT store FROM daily_reports WHERE date >= CURRENT_DATE - 30 AND store IS NOT NULL`
  );
  return (r.rows || []).map((x) => x.store).filter(Boolean);
}

async function resolveStores(item) {
  const all = await fetchActiveStores();
  const s = String(item.store || '').trim();
  const b = String(item.brand || '').trim();
  if (s) {
    const hit = all.filter((st) => sameStore(st, s));
    return hit.length ? hit : [s];
  }
  if (b) {
    const mapping = await getConfig('store_mapping');
    const brands = mapping?.store_brands || {};
    return all.filter((st) => {
      const sb = brands[st];
      if (sb && sb === b) return true;
      return storeKey(st).includes(storeKey(b));
    });
  }
  return all;
}

/**
 * 内置类型直接返回（不依赖 DB），自定义类型从 DB 的 rhythmItems 数组查找。
 * 避免 DB 旧格式（无 rhythmItems）导致回退到 key 原文（如 patrol_pm）。
 */
const BUILTIN_TYPE_META = {
  morning: { label: '晨检推送', desc: '每日发送门店晨检提醒' },
  patrol_am: { label: '上午巡检', desc: '午市前巡检推送' },
  patrol_pm: { label: '下午巡检', desc: '晚市前巡检推送' },
  eod: { label: '日终报告', desc: '日终运营数据汇总推送' },
  weekly: { label: '周报', desc: '周度运营分析报告' },
  monthly: { label: '月评', desc: '月度绩效评估报告' },
};

async function lookupRhythmMeta(typeKey) {
  if (BUILTIN_TYPE_META[typeKey]) return { ...BUILTIN_TYPE_META[typeKey] };
  try {
    const cfg = await getConfig('rhythm_schedule');
    const items = Array.isArray(cfg?.rhythmItems) ? cfg.rhythmItems : [];
    const it = items.find((x) => x.key === typeKey);
    if (it) return { label: it.label || typeKey, desc: it.desc || '' };
  } catch (_e) { /* ignore */ }
  // typeKey 以 custom_ 开头时截取人类可读部分
  const readable = typeKey.startsWith('custom_') ? typeKey.replace(/^custom_\d+/, '自定义任务') : typeKey;
  return { label: readable, desc: '' };
}

/**
 * 构建定时任务卡片（与随机抽检卡片格式一致，含时限和截止时间）
 */
function buildScheduledCard({ store, label, desc, taskId, timeNow, replyExtra }) {
  // 截止时间 = 当前时间 + 1小时
  const now = new Date();
  const deadlineMs = now.getTime() + 60 * 60 * 1000;
  const deadline = new Date(deadlineMs).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const auditSection = formatTaskCardAuditSection(replyExtra);
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `🔔 定时任务 · ${label}` }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**门店**：${store}\n**任务**：${desc || '请按要求完成并反馈'}` } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: `**发出时间**：${timeNow}\n**时限**：1 小时\n**截止时间**：${deadline}` } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: '📸 请在截止时间前于本对话回复：**文字说明**（建议附照片），超时将记录至绩效。' } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: auditSection } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `小年 · ${label} · ${taskId ? '任务ID：' + taskId.slice(0, 16) : timeNow}` }] }
    ]
  };
}

/**
 * 向所有匹配门店+角色的用户发卡片/文本。
 * 返回 { count: number, msgIds: string[] } — msgIds 供调用方写入 master_tasks.feishu_msg_ids。
 */
async function pingUsersForStores(stores, roles, cardOrText, assigneeUsername) {
  const roleList = Array.isArray(roles) && roles.length ? roles : ['store_manager'];
  let r;
  try {
    // 优先按 assigneeUsername 精确匹配，避免同 store+role 多人重复发送
    if (assigneeUsername) {
      r = await query(
        `SELECT open_id, store, role FROM feishu_users WHERE registered = true AND open_id IS NOT NULL AND username = $1`,
        [assigneeUsername]
      );
    } else {
      r = await query(
        `SELECT open_id, store, role FROM feishu_users WHERE registered = true AND open_id IS NOT NULL`
      );
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'daily-inspection: feishu_users query failed');
    return { count: 0, msgIds: [] };
  }
  let n = 0;
  const sentMsgIds = [];
  const pingedOpenIds = [];
  const isCard = cardOrText && typeof cardOrText === 'object';
  for (const store of stores) {
    for (const row of r.rows || []) {
      if (!roleList.includes(row.role)) continue;
      if (!sameStore(row.store, store)) continue;
      if (isCard) {
        const res = await sendCard(row.open_id, cardOrText).catch(() => ({ ok: false }));
        const mid = feishuOutboundMessageId(res);
        if (mid) sentMsgIds.push(mid);
        if (!res.ok) {
          const tRes = await sendText(row.open_id, String(cardOrText._fallback || '定时任务提醒'), 'open_id').catch(() => ({ ok: false }));
          const tmid = feishuOutboundMessageId(tRes);
          if (tmid) sentMsgIds.push(tmid);
        }
      } else {
        const tRes = await sendText(row.open_id, cardOrText, 'open_id').catch(() => ({ ok: false }));
        const tmid = feishuOutboundMessageId(tRes);
        if (tmid) sentMsgIds.push(tmid);
      }
      pingedOpenIds.push(row.open_id);
      n++;
    }
  }
  return { count: n, msgIds: sentMsgIds, pingedOpenIds: [...new Set(pingedOpenIds.filter(Boolean))] };
}

/**
 * 执行单条每日巡检配置
 */
export async function executeDailyInspectionItem(item) {
  if (item?.enabled === false) {
    logger.info({ type: item?.type }, 'daily-inspection: item disabled, skip');
    return { ok: true, skipped: true, type: item?.type };
  }
  const replyExtra = String(item?.replyRequirements || item?.replyHint || '').trim();
  const stores = await resolveStores(item);
  const roles = Array.isArray(item.assigneeRoles) && item.assigneeRoles.length
    ? item.assigneeRoles
    : ['store_manager'];
  const type = String(item.type || '').trim();
  const { label, desc } = await lookupRhythmMeta(type);
  const timeNow = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  if (shouldSkipTestLikeDailyInspectionItem(item, label, desc)) {
    logger.info({ type, label }, 'daily-inspection: skip test-like item');
    return { ok: true, skipped: true, reason: 'test_like_pattern', type };
  }
  if (shouldSkipLegacyScheduledLabels(item, label, desc)) {
    logger.info({ type, label }, 'daily-inspection: skip LEGACY_SCHEDULED_TASK_SKIP_LABELS');
    return { ok: true, skipped: true, reason: 'legacy_scheduled_skip', type };
  }
  if (shouldSkipDeprecatedMaterialRollupSchedule(item, label, desc)) {
    logger.info({ type, label }, 'daily-inspection: skip deprecated material rollup schedule');
    return { ok: true, skipped: true, reason: 'deprecated_material_rollup', type };
  }

  // 巡检类（patrol/weekly/monthly）：发 BI 检测摘要卡片
  if (type === 'patrol_am' || type === 'patrol_pm' || type === 'weekly' || type === 'monthly') {
    const freq = type === 'patrol_am' || type === 'patrol_pm' ? 'daily' : type;
    const target = stores.length ? stores : await fetchActiveStores();
    const results = await runAnomalyChecks(freq, target);
    let alertN = 0;
    for (const res of results) {
      if (!res.triggered) continue;
      if (target.length && !target.some((s) => sameStore(s, res.store || res.store))) continue;
      alertN++;
    }
    const anomalyLine = alertN
      ? `⚠️ 本次新触发 **${alertN}** 条异常，已分别通知责任人，请留意异常卡片处理进展。`
      : '✅ 本次未发现新异常。';
    for (const store of target) {
      const taskId = `SCHED-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
      const card = buildScheduledCard({
        store,
        label,
        desc: `${desc || ''}${desc ? '\n' : ''}BI 检测完成 · ${anomalyLine}`,
        taskId,
        timeNow,
        replyExtra
      });
      card._fallback = `【${label}】${store} · ${timeNow}\nBI检测完成 · ${alertN ? `新触发${alertN}条异常` : '无新异常'}`;

      // 先确定唯一主责任人（岗位规范账号），再只给该人发消息
      const roleList = Array.isArray(roles) && roles.length ? roles : ['store_manager'];
      const primary = await resolvePrimaryPatrolAssignee(store, roleList);
      const assigneeUsername = primary?.username || '';
      const assigneeRole = primary?.role || roleList[0] || 'store_manager';
      const assigneeOpenId = primary?.open_id || '';

      const sentMsgIds = [];
      const pingedOpenIds = [];
      if (assigneeOpenId) {
        const isCard = card && typeof card === 'object';
        if (isCard) {
          const res = await sendCard(assigneeOpenId, card).catch(() => ({ ok: false }));
          const mid = feishuOutboundMessageId(res);
          if (mid) sentMsgIds.push(mid);
          if (!res.ok) {
            const tRes = await sendText(assigneeOpenId, String(card._fallback || '定时任务提醒'), 'open_id').catch(() => ({ ok: false }));
            const tmid = feishuOutboundMessageId(tRes);
            if (tmid) sentMsgIds.push(tmid);
          }
        } else {
          const tRes = await sendText(assigneeOpenId, card, 'open_id').catch(() => ({ ok: false }));
          const tmid = feishuOutboundMessageId(tRes);
          if (tmid) sentMsgIds.push(tmid);
        }
        pingedOpenIds.push(assigneeOpenId);
      }

      // 写入 master_tasks
      try {
        const created = await createUnifiedTask({
          taskId,
          source: 'scheduled_inspection',
          category: type,
          store,
          assigneeUsername,
          assigneeRole,
          assigneeAgent: 'ops_supervisor',
          title: `${store} · ${label}`,
          detail: `类型：${label}\nBI检测：${alertN ? `触发${alertN}条异常` : '无异常'}\n时间：${timeNow}`,
          sourceData: { taskType: type, label, alertN, assignee_open_ids: pingedOpenIds },
          feishuMsgIds: sentMsgIds,
          timeoutHours: 1,
          targetStatus: 'pending_response',
          createdFrom: 'daily_inspection_scheduler'
        });
        if (!created.ok) throw new Error(created.error || 'create_unified_task_failed');
        logger.info({ taskId, store, type, alertN, msgIds: sentMsgIds.length }, 'daily-inspection: patrol task saved to master_tasks');
      } catch (e) {
        logger.warn({ err: e?.message, store, type }, 'daily-inspection: patrol master_tasks insert failed');
      }
    }
    logger.info({ type, stores: target.length, alertN }, 'daily-inspection: patrol done');
    return { ok: true, type, alertN, pingN: target.length };
  }

  // 其他定时任务（晨检/日终/自定义试味等）：统一发任务卡片，并写入 master_tasks 以便追踪回复
  for (const store of stores.length ? stores : await fetchActiveStores()) {
    const taskId = `SCHED-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
    const card = buildScheduledCard({ store, label, desc: desc || '请按要求完成并反馈', taskId, timeNow, replyExtra });
    card._fallback = `【${label}】${store}\n${desc || '定时任务提醒，请按要求完成并反馈。'}\n时间：${timeNow}\n任务ID：${taskId}`;

    // 每个岗位类型一名规范责任人（马己仙出品经理固定黎永荣主号）
    const roleList = Array.isArray(roles) && roles.length ? roles : ['store_manager'];
    const staffRows = await resolveScheduledCardRecipients(store, roleList);

    if (!staffRows.length) {
      logger.warn({ store, roleList }, 'daily-inspection: no resolved staff (feishu_users / 岗位绑定)');
      continue;
    }

    const allSentMsgIds = [];
    const allPingedOpenIds = [];
    const assigneeUsernames = [];

    for (const staff of staffRows) {
      const un = String(staff.username || '').trim();
      if (un) assigneeUsernames.push(un);
      const assigneeOpenId = String(staff.open_id || '').trim();
      if (!assigneeOpenId) continue;

      const isCard = card && typeof card === 'object';
      if (isCard) {
        const res = await sendCard(assigneeOpenId, card).catch(() => ({ ok: false }));
        const mid = feishuOutboundMessageId(res);
        if (mid) allSentMsgIds.push(mid);
        if (!res.ok) {
          const tRes = await sendText(assigneeOpenId, String(card._fallback || '定时任务提醒'), 'open_id').catch(() => ({ ok: false }));
          const tmid = feishuOutboundMessageId(tRes);
          if (tmid) allSentMsgIds.push(tmid);
        }
      } else {
        const tRes = await sendText(assigneeOpenId, card, 'open_id').catch(() => ({ ok: false }));
        const tmid = feishuOutboundMessageId(tRes);
        if (tmid) allSentMsgIds.push(tmid);
      }
      allPingedOpenIds.push(assigneeOpenId);
    }

    const primaryUsername = assigneeUsernames[0] || String(staffRows[0]?.username || '').trim() || '';
    const primaryRole = staffRows[0]?.role || roleList[0] || 'store_manager';

    try {
      const created = await createUnifiedTask({
        taskId,
        source: 'scheduled_inspection',
        category: type,
        store,
        assigneeUsername: primaryUsername,
        assigneeRole: primaryRole,
        assigneeAgent: 'ops_supervisor',
        title: `${store} · ${label}`,
        detail: `类型：${label}\n任务：${desc || '请按要求完成并反馈'}\n时间：${timeNow}`,
        sourceData: { taskType: type, label, desc, assignee_open_ids: allPingedOpenIds, assignee_usernames: assigneeUsernames },
        feishuMsgIds: allSentMsgIds,
        timeoutHours: 3,
        targetStatus: 'pending_response',
        createdFrom: 'daily_inspection_scheduler'
      });
      if (!created.ok) throw new Error(created.error || 'create_unified_task_failed');
      logger.info(
        { taskId, store, primaryUsername, primaryRole, msgIds: allSentMsgIds.length, assigneeN: staffRows.length },
        'daily-inspection: task saved to master_tasks (merged assignees)'
      );
    } catch (e) {
      logger.warn({ err: e?.message, taskId, store }, 'daily-inspection: master_tasks insert failed');
    }

    logger.info({ type, label, store, taskId, assigneeCount: staffRows.length }, 'daily-inspection: scheduled cards sent to resolved assignees');
  }
  return { ok: true, type, custom: true };
}

/**
 * @param {{ force?: boolean }} opts force=true 时忽略时间与频率，执行全部配置（供运维自测）
 */
export async function runDailyInspectionsTick(opts = {}) {
  const force = !!opts.force;
  const raw = await getConfig('daily_inspections');
  const items = Array.isArray(raw) ? raw : [];
  if (!items.length) return { ok: true, ran: 0, message: 'no daily_inspections config' };

  const hm = getShanghaiHM();
  const dateStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
  const results = [];

  for (const item of items) {
    if (item?.enabled === false) {
      results.push({ skipped: true, reason: 'disabled', type: item.type });
      continue;
    }
    const tnorm = normalizeTime(item.time);
    if (!force) {
      if (tnorm !== hm) continue;
      if (!frequencyMatches(item.frequency, item.type)) continue;
    }

    const dedupeKey = `${dateStr}|${tnorm}|${item.type}|${item.store || ''}|${item.brand || ''}|${item.frequency || 'daily'}`;
    const last = _dedupe.get(dedupeKey);
    if (!force && last && Date.now() - last < DEDUPE_MS) {
      results.push({ skipped: true, reason: 'dedupe', type: item.type });
      continue;
    }

    try {
      const r = await executeDailyInspectionItem(item);
      _dedupe.set(dedupeKey, Date.now());
      results.push({ ok: true, ...r, time: tnorm });
    } catch (e) {
      logger.error({ err: e?.message, item }, 'daily-inspection item failed');
      results.push({ ok: false, error: e?.message, type: item.type });
    }
  }

  if (results.length) {
    logger.info({ hm, force, count: results.length }, 'daily-inspection tick');
  }
  return { ok: true, hm, force, ran: results.filter((x) => x.ok).length, results };
}

export function startDailyInspectionScheduler() {
  cron.schedule(
    '* * * * *',
    async () => {
      try {
        await runWithCronLog(
          'daily_inspection_tick',
          () => runDailyInspectionsTick({ force: false }),
          { recordSuccess: false }
        );
      } catch (e) {
        logger.error({ err: e?.message }, 'daily-inspection cron failed');
      }
    },
    { timezone: 'Asia/Shanghai' }
  );
  logger.info('Daily inspection scheduler started (每分钟检查 daily_inspections，Asia/Shanghai)');
}
