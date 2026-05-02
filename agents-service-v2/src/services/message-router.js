/**
 * Message Router — agents-service-v2
 * 规则路由 + LLM Intent 分类 + 置信度过滤
 */
import { callLLM } from './llm-provider.js';
import { logger } from '../utils/logger.js';
import { query } from '../utils/db.js';

// ─── Rule-based routing (P1: 关键词确定性路由) ───

const KEYWORD_RULES = [
  // 接受行动计划：最高优先级
  { route: 'accept_action_plan', rx: /接受行动计划|接受以上(行动|建议|任务)|确认行动计划|开始执行计划/i, score: 10 },
  { route: 'appeal', rx: /(申诉|投诉|不公平|误判|恢复扣分|举报)/i, score: 2 },
  // HRMS 知识库 / SOP / 菜单：必须高于「开档/收档」营运规则，否则会误走开档统计而非 PDF 检索
  {
    route: 'train_advisor',
    rx: /(菜单|菜谱|餐牌|菜品|主打菜|知识库|手册|SOP|操作步骤|操作规范|工作清单|标准流程|培训课件|档口|炒锅|烧腊|水吧|砧板|岗位.*(工作|任务|步骤)|开档.*(工作|任务|步骤|清单|完成|需要|哪些)|开市.*(工作|任务|步骤|清单)|收档.*(工作|任务|步骤|清单)|备餐.*(工作|任务|步骤))/i,
    score: 4
  },
  // 经营/生意概览：强制走确定性营收分析（data_auditor），避免 LLM 路由导致“无数据/口径错位”
  { route: 'data_auditor', rx: /(生意怎么样|最近生意|昨天生意|经营情况|经营怎么样|营业怎么样|营收怎么样|经营|生意)/i, score: 2.5 },
  { route: 'data_auditor', rx: /(收档.*(得分|平均|合格|多少|几次|报告|数据|情况)|开档.*(得分|平均|合格|多少|几次|报告|数据|情况))/i, score: 3 },
  { route: 'ops_supervisor', rx: /(开市|开档|收档|闭市|巡检|卫生|拍照|上传照片|检查表)/i, score: 2 },
  { route: 'data_auditor', rx: /(营业额|营收|毛利|差评|桌访|达成率|排名|趋势|预测|分析|人效|报损|原料)/i, score: 2 },
  { route: 'chief_evaluator', rx: /(绩效|评分|考核|奖金|离职|入职|转正|调岗|请假|社保|档案|薪资|工资)/i, score: 2 },
  { route: 'train_advisor', rx: /(sop|标准|流程|培训|课件|带教|退款|赔付|会员.*维护|会员.*管理|会员.*体系|会员策略|会员运营|会员怎么|如何.*会员)/i, score: 5 },
  { route: 'marketing_planner', rx: /(营销方案|推广方案|新品方案|活动策划|行动方案|营销活动计划|营销计划|提升.*方案|方案.*提升|如何提升|怎么提升|营销建议|促销活动|会员活动|拉新|引流|制定.*营销|营销.*制定)/i, score: 4 },
  // 含「执行了哪些 / 哪些策略 / 效果如何」等常见问法，避免仅依赖 LLM 路由漏进 marketing_executor
  {
    route: 'marketing_executor',
    rx: /(营销执行|活动进度|活动效果|ROI|活动跟踪|预算消耗|营销报告|活动数据|执行情况|当前活动|活动.*情况|执行了哪些|哪些策略|策略.*效果|效果如何|执行.*策略)/i,
    score: 4
  },
  { route: 'food_quality', rx: /(食品安全|食材.*过期|温度.*异常|卫生.*不合格|出品.*质量|菜品.*投诉)/i, score: 3 },
  // 互联网搜索：仅 admin/hq_manager 可通过（权限在 ROLE_PERMISSIONS 控制）
  { route: 'internet_search', rx: /(搜索|查一下|查资料|网上搜|互联网搜索|最新|帮我搜|搜一下|网上查|网络搜索|小红书|抖音.*热|微博.*热|热门话题|热门|热搜|流行趋势|最近.*火|现在.*流行|网红|新闻|资讯|推特|twitter|X上|X现在|X上面)/i, score: 3.5 },
];

const VALID_ROUTES = ['data_auditor', 'ops_supervisor', 'chief_evaluator', 'train_advisor', 'appeal', 'marketing_planner', 'marketing_executor', 'marketing', 'food_quality', 'master', 'accept_action_plan', 'internet_search', 'composite'];

function inferRouteByRules(text, hasImage) {
  if (hasImage) return { route: 'ops_supervisor', confidence: 1, reason: 'image_input' };
  const t = String(text || '').trim();
  if (!t) return null;
  // 使用最高分匹配（而非第一个匹配），避免低优先级规则覆盖高优先级意图
  let best = null;
  for (const item of KEYWORD_RULES) {
    if (item.rx.test(t)) {
      if (!best || item.score > best.score) {
        best = { route: item.route, confidence: 0.92, reason: 'rule:' + item.rx.source.slice(0, 40), score: item.score };
      }
    }
  }
  return best;
}

// ─── LLM-based routing (P2: 低置信度时用LLM分类) ───

const ROUTE_SYSTEM_PROMPT = `你是HRMS系统的主控路由Agent。根据用户输入决定路由给哪个子Agent。
严格输出JSON: {"route":"标识符","confidence":0-1,"reason":"理由"}

可用Agent:
- data_auditor: 数据审计(营收/毛利/损耗/差评/数据查询)
- ops_supervisor: 营运督导(开市收市检查/卫生巡检/图片审核)
- chief_evaluator: HR与绩效(绩效/考核/人事流程)
- train_advisor: 培训与SOP(流程/培训/课件)
- appeal: 申诉与投诉
- marketing_planner: 营销策划(制定营销方案/活动策划/会员策略/引流拉新)
- marketing_executor: 营销执行(活动进度跟踪/效果评估/ROI/预算消耗)
- food_quality: 食品安全(食材/温度/卫生)
- internet_search: 互联网搜索(查询新闻/搜索网络/查资料/查小红书/B站/Twitter)
- master: 无法明确归类时由Master Agent综合处理
- composite: 需多个Agent联合回答(如绩效分析+改进建议、巡检+培训标准)`;
async function routeByLLM(text, context) {
  try {
    const userMsg = context ? context + '\n当前输入: ' + text : '用户输入: ' + text;
    const result = await callLLM([
      { role: 'system', content: ROUTE_SYSTEM_PROMPT },
      { role: 'user', content: userMsg }
    ], {
      temperature: 0.1,
      max_tokens: 150,
      purpose: 'routing',
      context: { intent: 'query', complexity: 'low', mode: 'single' }
    });

    let raw = String(result.content || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    try {
      const parsed = JSON.parse(raw);
      if (parsed && VALID_ROUTES.includes(parsed.route)) return parsed;
    } catch (e) { /* parse fail */ }
    return { route: 'master', confidence: 0.5, reason: 'llm_parse_fail' };
  } catch (e) {
    logger.error({ err: e?.message }, 'LLM routing failed');
    return { route: 'master', confidence: 0.3, reason: 'llm_error' };
  }
}

// ─── Composite route patterns (多Agent联合回复) ───

const COMPOSITE_PATTERNS = [
  { routes: ['chief_evaluator', 'data_auditor'],
    rx: /(绩效.*分析|扣分.*原因|评分.*改进|考核.*提升|绩效.*改进|扣分.*提升)/i,
    label: '绩效分析+改进建议' },
  { routes: ['ops_supervisor', 'train_advisor'],
    rx: /(巡检.*培训|卫生.*标准|开档.*SOP|收档.*SOP|检查.*流程|巡检.*SOP)/i,
    label: '巡检结果+标准对照' },
  { routes: ['data_auditor', 'marketing_planner'],
    rx: /(营收.*方案|下滑.*策略|下降.*营销|提升.*营销|方案.*数据)/i,
    label: '数据分析+营销方案' },
];

// ─── Main Router ───

export async function routeMessage(text, hasImage, senderUsername) {
  const t = String(text || '').trim();

  // P0: Composite pattern detection (先于单Agent路由)
  for (const cp of COMPOSITE_PATTERNS) {
    if (cp.rx.test(t)) {
      logger.info({ routes: cp.routes, label: cp.label }, 'Composite route hit');
      return { route: 'composite', routes: cp.routes, confidence: 0.9, reason: `composite:${cp.label}` };
    }
  }

  // P1: Rule-based
  const ruleResult = inferRouteByRules(t, hasImage);
  if (ruleResult?.route && ruleResult.route !== 'master') {
    logger.info({ route: ruleResult.route, reason: ruleResult.reason }, 'Rule route hit');
    return ruleResult;
  }

  // P1.5: Follow-up detection (数字选项回复 → 继承上次路由)
  if (/^\d+$/.test(t) || /^[一二三四五六七八九十]$/.test(t)) {
    if (senderUsername) {
      try {
        const r = await query(
          `SELECT routed_to FROM agent_messages WHERE sender_username = $1 AND routed_to IS NOT NULL AND routed_to <> 'master' ORDER BY created_at DESC LIMIT 1`,
          [senderUsername]
        );
        if (r.rows?.[0]?.routed_to) return { route: r.rows[0].routed_to, confidence: 0.86, reason: 'followup' };
      } catch (e) { /* ignore */ }
    }
    return { route: 'master', confidence: 0.5, reason: 'numeric_input' };
  }

  // P2: LLM routing
  let context = '';
  if (senderUsername) {
    try {
      const h = await query(
        `SELECT content, direction FROM agent_messages WHERE sender_username = $1 AND content_type IN ('text','image') AND created_at > NOW() - INTERVAL '30 minutes' ORDER BY created_at DESC LIMIT 3`,
        [senderUsername]
      );
      if (h.rows?.length) {
        context = '【最近对话】\n' + h.rows.reverse().map(r => (r.direction === 'in' ? '用户' : 'Agent') + ': ' + r.content).join('\n');
      }
    } catch (e) { /* ignore */ }
  }

  const llmResult = await routeByLLM(t, context);

  // Confidence filter: < 0.7 → clarify
  if (llmResult.confidence < 0.7 && llmResult.reason) {
    if (ruleResult?.route && ruleResult.route !== 'master') return ruleResult;
    return { route: 'clarify', message: llmResult.reason, confidence: llmResult.confidence };
  }

  return llmResult;
}

// ─── Permission Check ───

const ROLE_PERMISSIONS = {
  admin: VALID_ROUTES,
  hq_manager: VALID_ROUTES,
  store_manager: ['data_auditor', 'ops_supervisor', 'chief_evaluator', 'train_advisor', 'appeal', 'marketing_planner', 'marketing_executor', 'food_quality', 'master', 'composite'],
  store_production_manager: ['data_auditor', 'ops_supervisor', 'chief_evaluator', 'train_advisor', 'appeal', 'marketing_planner', 'marketing_executor', 'food_quality', 'master', 'composite'],
  front_manager: ['ops_supervisor', 'train_advisor', 'master', 'composite'],
  employee: ['train_advisor', 'appeal', 'master', 'composite'],
};

export function checkPermission(role, route) {
  const allowed = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.employee;
  if (allowed.includes(route)) return { allowed: true };
  return { allowed: false, reason: `您的角色（${role}）暂无权限使用该功能` };
}

export { VALID_ROUTES, inferRouteByRules, COMPOSITE_PATTERNS };
