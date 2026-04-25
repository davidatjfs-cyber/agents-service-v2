import {
  resolvePerformanceReportDisplayName,
  isMajixianPmObserverUsername,
  majixianPmNewModelLookupUsername,
  majixianPmHrmsMirrorTargets,
  isMajixianStore,
  sortFeishuScoringRows
} from '../scoring-assignee.js';

describe('isMajixianStore', () => {
  test('马己仙 store returns true', () => {
    expect(isMajixianStore('马己仙上海音乐广场店')).toBe(true);
    expect(isMajixianStore('马己仙')).toBe(true);
  });

  test('非马己仙 store returns false', () => {
    expect(isMajixianStore('洪潮大宁久光店')).toBe(false);
    expect(isMajixianStore('')).toBe(false);
    expect(isMajixianStore(null)).toBe(false);
  });
});

describe('isMajixianPmObserverUsername', () => {
  test('nnyxcs35 returns true', () => {
    expect(isMajixianPmObserverUsername('nnyxcs35')).toBe(true);
    expect(isMajixianPmObserverUsername('NNYXCS35')).toBe(true);
  });

  test('other usernames return false', () => {
    expect(isMajixianPmObserverUsername('NNYXLYR04')).toBe(false);
    expect(isMajixianPmObserverUsername('')).toBe(false);
  });
});

describe('resolvePerformanceReportDisplayName', () => {
  test('马己仙出品经理 with observer username returns 黎永荣', () => {
    const result = resolvePerformanceReportDisplayName(
      '马己仙上海音乐广场店', 'store_production_manager', 'nnyxcs35', '测试'
    );
    expect(result).toBe('黎永荣');
  });

  test('马己仙出品经理 canonical user returns display name', () => {
    const result = resolvePerformanceReportDisplayName(
      '马己仙上海音乐广场店', 'store_production_manager', 'NNYXLYR04', '黎永荣'
    );
    expect(result).toBe('黎永荣');
  });

  test('non-majixian returns raw name', () => {
    const result = resolvePerformanceReportDisplayName(
      '洪潮大宁久光店', 'store_manager', 'NNYXXMJ06', '徐曼金'
    );
    expect(result).toBe('徐曼金');
  });

  test('no raw name falls back to username', () => {
    const result = resolvePerformanceReportDisplayName(
      '洪潮大宁久光店', 'store_manager', 'NNYXXMJ06', ''
    );
    expect(result).toBe('NNYXXMJ06');
  });

  test('test name in majixian PM returns 黎永荣', () => {
    const result = resolvePerformanceReportDisplayName(
      '马己仙上海音乐广场店', 'store_production_manager', 'some_user', '测试'
    );
    expect(result).toBe('黎永荣');
  });
});

describe('majixianPmNewModelLookupUsername', () => {
  test('马己仙 with observer returns canonical', () => {
    expect(majixianPmNewModelLookupUsername('nnyxcs35', '马己仙上海音乐广场店')).toBe('NNYXLYR04');
  });

  test('non-majixian returns original', () => {
    expect(majixianPmNewModelLookupUsername('nnyxcs35', '洪潮大宁久光店')).toBe('nnyxcs35');
  });
});

describe('majixianPmHrmsMirrorTargets', () => {
  test('马己仙 with canonical PM returns observer list', () => {
    const targets = majixianPmHrmsMirrorTargets('NNYXLYR04', '马己仙上海音乐广场店');
    expect(targets).toContain('nnyxcs35');
  });

  test('non-majixian returns empty', () => {
    expect(majixianPmHrmsMirrorTargets('NNYXLYR04', '洪潮大宁久光店')).toEqual([]);
  });

  test('non-canonical username returns empty', () => {
    expect(majixianPmHrmsMirrorTargets('nnyxcs35', '马己仙上海音乐广场店')).toEqual([]);
  });
});

describe('sortFeishuScoringRows', () => {
  const rows = [
    { username: 'nnyxcs35', name: '测试' },
    { username: 'NNYXLYR04', name: '黎永荣' },
    { username: 'other_user', name: '其他人' }
  ];

  test('马己仙 PM sorts canonical first', () => {
    const sorted = sortFeishuScoringRows('马己仙上海音乐广场店', 'store_production_manager', rows);
    expect(sorted[0].username).toBe('NNYXLYR04');
  });

  test('non-majixian returns original order', () => {
    const sorted = sortFeishuScoringRows('洪潮大宁久光店', 'store_manager', rows);
    expect(sorted).toEqual(rows);
  });
});
