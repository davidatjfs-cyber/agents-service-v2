import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

function cleanText(value, max = 255) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

// 8.3: 按门店/节日/菜品自动生成选题
async function generateTopics() {
  const topics = [];
  const today = new Date();
  const month = today.getMonth() + 1;
  const day = today.getDate();

  // 节日映射
  const HOLIDAYS = {
    '1-1': '元旦', '2-14': '情人节', '3-8': '妇女节', '5-1': '劳动节',
    '6-1': '儿童节', '8-15': '中秋节', '10-1': '国庆节', '12-25': '圣诞节'
  };
  const upcoming = [];
  for (const [md, name] of Object.entries(HOLIDAYS)) {
    const [m, d] = md.split('-').map(Number);
    const diff = (m - month) * 30 + (d - day);
    if (diff >= 0 && diff <= 14) upcoming.push({ name, days: diff });
  }

  // 获取活跃门店列表
  const stores = await query(
    `SELECT DISTINCT store_id FROM growth_campaigns WHERE status = 'active' LIMIT 20`
  );

  for (const s of (stores.rows || [])) {
    const storeId = cleanText(s.store_id, 80);
    if (!storeId) continue;

    // 基础选题: 门店日常
    topics.push({
      storeId,
      channel: '朋友圈',
      title: `${storeId} · 今日推荐`,
      contentBrief: `分享门店今日推荐菜品或优惠活动，配合门店实拍图`,
      copySuggestion: `今天来${storeId}试试我们的招牌菜吧！`
    });

    // 节日选题
    for (const h of upcoming) {
      topics.push({
        storeId,
        channel: h.days <= 3 ? '全渠道' : '小红书',
        title: `${h.name}特辑 — ${storeId}`,
        contentBrief: `${h.name}将至（${h.days}天后），策划节日主题内容`,
        copySuggestion: `🎉 ${h.name}要到啦！来${storeId}和亲朋好友一起庆祝吧`
      });
    }

    // 新品/招牌菜选题
    const profile = await query(
      `SELECT signature_dishes FROM store_marketing_profiles WHERE store_id = $1 LIMIT 1`,
      [storeId]
    );
    if (profile.rows?.length && profile.rows[0].signature_dishes?.length) {
      const dishes = profile.rows[0].signature_dishes.slice(0, 3);
      for (const dish of dishes) {
        topics.push({
          storeId,
          channel: '小红书',
          title: `探店 · ${dish}`,
          contentBrief: `${dish}拍摄+点评，适合小红书种草风格`,
          copySuggestion: `被这道${dish}圈粉了！来${storeId}一定要点`
        });
      }
    }
  }

  return topics;
}

// 8.4: 按渠道生成不同风格文案
function channelCopy(topic, channel) {
  const title = topic.title || '';
  const brief = topic.contentBrief || '';
  const suggestion = topic.copySuggestion || '';
  const channelMap = {
    '小红书': { style: '种草/分享', emoji: '✨', note: '配3-4张精美图片，定位门店地址' },
    '抖音': { style: '短视频/优惠', emoji: '🔥', note: '拍摄15-30秒短视频，突出性价比' },
    '大众点评': { style: '点评/推荐', emoji: '⭐', note: '强调菜品品质和服务体验' },
    '朋友圈': { style: '社交/亲切', emoji: '💛', note: '配1-2张实拍图，语气自然' },
    '企微': { style: '私域/福利', emoji: '🎁', note: '突出专属优惠，引导到店' }
  };
  const ch = channelMap[channel] || channelMap['朋友圈'];
  return `${ch.emoji} ${title}\n\n${suggestion}\n\n#${channel}内容建议# ${ch.style}风格 · ${ch.note}`;
}

// 写入 public_promo_tasks + content_calendar
async function writeTasks(topics) {
  let written = 0;
  for (const t of topics) {
    const taskKey = `promo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    try {
      const copy = channelCopy(t, t.channel);
      await query(
        `INSERT INTO public_promo_tasks (task_key, store_id, channel_key, title, content_brief, copy_text, status, due_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'planned', CURRENT_DATE + INTERVAL '3 days')
         ON CONFLICT DO NOTHING`,
        [taskKey, t.storeId, t.channel, t.title, t.contentBrief, copy]
      );
      // 同时写入内容日历
      await query(
        `INSERT INTO growth_content_calendar (item_id, store_id, channel, publish_date, title, content_brief, copy_text, status)
         VALUES ($1, $2, $3, CURRENT_DATE + INTERVAL '1 day', $4, $5, $6, 'planned')
         ON CONFLICT DO NOTHING`,
        [`content_${taskKey}`, t.storeId, t.channel, t.title, t.contentBrief, copy]
      );
      written++;
    } catch (e) {
      logger.warn({ err: e?.message, taskKey }, 'promo task write failed');
    }
  }
  return written;
}

// 8.9: 每周品宣复盘
async function weeklyReview() {
  const r = await query(
    `SELECT pt.channel_key AS channel,
            COUNT(*)::int AS total_tasks,
            COUNT(*) FILTER (WHERE pt.status = 'published')::int AS published,
            COALESCE(SUM(ge.revenue_fen), 0)::int AS total_revenue
     FROM public_promo_tasks pt
     LEFT JOIN growth_events ge ON ge.campaign_id = pt.campaign_id
       AND ge.occurred_at >= CURRENT_DATE - INTERVAL '7 days'
     WHERE pt.created_at >= CURRENT_DATE - INTERVAL '7 days'
     GROUP BY pt.channel_key
     ORDER BY total_tasks DESC`
  );
  const rows = r.rows || [];
  if (!rows.length) return { ok: true, reviewed: false, reason: 'no_data' };

  const lines = rows.map(row =>
    `📊 ${row.channel}: 共${row.total_tasks}个任务，已发布${row.published}个，归因收入¥${(Number(row.total_revenue)/100).toFixed(0)}`
  );
  const summary = `📈 本周品宣复盘 (${new Date().toISOString().slice(0, 10)})\n${lines.join('\n')}`;
  return { ok: true, reviewed: true, summary, channels: rows };
}

// 主入口
export async function runPublicPromo() {
  logger.info('public promo service started');

  // 8.3: 生成选题
  const topics = await generateTopics();
  if (topics.length === 0) {
    logger.info('public promo: no topics generated');
  } else {
    const written = await writeTasks(topics);
    logger.info({ topics: topics.length, written }, 'public promo topics generated');
  }

  return { ok: true, topics_generated: topics.length };
}

export async function runWeeklyReview() {
  logger.info('public promo weekly review started');
  const result = await weeklyReview();
  if (result.reviewed) {
    try {
      const { pushDailyReport } = await import('./feishu-client.js');
      await pushDailyReport(result.summary);
    } catch (e) {
      logger.warn({ err: e?.message }, 'weekly review push failed');
    }
  }
  logger.info({ reviewed: result.reviewed }, 'public promo weekly review completed');
  return result;
}
