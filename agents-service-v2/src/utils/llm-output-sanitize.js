/**
 * 飞书用户可见文本净化：去掉模型推理链 / 英文元信息，只保留面向用户的正文。
 *
 * 根本原因：Ollama 等模型把 system prompt 的「角色/约束」在 content 里原样回显，
 * 或把内部英文推理放在 content 字段而非 thinking 字段。
 * 本模块在发到飞书前做最后一道清洗。
 */

/** 去掉 thinking 标签包裹的推理块 */
export function stripEmbeddedReasoningTags(text) {
  return String(text || '')
    .replace(/<redacted_thinking>[\s\S]*?<\/redacted_thinking>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
}

// ── 高置信英文元信息行：这些行一定是系统 prompt 回显，不应该出现在用户回复里 ──
const HARD_SKIP_LINE = /^[\s*#\-]*(?:User\s+Role|My\s+Role|Constraint|Constraints|Current\s+Context|Context(?=[\s:：]|$)|Next\s+steps?|Step\s+\d|Validation|No\s+JSON|No\s+fabrication|Check\)|As\s+a\b|I\s+am\b|I'm\b|The\s+user|Actionable\s+(?:Advice|Steps)|Problem\s+Analysis)[\s:：]?/i;

// ── 确定「这是正式中文回复」的条件 ──
function looksLikeChineseReply(line) {
  const t = line.trim();
  if (!t) return false;
  // 段落标题 【xxx】
  if (/^【[^】]{1,30}】/.test(t)) return true;
  // 数字编号 + 中文
  if (/^\d+[\.\、]\s*[\u4e00-\u9fff]/.test(t)) return true;
  // 正文行：汉字比例够高
  const han = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const lat = (t.match(/[a-zA-Z]/g) || []).length;
  if (han >= 5 && han >= lat) return true;
  // 含汉字的短句（标题行如「您好！」）
  if (han >= 2 && t.length <= 20) return true;
  return false;
}

/**
 * 主净化入口：
 * 1. 去掉 thinking 标签
 * 2. 找到 *Draft:* / Draft: 标记（模型明确的分隔符）→ 只留之后部分
 * 3. 找到 【给用户的结论】→ 只留之后部分
 * 4. 逐行扫描：跳过「高置信英文元信息行」，到第一条中文正文为止
 */
export function sanitizeUserFacingLlmText(text, _opts = {}) {
  const stripped = stripEmbeddedReasoningTags(String(text || '').trim());
  if (!stripped) return stripped;

  // ── 优先：*Draft:* 或 Draft: 分隔 ──
  const draftM = stripped.match(/\*?\*?Draft\*?\*?\s*[:：]\s*/i);
  if (draftM) {
    const after = stripped.slice((draftM.index || 0) + draftM[0].length).trim();
    if (after.length >= 15) return after;
  }

  // ── 次优：【给用户的结论】 ──
  const conclusionIdx = stripped.indexOf('【给用户的结论】');
  if (conclusionIdx >= 0) {
    const after = stripped.slice(conclusionIdx + '【给用户的结论】'.length).trim();
    if (after.length >= 10) return after;
  }

  // ── 逐行扫描：找第一条「中文正文」起点 ──
  const lines = stripped.split(/\r?\n/);
  let startIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    // 空行：若还没找到起点，继续
    if (!t) continue;

    // 明确是元信息行 → 跳过
    if (HARD_SKIP_LINE.test(t)) continue;

    // 英文子弹行：* "Revenue/Target": ... 或 * Dine-in vs Delivery 等
    if (/^\*\s*["']?[A-Z]/.test(t)) continue;

    // 全英文子弹/星号行（*  Some English text）→ 跳过
    const han = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    const lat = (t.match(/[a-zA-Z]/g) || []).length;
    if (han === 0 && lat > 3) continue;

    // 找到中文正文
    if (looksLikeChineseReply(t)) {
      startIdx = i;
      break;
    }

    // 含少量汉字但英文更多 → 可能是混排元信息，继续跳
    if (han > 0 && lat > han * 2) continue;

    // 其他行（符号、数字等）：如果后面有中文，暂时跳过
    // 如果确实无法判断，遇到第一条非空、非纯英文行就停
    if (han > 0) {
      startIdx = i;
      break;
    }
  }

  if (startIdx >= 0) {
    const out = lines.slice(startIdx).join('\n').trim();
    if (out.length >= 10) return out;
  }

  // 兜底：原文（已去掉 thinking 标签）
  return stripped;
}
