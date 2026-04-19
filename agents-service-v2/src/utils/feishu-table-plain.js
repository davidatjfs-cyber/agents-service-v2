/**
 * 飞书 IM 的 text / reply 消息不渲染 GFM 表格，用户会看到裸露的 | 竖线。
 * 将常见 Markdown 表格块转为分行、带列名的纯文本，便于手机阅读。
 */
export function flattenMarkdownTablesForFeishu(text) {
  const s = String(text || '');
  if (!s.includes('|')) return s;

  const lines = s.split(/\r?\n/);
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const next = lines[i + 1] || '';

    const isSeparator = /^\s*\|[\s\-:|]+\|\s*$/.test(next);
    const looksLikeTableRow = /^\s*\|/.test(line) && line.includes('|');

    if (looksLikeTableRow && isSeparator) {
      const headerCells = line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);

      i += 2;

      const rowBlocks = [];
      while (i < lines.length) {
        const rowLine = lines[i];
        if (!rowLine || !String(rowLine).trim()) break;
        if (/^\s*\|[\s\-:|]+\|\s*$/.test(rowLine)) {
          i += 1;
          continue;
        }
        if (!/^\s*\|/.test(rowLine)) break;

        const cells = rowLine
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());

        if (headerCells.length) {
          const pairs = headerCells.map((h, idx) => {
            const v = cells[idx] != null ? String(cells[idx]) : '';
            return `${h}：${v}`;
          });
          rowBlocks.push('• ' + pairs.join('　'));
        } else {
          rowBlocks.push('• ' + cells.filter(Boolean).join('　'));
        }
        i += 1;
      }

      if (rowBlocks.length) {
        out.push('【表格】');
        out.push(...rowBlocks);
        out.push('');
      }
      continue;
    }

    out.push(line);
    i += 1;
  }

  return out.join('\n');
}
