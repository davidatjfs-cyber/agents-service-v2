#!/usr/bin/env node
/**
 * MemPalace A/B：同一进程内切换 ENABLE_MEMPALACE，对比 marketing_planner（strategy_agent）输出。
 * 依赖：.env 中 LLM / DB 等配置（与线上一致）。
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { decideStrategy } from '../src/services/marketing-strategy-engine.js';

/** 本地 A/B：若未显式配置 MEMPALACE_URL，则对齐 monorepo 内 mempalace/.active-port，避免沿用失效端口 */
function ensureMemPalaceUrlForLocalAb() {
  if (String(process.env.MEMPALACE_URL || '').trim()) return;
  try {
    const pf = join(process.cwd(), '../mempalace/.active-port');
    if (existsSync(pf)) {
      const port = readFileSync(pf, 'utf8').trim();
      if (/^\d+$/.test(port)) process.env.MEMPALACE_URL = `http://127.0.0.1:${port}`;
    }
  } catch {
    /* ignore */
  }
  if (!String(process.env.MEMPALACE_URL || '').trim()) {
    process.env.MEMPALACE_URL = 'http://127.0.0.1:3001';
  }
}

const testCases = [
  '最近连续下雨，晚市客流下降怎么办',
  '老客户复购率下降怎么办'
];

/** 仅能通过 MemPalace 注入的特殊策略词（非常识可猜） */
function detectSpecialStrategy(text) {
  const t = String(text || '');
  return t.includes('隐藏菜单') || t.includes('雨天免配送费');
}

function compareOutputs(noMem, withMem) {
  return {
    same: noMem === withMem,
    length_diff: Math.abs(noMem.length - withMem.length),
    no_memory_used_special_strategy: detectSpecialStrategy(noMem),
    with_memory_used_special_strategy: detectSpecialStrategy(withMem)
  };
}

function stdev(vals) {
  if (!vals.length) return 0;
  const m = vals.reduce((x, y) => x + y, 0) / vals.length;
  const v = vals.reduce((s, x) => s + (x - m) ** 2, 0) / vals.length;
  return Math.sqrt(v);
}

function baseCtx(input) {
  return {
    storeId: 'test_store',
    store: 'test_store',
    input,
    role: 'store_manager',
    name: 'ABTester'
  };
}

async function runRound(dispatchToAgent, enable, inputs) {
  process.env.ENABLE_MEMPALACE = enable ? 'true' : 'false';
  const outs = [];
  for (const input of inputs) {
    const r = await dispatchToAgent('marketing_planner', input, baseCtx(input));
    outs.push(String(r.response ?? r.error ?? ''));
  }
  return outs;
}

async function main() {
  ensureMemPalaceUrlForLocalAb();
  const { dispatchToAgent } = await import('../src/services/agent-handlers.js');
  const noMemory = await runRound(dispatchToAgent, false, testCases);
  const withMemory = await runRound(dispatchToAgent, true, testCases);

  const cases = testCases.map((input, i) => ({
    input,
    /** A 路等价：引擎在无任何 MemPalace 行时的结构化策略（与 ENABLE_MEMPALACE=false 一致） */
    decide_strategy_memories_empty: decideStrategy({ input, memories: [] }),
    no_memory_output: noMemory[i],
    with_memory_output: withMemory[i],
    no_memory: { used_special_strategy: detectSpecialStrategy(noMemory[i]) },
    with_memory: { used_special_strategy: detectSpecialStrategy(withMemory[i]) }
  }));

  let differentCount = 0;
  const perCompare = testCases.map((input, i) => {
    const c = compareOutputs(noMemory[i], withMemory[i]);
    if (!c.same) differentCount++;
    return { input, ...c };
  });

  const anySpecialNoMem = perCompare.some((p) => p.no_memory_used_special_strategy);
  const anySpecialWithMem = perCompare.some((p) => p.with_memory_used_special_strategy);

  const lenNo = noMemory.map((s) => s.length);
  const lenWith = withMemory.map((s) => s.length);
  const stdevNo = stdev(lenNo);
  const stdevWith = stdev(lenWith);
  const avgLengthDiff = perCompare.reduce((s, x) => s + x.length_diff, 0) / perCompare.length;

  const lengthStable =
    stdevNo === 0 && stdevWith === 0 ? null : stdevWith < stdevNo;

  const summary = {
    total_cases: testCases.length,
    different_count: differentCount,
    different_pct: (differentCount / testCases.length) * 100,
    memory_value_gate: {
      expect_no_special_without_memory: !anySpecialNoMem,
      expect_special_with_memory: anySpecialWithMem,
      pass:
        !anySpecialNoMem && anySpecialWithMem && differentCount > 0,
      criteria: [
        '无 memory：输出不应含「隐藏菜单」「雨天免配送费」',
        '有 memory：输出应至少含其一（来自 MemPalace 专用测试记忆）',
        'different_pct > 0：两路正文须有差异'
      ],
      hint:
        '若 pass=false：检查 marketing-strategy-engine 的 decideStrategy 是否在无 memory 时避开专用词、有 memory 时命中规则；并确认 MemPalace 含「雨天」「隐藏菜单」测试记忆、OPENAI_API_KEY、MEMPALACE_URL'
    },
    per_case_compare: perCompare,
    length_stdev_no_memory: Number(stdevNo.toFixed(2)),
    length_stdev_with_memory: Number(stdevWith.toFixed(2)),
    memory_made_cross_case_length_more_stable: lengthStable,
    avg_abs_length_diff_between_modes: Number(avgLengthDiff.toFixed(2)),
    interpretation: {
      outputs_differ: differentCount > 0,
      length_stability:
        lengthStable === null
          ? '各用例输出长度相同或全为 0，无法比较跨题波动'
          : lengthStable
            ? '开启 memory 后，跨用例输出长度波动更小'
            : stdevWith > stdevNo
              ? '开启 memory 后，跨用例输出长度波动更大'
              : '两路长度波动相同'
    }
  };

  const payload = { cases, summary, generated_at: Date.now() };
  writeFileSync('/tmp/memory_ab_result.json', JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
