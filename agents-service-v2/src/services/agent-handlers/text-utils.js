/**
 * Text utility functions extracted from agent-handlers.js
 * V2 aligned with V1 data sources & reply templates (2026-03-08)
 */
import { logger } from '../../utils/logger.js';

const NOW_CN = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
// pg DATE 列返回 JS Date 对象，需用上海时区格式化避免年份丢失
const FMT_DATE = (d) => {
  if (!d) return '';
  if (d instanceof Date) return d.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
  return String(d).slice(0, 10);
};

function extractFirstBalancedJsonObject(s) {
  const str = String(s || '');
  const start = str.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  return null;
}

/** 模型偶发把 JSON 转义序列当字面量输出到字符串里，飞书上会显示成 \\n；解析后做一次还原。 */
function decodeJsonStringEscapesForFeishu(s) {
  if (s == null || typeof s !== 'string') return s;
  return s
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * 从 LLM 响应中清除意外输出的 JSON 块，确保飞书消息只含自然语言。
 * 与 master-planner.js 的同名函数保持一致。
 */
function stripJsonFromResponse(text) {
  if (!text) return text;
  const marker = '「给用户的结论」'; // noop, use direct string
  const mIdx = text.indexOf('【给用户的结论】');
  if (mIdx !== -1) return text.slice(mIdx + 8).trim();
  // 去除独立的 JSON 对象块（含关键字段名）
  let cleaned = text.replace(/\{[\s\S]*?"(?:summary|problems|actions|needs_task|needs_approval)"[\s\S]*?\}/g, '').trim();
  // 去除【结构化输出/决策】之后的所有内容
  cleaned = cleaned.replace(/【结构化(?:输出|决策)】[\s\S]*$/g, '').trim();
  return cleaned || text;
}

export { NOW_CN, FMT_DATE, extractFirstBalancedJsonObject, decodeJsonStringEscapesForFeishu, stripJsonFromResponse };
