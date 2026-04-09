/**
 * 飞书单聊「营销文案」多轮流程（与 hr-management-system/server/agents.js 对齐）。
 * 必须在 feishu webhook 中先于 message-pipeline 与通用图片识别调用，避免误入 marketing_planner（营销活动计划）。
 */
import { logger } from '../utils/logger.js';
import { callLLM, callVisionLLM } from './llm-provider.js';

const _sessions = new Map();
const TTL_MS = 30 * 60 * 1000;
const ROLES = new Set([
  'admin',
  'hq_manager',
  'store_manager',
  'store_production_manager',
  'store_product_manager'
]);

/** 套数 N = 每个平台各 N 条，共 4×N 段；第 k 套 = 点评+外卖+小红书+抖音 各 1 条（场景与体裁严格对应平台） */
const COPY_SET_MIN = 1;
const COPY_SET_MAX = 12;
const COPY_SET_DEFAULT = 2;
const PLATFORMS_PER_SET = 4;

/** 从「8」「共8套」「要8套」等串中抽数字 */
function parseCopySetCountRaw(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(/(\d{1,2})/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function clampCopySetCount(n) {
  if (n == null || !Number.isFinite(n)) return COPY_SET_DEFAULT;
  return Math.max(COPY_SET_MIN, Math.min(COPY_SET_MAX, Math.round(n)));
}

/** 按「套」交错：顺序固定为 大众点评 → 外卖 → 小红书 → 抖音（与用户要求一致） */
function buildRequiredSectionHeadings(copySetCount) {
  const n = clampCopySetCount(copySetCount);
  const lines = [];
  for (let i = 1; i <= n; i++) {
    lines.push(`【大众点评｜第${i}套】`);
    lines.push(`【外卖｜第${i}套】`);
    lines.push(`【小红书｜第${i}套】`);
    lines.push(`【抖音｜第${i}套】`);
  }
  return { lines, setCount: n, totalBlocks: lines.length };
}

export function parseFeishuMarketingCopyTemplate(text) {
  const t = String(text || '').trim();
  if (!/^\s*营销文案/m.test(t)) return null;
  const pick = (label) => {
    const line = new RegExp(`^\\s*${label}\\s*[:：]\\s*(.+)$`, 'im');
    let m = t.match(line);
    if (m) return String(m[1] || '').trim();
    const inline = new RegExp(`${label}\\s*[:：]\\s*([^\\n]+)`);
    m = t.match(inline);
    return m ? String(m[1] || '').trim() : '';
  };
  const dishNames = pick('菜名') || pick('内容');
  const brand = pick('品牌');
  const reason = pick('推荐理由') || pick('备注');
  const setRaw = pick('文案套数') || pick('套数') || pick('几套');
  const parsedCount = parseCopySetCountRaw(setRaw);
  const copySetCount = clampCopySetCount(parsedCount != null ? parsedCount : COPY_SET_DEFAULT);
  if (!dishNames && !brand && !reason) return null;
  return { dishNames, brand, reason, copySetCount };
}

function buildAckMessage(parsed) {
  const dish = parsed.dishNames || '—';
  const br = parsed.brand || '—';
  const rs = parsed.reason || '—';
  const n = parsed.copySetCount ?? COPY_SET_DEFAULT;
  const { totalBlocks } = buildRequiredSectionHeadings(n);
  const splitDesc = `每平台各 **${n}** 条，合计 **${totalBlocks}** 段（第 k 套 = 大众点评 + 外卖 + 小红书 + 抖音 各 1 条；外卖=到家，点评=堂食，抖音=短视频脚本）`;
  return (
    '✅ 已收到菜品信息！\n\n' +
    `📋 菜名：${dish}\n` +
    `🏷️ 品牌：${br}\n` +
    `💬 推荐理由：${rs}\n` +
    `🔢 文案套数：**${n}**（${splitDesc}）\n\n` +
    '📸 可继续发送菜品图片（建议2-5张，也可跳过），发完后回复「生成文案」或「生产文案」即可。\n' +
    '（**文案套数：数字**，范围 1～12；不写则默认 2 套 = 每平台 2 条，共 8 段。）\n\n' +
    '回复「取消」可终止本次任务。'
  );
}

async function sendMarketingReply(messageId, body) {
  const { replyMsg } = await import('./feishu-client.js');
  const b = String(body || '').trim();
  const text = /^小年[:：]/m.test(b) ? b : `小年: ${b}`;
  if (messageId) await replyMsg(messageId, text).catch((e) => logger.warn({ err: e?.message }, 'marketing-copy replyMsg failed'));
}

function buildMarketingCopySystemPrompt(requiredHeadingsBlock, sectionCount) {
  return `你是餐饮门店的商家小编/运营，统一用「商家视角」写稿：可用「我们店/本店/这款/推荐」等，语气像真人店长或品牌账号在发声，但不要写公文或堆砌形容词。禁止假装成顾客写「我今天吃到」（顾客视角禁用）。

【互动与效果——红线】平台算法、账号权重、投放与时段均不可控。禁止承诺「必火」「必上热门」「保证 500 赞 / 300 条评论」或编造任何互动数据。请把内容设计成「高互动潜力」：评论有可答点、收藏有理由、开头 3 秒/首句能留住人、信息具体真实；若用户期望大体量互动，只在结构上对齐爆款常见特征，不写保证语。

【平台流量与内容规则——须落实到每一段】
A) 大众点评（评价/笔记向，堂食）：平台长期治理虚假评价与异常 AIGC 评价，内容须像真实到店体验：首句抓人、细节具体（环境/服务/菜品一环）、避免套话堆叠与明显 AI 模板腔。精选向常见特征：主题清晰、有画面感、字数充实（本任务 90～220 字）、可自然引导读者「想配图可拍门头/菜品/桌景」。严禁外卖配送话术（骑手、餐盒、拆盒、送到家等）。

B) 小红书（搜索 + 推荐双流量）：标题与正文埋「用户会搜的词」（品类、场景如聚餐/约会、地域或商圈可弱化编造）；首段承担留存，避免全是形容词；给一行「封面大字可写：xxx」作拍摄提示；正文末 #话题# 3～6 个，每段标签组合不同，兼顾垂直与泛流量词；可轻引导收藏「怕找不到先收藏」。遵守社区规范，避免虚假功效与极限承诺。

C) 抖音（短视频）：按 15～45 秒口播脚本写，结构必须含：①【0～3 秒钩子】冲突/反问/悬念（口语短句）；②【中段】菜品与店信息，节奏紧凑；③【结尾互动】设计 2 个低门槛评论问题（如二选一、扣 1、猜价格区间）；④【画面/字幕建议】一行。抖音公开信息强调推荐会综合多类用户行为信号（完播、点赞、评论、收藏、关注等，且随内容类型动态调整），勿只押单一指标；可提示发布后积极回复前若干条评论以提升互动链。禁止写成大众点评长评或外卖商品说明的换皮版本。

D) 外卖（到家场景）：同下条原则级。

【原则级：体裁与场景不可串台——违反即整段作废】
1) 【大众点评｜第N套】仅到店堂食：入座、点菜、上桌、趁热、店员介绍、店内环境等。禁止外卖话术。
2) 【外卖｜第N套】仅到家/配送：到手、打包、温度、拆盒、办公室或在家吃、套餐加购、搜索词等至少两类；禁止把堂食「刚端上桌现片」当主线；不少于约 120 字（不含标题）。
3) 【小红书｜第N套】商家种草笔记：标题+正文+标签+（可选）封面提示；非短视频脚本。
4) 【抖音｜第N套】短视频口播脚本：短句、强节奏、强互动，不得与另三段同结构抄袭。

【去 AI 味——出现任一即算失败，禁止输出】
综上所述、值得一提、不难发现、不仅…而且…、在当下的、深度、赋能、痛点、用户、极致体验、不容错过、宝藏、绝绝子、YYDS、姐妹们谁懂、家人们、沉浸式、氛围感拉满、一口沦陷、好吃到哭。

【高质量成稿（对齐一线运营手写，而非凑字数）】
- 每条开头 1～2 句必须是「钩子」：具体场景、轻微反差、或一句可画面化的判断；禁止「欢迎来到本店」「我们隆重推出」等公文体起笔。
- 五感与细节：色泽、温度、香气、口感、桌边小动作、店员一句话等，每条至少两处可验证的具体描写；禁止连续三个以上空洞形容词堆砌。
- 四条平台文案须从四种不同「消费动机 + 场景」切入（如：解馋/聚餐/加班/打卡/复购），禁止只改称呼、整段复制换平台。
- 允许适度口语与情绪词（贴合平台），但必须与具体菜品/场景绑定，避免万能鸡汤。

【吸引力与去重】
共 ${sectionCount} 个版块；任意两段开头 12 字不得相同；禁止整段复制或只改一两个词；同一平台内第 1 套与第 2 套须换钩子与角度。

【输出格式】
只输出下列标题块，顺序与标题文字必须完全一致；每个标题单独一行，标题下空一行再写正文；勿输出 JSON、前言或后记。

${requiredHeadingsBlock}

【合规】不编造折扣与活动；不医疗功效；信息不够就弱语气带过。`;
}

async function runGeneration(sess) {
  const copySetCount = clampCopySetCount(sess.params?.copySetCount);
  const { lines: headingLines } = buildRequiredSectionHeadings(copySetCount);
  const requiredHeadingsBlock = headingLines.join('\n');
  const sectionCount = headingLines.length;

  const urls = (Array.isArray(sess.imageUrls) ? sess.imageUrls : []).filter(Boolean).slice(0, 6);
  let visualNotes = '（本次未上传图片，仅根据文字信息创作。）';
  if (urls.length) {
    const visionContent = [];
    for (const url of urls) {
      visionContent.push({ type: 'image_url', image_url: { url: String(url) } });
    }
    visionContent.push({
      type: 'text',
      text: '你是餐饮菜品视觉分析员。请综合以上图片，用中文简洁列出：可见的菜品或食材、色泽摆盘、适合顾客感知的卖点（不超过220字）。不要编造图片中不存在的配料或价格。'
    });
    const vis = await callVisionLLM(visionContent, '');
    const v = String(vis?.content || '').trim();
    if (v) visualNotes = v;
  }
  const totalBlocks = copySetCount * PLATFORMS_PER_SET;
  const brief = [
    `菜名：${sess.params.dishNames || '-'}`,
    `品牌：${sess.params.brand || '-'}`,
    `推荐理由：${sess.params.reason || '-'}`,
    `文案套数：${copySetCount}（每平台各 ${copySetCount} 条，共 ${totalBlocks} 段；平台顺序每轮：大众点评→外卖→小红书→抖音；商家视角；点评=堂食、外卖=到家、小红书=笔记、抖音=短视频脚本；禁止承诺具体赞评数）`
  ].join('\n');

  const maxTokens = Math.min(8192, 900 + copySetCount * PLATFORMS_PER_SET * 280);
  const r = await callLLM(
    [
      {
        role: 'system',
        content: buildMarketingCopySystemPrompt(requiredHeadingsBlock, sectionCount)
      },
      {
        role: 'user',
        content: `菜品与品牌信息：\n${brief}\n\n图片要点：\n${visualNotes}\n\n请严格按 ${sectionCount} 个标题依次输出；每条须符合对应平台的体裁与流量设计（点评堂食、外卖到家、小红书笔记、抖音短视频脚本），禁止漏块、禁止跨平台混用场景与话术。`
      }
    ],
    {
      purpose: 'marketing_copy',
      temperature: 0.62,
      max_tokens: maxTokens,
      skipCache: true,
      timeout: 150000,
      context: { intent: 'query', complexity: 'high', mode: 'single' }
    }
  );
  return String(r?.content || '').trim() || '生成结果为空，请重试。';
}

/**
 * @param {object} p
 * @param {string} p.openId
 * @param {{ role: string, username?: string }} p.feishuUser
 * @param {string} p.text - 已 trim 的正文（纯图片消息可为空）
 * @param {string} p.msgType
 * @param {string} p.imageKey
 * @param {string} [p.messageId]
 * @param {(mid: string, key: string) => Promise<string|null>} [p.downloadImage]
 */
export async function tryV2FeishuMarketingCopyRound(p) {
  const key = String(p.openId || '').trim();
  if (!key) return { handled: false };

  const role = String(p.feishuUser?.role || '').trim();
  const messageId = p.messageId ? String(p.messageId) : '';
  const t = String(p.text || '').trim();
  const msgType = String(p.msgType || '');
  const imageKey = String(p.imageKey || '').trim();

  let pending = _sessions.get(key);
  const now = Date.now();
  if (pending && now - pending.ts > TTL_MS) {
    _sessions.delete(key);
    pending = null;
  }

  let imgs = [];
  if (pending && msgType === 'image' && imageKey && messageId && typeof p.downloadImage === 'function') {
    const dataUrl = await p.downloadImage(messageId, imageKey);
    if (dataUrl) imgs = [dataUrl];
    else {
      await sendMarketingReply(messageId, '图片下载失败，请重发图片或稍后重试。');
      return { handled: true, extra: { marketingCopy: 'image_fail' } };
    }
  }

  if (!pending && t) {
    const parsed = parseFeishuMarketingCopyTemplate(t);
    if (!parsed) return { handled: false };
    if (!ROLES.has(role)) {
      await sendMarketingReply(
        messageId,
        '⚠️ 营销文案生成功能对以下角色开放：管理员、总部营运、门店店长、出品经理。如需权限请在 HRMS 中核对岗位角色。'
      );
      return { handled: true, extra: { marketingCopy: 'denied' } };
    }
    _sessions.set(key, {
      ts: now,
      role,
      username: p.feishuUser?.username,
      params: parsed,
      imageUrls: []
    });
    await sendMarketingReply(messageId, buildAckMessage(parsed));
    return { handled: true, extra: { marketingCopy: 'started' } };
  }

  if (!pending) return { handled: false };

  if (/^(取消|不做了|放弃)\b/.test(t)) {
    _sessions.delete(key);
    await sendMarketingReply(messageId, '已取消本次营销文案任务。');
    return { handled: true, extra: { marketingCopy: 'cancelled' } };
  }

  if (imgs.length) {
    const set = new Set(pending.imageUrls || []);
    for (const u of imgs) set.add(u);
    pending.imageUrls = [...set];
    pending.ts = now;
    _sessions.set(key, pending);
    await sendMarketingReply(
      messageId,
      `📸 已收到本批 ${imgs.length} 张图，累计 **${pending.imageUrls.length}** 张（建议 2～5 张即可）。\n可直接回复 **「生成文案」** 或 **「生产文案」**；也可继续发图后再生成。`
    );
    return { handled: true, extra: { marketingCopy: 'photos' } };
  }

  const isGenTrigger =
    /^(生成文案|生产文案|开始生成|生成|可以生成了|好了)\s*$/.test(t) ||
    /生成营销文案|生产营销文案|生成.*文案|生产.*文案/.test(t);
  if (isGenTrigger) {
    try {
      const out = await runGeneration(pending);
      _sessions.delete(key);
      const clipped =
        out.length > 16000 ? `${out.slice(0, 16000)}\n\n…（内容过长已截断，可减少「文案套数」或缩短菜名后重试）` : out;
      await sendMarketingReply(messageId, clipped);
    } catch (e) {
      logger.error({ err: e?.message }, 'marketing-copy generation failed');
      await sendMarketingReply(messageId, '营销文案生成失败，请稍后重试或减少图片数量。');
    }
    return { handled: true, extra: { marketingCopy: 'done' } };
  }

  if (t) {
    await sendMarketingReply(
      messageId,
      '当前有一条进行中的「营销文案」任务：可继续发菜品图（也可不发），准备好后回复「生成文案」或「生产文案」。回复「取消」可退出。'
    );
    return { handled: true, extra: { marketingCopy: 'hint' } };
  }

  return { handled: false };
}
