/**
 * Decision utils 纯函数单元测试（无需 mock DB / LLM）
 */
import { describe, test, expect } from '@jest/globals';

// 只测试纯函数：detectDecisionMode、parseStrategyHeadFromDs、stripReportStyleEnding、
// trimMultiSuggestions、formatDecisionHistory
// （coerceDecisionExecutionOutput 等 async 函数依赖 DB/LLM，需集成测试）

// 由于 ESM + jest 的限制，直接 import 会触发子模块的副作用（query 等），
// 这里用 jest.unstable_mockModule 屏蔽 DB/LLM 依赖
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../../utils/db.js', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({ logger: { warn: jest.fn() } }));
jest.unstable_mockModule('../../llm-provider.js', () => ({ callLLM: jest.fn().mockResolvedValue({ content: '' }) }));
jest.unstable_mockModule('../../knowledge/index.js', () => ({
  getStrategyStats: jest.fn().mockResolvedValue([]),
  extractStructuredData: jest.fn().mockReturnValue({}),
}));

const {
  detectDecisionMode,
  parseStrategyHeadFromDs,
  stripReportStyleEnding,
  trimMultiSuggestions,
  formatDecisionHistory,
} = await import('../decision-utils.js');

describe('detectDecisionMode', () => {
  test('decision keywords return "decision"', () => {
    expect(detectDecisionMode('为什么营业额下降')).toBe('decision');
    expect(detectDecisionMode('如何优化策略')).toBe('decision');
    expect(detectDecisionMode('有什么问题')).toBe('decision');
  });

  test('data keywords return "data"', () => {
    expect(detectDecisionMode('昨天营业额多少')).toBe('data');
    expect(detectDecisionMode('数据明细')).toBe('data');
    expect(detectDecisionMode('本周报表')).toBe('data');
  });

  test('empty/neutral text defaults to "decision"', () => {
    expect(detectDecisionMode('')).toBe('decision');
    expect(detectDecisionMode('你好')).toBe('decision');
  });
});

describe('parseStrategyHeadFromDs', () => {
  test('parses action, weightedScore, success rate, trend', () => {
    const ds = '当前最优策略：增加促销频次\nweightedScore 0.85\n成功率 75%\n趋势 improving';
    const r = parseStrategyHeadFromDs(ds);
    expect(r.action).toBe('增加促销频次');
    expect(r.ws).toBe('0.85');
    expect(r.sr).toBe('75');
    expect(r.tr).toBe('improving');
  });

  test('returns defaults when no match', () => {
    const r = parseStrategyHeadFromDs('');
    expect(r.action).toBe('先完成营业数据补录与凭据核对');
    expect(r.ws).toBe('0.50');
    expect(r.sr).toBe('0');
    expect(r.tr).toBe('stable');
  });
});

describe('stripReportStyleEnding', () => {
  test('removes trailing observation phrases', () => {
    expect(stripReportStyleEnding('需要持续观察')).toBe('');
    expect(stripReportStyleEnding('建议关注')).toBe('');
    expect(stripReportStyleEnding('可以进一步分析。')).toBe('');
    expect(stripReportStyleEnding('核心问题已定位。需要持续观察')).toBe('核心问题已定位。');
  });

  test('keeps text without trailing phrases', () => {
    expect(stripReportStyleEnding('正常运营中')).toBe('正常运营中');
  });
});

describe('trimMultiSuggestions', () => {
  test('removes content after "另外"', () => {
    expect(trimMultiSuggestions('先检查库存另外也需要确认')).toBe('先检查库存');
  });

  test('removes content after "此外"', () => {
    expect(trimMultiSuggestions('A方案。此外可以试试B')).toBe('A方案。');
  });

  test('no keywords — returns full text', () => {
    expect(trimMultiSuggestions('单一建议')).toBe('单一建议');
  });
});

describe('formatDecisionHistory', () => {
  test('formats decisions with type labels', () => {
    const decisions = [
      { decision_type: 'action_plan', title: '增加备货', content: '每日增加20%', created_at: '2026-04-01T00:00:00Z' },
    ];
    const out = formatDecisionHistory(decisions);
    expect(out).toContain('[2026-04-01]');
    expect(out).toContain('[行动计划]');
    expect(out).toContain('增加备货');
  });

  test('empty array returns empty string', () => {
    expect(formatDecisionHistory([])).toBe('');
    expect(formatDecisionHistory(null)).toBe('');
  });
});
