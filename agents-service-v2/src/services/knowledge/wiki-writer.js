import fs from 'fs';
import path from 'path';

export function shouldWriteWiki({ response }) {
  if (!response) return false;

  const r = String(response);

  if (/原因|问题|下降|异常|慢|少/.test(r)) return true;

  if (r.length > 50) return true;

  return false;
}

function matchOne(text, regex) {
  const m = text.match(regex);
  return m ? String(m[1] || '').trim().slice(0, 200) : '';
}

/**
 * 从 data_auditor 结构化输出中抽取字段（兼容【】标题与单行「键：值」）
 */
export function extractStructuredData(response) {
  const r = String(response || '');

  let problem = matchOne(
    r,
    /【核心问题】\s*([\s\S]*?)(?=\n【原因分析】|\n【引用经验】|\n【策略】|\n\n【|$)/
  );
  if (!problem) problem = matchOne(r, /核心问题[:：]\s*([^\n]+)/);

  let cause = matchOne(
    r,
    /【原因分析】\s*([\s\S]*?)(?=\n【策略】|\n【核心问题】|$)/
  );
  if (!cause) cause = matchOne(r, /原因分析[:：]?\s*([^\n]+)/);
  if (!cause) cause = matchOne(r, /原因[:：]\s*([^\n]+)/);

  let action = matchOne(r, /【策略】\s*([\s\S]*?)$/);
  if (!action) action = matchOne(r, /策略[:：]\s*([^\n]+)/);

  return {
    problem: problem.slice(0, 500),
    cause: cause.slice(0, 500),
    action: action.slice(0, 500)
  };
}

function safeWikiFilePart(s) {
  return String(s || 'unknown')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

/**
 * 将结构化知识写入本地 Markdown（knowledge/wiki）
 */
export async function writeWikiKnowledge({ agent, store, query, response, data }) {
  if (!shouldWriteWiki({ response })) return;

  const timestamp = Date.now();
  const structured = extractStructuredData(response);
  const dataSnippet =
    typeof data === 'string' ? data : JSON.stringify(data ?? {});

  const content = `

问题

${String(query || '')}

核心结论

${structured.problem || String(response).slice(0, 200)}

原因

${structured.cause || '无'}

策略

${structured.action || '无'}

结构化数据

${JSON.stringify(structured, null, 2)}

数据支撑

${dataSnippet.slice(0, 300)}
`;

  const dir = path.join(process.cwd(), 'knowledge', 'wiki');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const file = `${safeWikiFilePart(store)}_${safeWikiFilePart(agent)}_${timestamp}.md`;
  fs.writeFileSync(path.join(dir, file), content, 'utf-8');

  console.log('[WIKI WRITE]', file);
}
