/**
 * 飞书用户可见文本：去掉模型推理链 / 英文元信息，只保留面向用户的正文。
 * Ollama 等模型会把推理放在 thinking 字段——绝不能当作用户回复（见 llm-provider.js）。
 */

/** 去掉常见内嵌推理块（content 里夹带 thinking 标签时） */
export function stripEmbeddedReasoningTags(text) {
  return String(text || '')
    .replace(/<redacted_thinking>[\s\S]*?<\/redacted_thinking>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
}

const META_LINE =
  /^(User Role|My Role|Constraint|Constraints|Current Context|Context|Next steps|Step\s*\d+|Validation|Role|No JSON|Check\)|The user|As a|I'm\b|I am\b|---+)\s*[:：]?\s*/i;

/**
 * 去掉开头的英文调度/自检提纲，从第一条像「给用户的话」的行开始保留。
 */
export function sanitizeUserFacingLlmText(text, opts = {}) {
  const raw = stripEmbeddedReasoningTags(String(text || '').trim());
  if (!raw) return raw;

  if (opts.allowLeadingJson && /^\s*\{/.test(raw)) {
    try {
      JSON.parse(raw);
      return raw;
    } catch {
      /* fall through */
    }
  }

  const draftIdx = raw.search(/\*?\*?Draft\*?\*?\s*[:：]/i);
  if (draftIdx >= 0) {
    const tail = raw.slice(draftIdx).replace(/^\*?\*?Draft\*?\*?\s*[:：]\s*/i, '').trim();
    if (tail.length >= 15) return tail;
  }

  const conclusionIdx = raw.indexOf('【给用户的结论】');
  if (conclusionIdx >= 0) {
    const tail = raw.slice(conclusionIdx + '【给用户的结论】'.length).trim();
    if (tail.length >= 10) return tail;
  }

  const lines = raw.split(/\r?\n/);
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      if (start === i) start = i + 1;
      continue;
    }
    if (META_LINE.test(line)) continue;
    if (/^[\-*]\s*(Check|Validation|Step)/i.test(line)) continue;

    const han = (line.match(/[\u4e00-\u9fff]/g) || []).length;
    const lat = (line.match(/[a-zA-Z]/g) || []).length;
    if (han >= 4 && han >= lat * 0.5) {
      start = i;
      break;
    }
    if (/^【[^】]{1,20}】/.test(line) && han >= 2) {
      start = i;
      break;
    }
    if (/^\d+[\.\、]\s*[\u4e00-\u9fff]/.test(line)) {
      start = i;
      break;
    }
  }

  const out = lines.slice(start).join('\n').trim();
  if (out.length >= 12) return out;
  return raw;
}
