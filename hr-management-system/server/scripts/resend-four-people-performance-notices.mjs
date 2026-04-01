#!/usr/bin/env node
import 'dotenv/config';
import axios from 'axios';
import pg from 'pg';

const period = process.argv[2] || '2026-03';
const names = ['徐曼金', '王世波', '喻峰', '喻烽', '黎永荣'];
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });

const SCORE_MODEL_ZH = {
  anomaly_rollups_v2: '周度异常汇总',
  new_model: '人力资源综合模型',
  new_model_monthly: '月度自动评分',
  task_reminder_v1: '任务催办绩效记录'
};

const ROLE_ZH = {
  store_manager: '店长',
  store_production_manager: '出品经理',
  hq_manager: '总部主管',
  admin: '管理员',
  admin_hq: '总部管理',
  'admin/hq': '总部管理'
};

function periodLabelFrom(periodValue) {
  const p = String(periodValue || '').trim();
  if (p.startsWith('week_')) return `考核周期：${p.slice(5)} 起的一周`;
  if (p.startsWith('month_')) return `考核月度：${p.slice(6)}`;
  if (/^\d{4}-\d{2}$/.test(p)) return `考核月度：${p}`;
  return p ? `考核周期：${p}` : '考核周期：—';
}

function ratingLine(label, value, suffix = '级') {
  const v = String(value || '').trim();
  return `${label}：${v ? `${v}${suffix}` : '—'}`;
}

function templateByScore(totalScore) {
  const s = Number(totalScore || 0);
  if (s >= 85) return 'green';
  if (s >= 70) return 'blue';
  if (s >= 60) return 'yellow';
  return 'red';
}

async function getTenantToken() {
  const appId = process.env.FEISHU_APP_ID || process.env.LARK_APP_ID || '';
  const appSecret = process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET || '';
  if (!appId || !appSecret) return '';
  const r = await axios.post(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: appId, app_secret: appSecret },
    { timeout: 10000 }
  );
  return r.data?.tenant_access_token || '';
}

async function sendText(openId, text) {
  const token = await getTenantToken();
  if (!token) return { ok: false, error: 'no_token' };
  const r = await axios.post(
    'https://open.feishu.cn/open-apis/im/v1/messages',
    { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, params: { receive_id_type: 'open_id' }, timeout: 10000 }
  );
  return { ok: r.data?.code === 0, data: r.data };
}

async function sendCard(openId, card) {
  const token = await getTenantToken();
  if (!token) return { ok: false, error: 'no_token' };
  const r = await axios.post(
    'https://open.feishu.cn/open-apis/im/v1/messages',
    { receive_id: openId, msg_type: 'interactive', content: JSON.stringify(card) },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, params: { receive_id_type: 'open_id' }, timeout: 10000 }
  );
  return { ok: r.data?.code === 0, data: r.data };
}

const rows = await db.query(
  `SELECT DISTINCT ON (lower(s.username)) s.*
   FROM agent_scores s
   JOIN feishu_users fu ON lower(fu.username) = lower(s.username)
   WHERE fu.registered = true
     AND fu.name = ANY($1)
     AND s.period = $2
     AND s.score_model = 'new_model_monthly'
   ORDER BY lower(s.username), s.updated_at DESC`,
  [names, period]
);

let sent = 0;
const detail = [];

for (const score of rows.rows || []) {
  const fuR = await db.query(
    `SELECT open_id, name
     FROM feishu_users
     WHERE lower(username) = lower($1) AND registered = true
     ORDER BY updated_at DESC
     LIMIT 1`,
    [score.username]
  );
  const fu = fuR.rows?.[0];
  if (!fu?.open_id) continue;
  const bd = score.breakdown && typeof score.breakdown === 'object' ? score.breakdown : {};
  const roleLabel = ROLE_ZH[String(score.role || '').trim()] || '门店岗位';
  const modelLabel = SCORE_MODEL_ZH[String(score.score_model || '').trim()] || '绩效评分';
  const summary = String(score.summary || '')
    .replace(/\bnew_model_monthly\b/g, '月度自动评分')
    .replace(/\bnew_model\b/g, '人力资源综合模型')
    .replace(/\bstore_rating\b/g, '门店评级')
    .replace(/\bability_rating\b/g, '工作能力')
    .replace(/\battitude_rating\b/g, '工作态度')
    .replace(/\bexecution_rating\b/g, '执行力');

  const msgText =
    `📊 绩效考核日报\n\n` +
    `${fu.name || score.name || score.username}，你好！以下是你在${score.store}（${score.brand}）的绩效考核结果：\n\n` +
    `📋 岗位：${roleLabel}\n` +
    `🗓️ ${periodLabelFrom(score.period)}\n` +
    `📌 评分类型：${modelLabel}\n\n` +
    `📊 本期总分：**${score.total_score} 分**（满分100）\n\n` +
    `评分维度：\n` +
    `• ${ratingLine('门店评级', bd.store_rating, '级')}\n` +
    `• ${ratingLine('工作能力', bd.ability_rating)}\n` +
    `• ${ratingLine('工作态度', bd.attitude_rating)}\n` +
    `• ${ratingLine('执行力', bd.execution_rating)}\n\n` +
    `扣分明细：\n` +
    `无扣分项\n\n` +
    `${summary ? `说明：${summary}\n\n` : ''}` +
    `如有异议，请回复“申诉”并说明原因。`;

  const card = {
    header: {
      title: { tag: 'plain_text', content: '📊 高管绩效简报' },
      template: templateByScore(score.total_score)
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            `**${fu.name || score.name || score.username}**，你好！以下是你在 **${score.store}（${score.brand}）** 的绩效结果。\n\n` +
            `📋 岗位：${roleLabel}\n` +
            `🗓️ ${periodLabelFrom(score.period)}\n` +
            `📌 评分类型：${modelLabel}\n\n` +
            `📊 本期总分：**${score.total_score} 分**（满分100）`
        }
      },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: `**核心评级（A-D）**\n• ${ratingLine('门店评级', bd.store_rating)}\n• ${ratingLine('工作能力', bd.ability_rating)}\n• ${ratingLine('工作态度', bd.attitude_rating)}\n• ${ratingLine('执行力', bd.execution_rating)}` } },
      { tag: 'div', text: { tag: 'lark_md', content: '**扣分明细**\n无扣分项' } },
      ...(summary ? [{ tag: 'div', text: { tag: 'lark_md', content: `**说明**\n${summary}` } }] : []),
      { tag: 'note', elements: [{ tag: 'plain_text', content: '如有异议，请回复“申诉”并说明原因。' }] }
    ]
  };
  let sentRes = await sendCard(fu.open_id, card);
  if (!sentRes?.ok) sentRes = await sendText(fu.open_id, `小年：${msgText}`);
  if (sentRes?.ok) {
    sent += 1;
    detail.push({ username: score.username, name: fu.name || score.name, period: score.period, total_score: score.total_score });
  }
}

console.log(JSON.stringify({ period, matched: (rows.rows || []).length, sent, detail }, null, 2));
await db.end();

