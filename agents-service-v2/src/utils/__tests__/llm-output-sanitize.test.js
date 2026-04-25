import {
  stripEmbeddedReasoningTags,
  sanitizeUserFacingLlmText
} from '../llm-output-sanitize.js';

describe('stripEmbeddedReasoningTags', () => {
  const lt = String.fromCharCode(60); // <
  const gt = String.fromCharCode(62); // >

  test('removes redacted_thinking tags', () => {
    const input = 'Hello ' + lt + 'redacted_thinking' + gt + 'some reasoning' + lt + '/redacted_thinking' + gt + ' World';
    expect(stripEmbeddedReasoningTags(input)).toBe('Hello  World');
  });

  test('handles think tag variant with leading space', () => {
    const input = 'A\n' + lt + 'think' + gt + ' deep thoughts ' + lt + String.fromCharCode(47) + 'think' + gt + '\nB';
    expect(stripEmbeddedReasoningTags(input)).toBe('A\n\nB');
  });

  test('returns trimmed result', () => {
    const input = lt + 'redacted_thinking' + gt + 'xyz' + lt + '/redacted_thinking' + gt + '   ';
    expect(stripEmbeddedReasoningTags(input)).toBe('');
  });

  test('handles nested-like tags', () => {
    const openR = lt + 'redacted_thinking' + gt;
    const closeR = lt + '/redacted_thinking' + gt;
    const openT = lt + 'thinking' + gt;
    const closeT = lt + '/think' + gt;
    const input = 'OK ' + openR + openT + 'nested' + closeT + closeR + ' done';
    expect(stripEmbeddedReasoningTags(input)).toBe('OK  done');
  });

  test('returns empty string for empty input', () => {
    expect(stripEmbeddedReasoningTags('')).toBe('');
    expect(stripEmbeddedReasoningTags(null)).toBe('');
    expect(stripEmbeddedReasoningTags(undefined)).toBe('');
  });

  test('passes through text without tags', () => {
    expect(stripEmbeddedReasoningTags('Hello 世界')).toBe('Hello 世界');
  });
});

describe('sanitizeUserFacingLlmText', () => {
  const lt = String.fromCharCode(60);
  const gt = String.fromCharCode(62);

  test('strips redacted_thinking tags then returns text', () => {
    const input = lt + 'redacted_thinking' + gt + 'analyzing data' + lt + '/redacted_thinking' + gt + ' 您好，以下是昨日的营业数据';
    expect(sanitizeUserFacingLlmText(input)).toBe('您好，以下是昨日的营业数据');
  });

  test('uses Draft: separator', () => {
    const input = 'Some thoughts\n*Draft:* 您好，今日的营业分析如下：\n\n营收增长5%';
    const result = sanitizeUserFacingLlmText(input);
    expect(result).toContain('您好');
    expect(result).toContain('营收增长5%');
  });

  test('uses 【给用户的结论】 separator', () => {
    const input = '步骤1: 计算数据\n步骤2: 分析\n【给用户的结论】您好，昨日营收达成率95%';
    const result = sanitizeUserFacingLlmText(input);
    expect(result).toContain('您好');
    expect(result).toContain('95%');
  });

  test('skips English metadata lines, keeps Chinese body', () => {
    const input = 'User Role: store_manager\nContext: daily report analysis\nAs an assistant, I should provide analysis.\n\n您好，以下是昨日营业分析：\n昨日实收营收 ¥50,000，达成率 95%';
    const result = sanitizeUserFacingLlmText(input);
    expect(result).toContain('昨日实收营收');
    expect(result).not.toContain('User Role');
    expect(result).not.toContain('Context:');
  });

  test('handles Chinese bullet points', () => {
    const input = '1. 营收：¥50,000\n2. 人效：¥1,200/人\n3. 总结：表现良好';
    const result = sanitizeUserFacingLlmText(input);
    expect(result).toContain('营收');
    expect(result).toContain('表现良好');
  });

  test('returns stripped text if no Chinese body found', () => {
    const input = lt + 'redacted_thinking' + gt + 'calculating...' + lt + '/redacted_thinking' + gt + 'Some English text';
    expect(sanitizeUserFacingLlmText(input)).toBe('Some English text');
  });

  test('returns empty for empty input', () => {
    expect(sanitizeUserFacingLlmText('')).toBe('');
    expect(sanitizeUserFacingLlmText(null)).toBe('');
    expect(sanitizeUserFacingLlmText(undefined)).toBe('');
  });

  test('handles section headers with 【】', () => {
    const input = '【营收数据】\n昨日实收 ¥50,000\n【人效数据】\n人效 ¥1,200';
    const result = sanitizeUserFacingLlmText(input);
    expect(result).toContain('【营收数据】');
    expect(result).toContain('【人效数据】');
  });
});
