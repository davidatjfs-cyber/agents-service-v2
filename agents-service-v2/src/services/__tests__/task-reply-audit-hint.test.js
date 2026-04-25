import { formatTaskCardAuditSection, TASK_REPLY_AUDIT_HINT_ZH } from '../task-reply-audit-hint.js';

describe('TASK_REPLY_AUDIT_HINT_ZH', () => {
  test('is a non-empty string with audit rules', () => {
    expect(typeof TASK_REPLY_AUDIT_HINT_ZH).toBe('string');
    expect(TASK_REPLY_AUDIT_HINT_ZH.length).toBeGreaterThan(50);
    expect(TASK_REPLY_AUDIT_HINT_ZH).toContain('系统审核要求');
    expect(TASK_REPLY_AUDIT_HINT_ZH).toContain('≥20 字');
  });
});

describe('formatTaskCardAuditSection', () => {
  test('returns default hint when no extra config', () => {
    expect(formatTaskCardAuditSection()).toBe(TASK_REPLY_AUDIT_HINT_ZH);
    expect(formatTaskCardAuditSection('')).toBe(TASK_REPLY_AUDIT_HINT_ZH);
    expect(formatTaskCardAuditSection(null)).toBe(TASK_REPLY_AUDIT_HINT_ZH);
  });

  test('appends extra config to hint', () => {
    const result = formatTaskCardAuditSection('注意食品安全');
    expect(result).toContain(TASK_REPLY_AUDIT_HINT_ZH);
    expect(result).toContain('本任务补充');
    expect(result).toContain('注意食品安全');
  });

  test('trims whitespace from extra config', () => {
    const result = formatTaskCardAuditSection('  额外说明  ');
    expect(result).toContain('额外说明');
  });
});
