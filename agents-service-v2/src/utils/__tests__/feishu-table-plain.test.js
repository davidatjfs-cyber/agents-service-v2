import { flattenMarkdownTablesForFeishu } from '../feishu-table-plain.js';

describe('flattenMarkdownTablesForFeishu', () => {
  test('converts a simple markdown table into plain text key-value pairs', () => {
    const input = `| 指标 | 数值 |
|---|---|
| 营收 | ¥50,000 |
| 人效 | ¥1,200 |`;
    const result = flattenMarkdownTablesForFeishu(input);
    expect(result).toContain('【表格】');
    expect(result).toContain('• 指标：营收　数值：¥50,000');
    expect(result).toContain('• 指标：人效　数值：¥1,200');
  });

  test('handles table with single column', () => {
    const input = `| 项目 |
|---|
| 营收增长5% |
| 成本下降3% |`;
    const result = flattenMarkdownTablesForFeishu(input);
    expect(result).toContain('【表格】');
    expect(result).toContain('• 项目：营收增长5%');
    expect(result).toContain('• 项目：成本下降3%');
  });

  test('passes through text without pipe characters unchanged', () => {
    const input = '这是一段普通文本\n没有表格';
    expect(flattenMarkdownTablesForFeishu(input)).toBe(input);
  });

  test('passes through text with pipes but no table structure', () => {
    const input = '使用 | 符号但不是表格';
    expect(flattenMarkdownTablesForFeishu(input)).toBe(input);
  });

  test('returns empty string for empty input', () => {
    expect(flattenMarkdownTablesForFeishu('')).toBe('');
  });

  test('returns empty string for null/undefined', () => {
    expect(flattenMarkdownTablesForFeishu(null)).toBe('');
    expect(flattenMarkdownTablesForFeishu(undefined)).toBe('');
  });

  test('preserves non-table text around a table', () => {
    const input = `昨日经营数据如下：
| 指标 | 数值 |
|---|---|
| 营收 | ¥50,000 |
请查收。`;
    const result = flattenMarkdownTablesForFeishu(input);
    expect(result).toContain('昨日经营数据如下：');
    expect(result).toContain('【表格】');
    expect(result).toContain('请查收。');
  });

  test('handles multiple tables in one input', () => {
    const input = `| A | B |
|---|---|
| 1 | 2 |

| C | D |
|---|---|
| 3 | 4 |`;
    const result = flattenMarkdownTablesForFeishu(input);
    expect(result).toContain('• A：1　B：2');
    expect(result).toContain('• C：3　D：4');
  });

  test('handles separator line without header (passes through)', () => {
    const input = `|---|---|
| val |`;
    const result = flattenMarkdownTablesForFeishu(input);
    expect(result).toBe(input);
  });

  test('handles empty data rows', () => {
    const input = `| H |
|---|
| val |
|
| val2 |`;
    const result = flattenMarkdownTablesForFeishu(input);
    expect(result).toContain('• H：val');
    expect(result).toContain('• H：val2');
  });

  test('handles table with extra separator lines', () => {
    const input = `| K | V |
|---|---|
| a | 1 |
|---|---|
| b | 2 |`;
    const result = flattenMarkdownTablesForFeishu(input);
    expect(result).toContain('• K：a　V：1');
    expect(result).toContain('• K：b　V：2');
  });

  test('preserves text line with leading pipe but no separator next', () => {
    const input = '| 这不是表格头\n普通文字';
    expect(flattenMarkdownTablesForFeishu(input)).toBe('| 这不是表格头\n普通文字');
  });
});
