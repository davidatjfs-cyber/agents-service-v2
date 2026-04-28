import {
  zhMasterTaskStatusForAttitudeFiling,
  zhAttitudeFilingSource,
  zhExecutionFilingStatus,
  zhSeverity
} from '../status-display-zh.js';

describe('status-display-zh', () => {
  test('attitude filing: closed/settled → 已结束', () => {
    expect(zhMasterTaskStatusForAttitudeFiling('closed')).toBe('已结束');
    expect(zhMasterTaskStatusForAttitudeFiling('settled')).toBe('已结束');
  });

  test('attitude filing: hr_filed → 已备案', () => {
    expect(zhMasterTaskStatusForAttitudeFiling('hr_filed')).toBe('已备案');
  });

  test('attitude filing: other known codes', () => {
    expect(zhMasterTaskStatusForAttitudeFiling('pending_review')).toBe('待督导审核');
  });

  test('attitude source', () => {
    expect(zhAttitudeFilingSource('bi_anomaly')).toBe('BI异常任务');
    expect(zhAttitudeFilingSource('random_inspection')).toBe('随机抽检');
  });

  test('execution filing: legacy pending_review → 已备案', () => {
    expect(zhExecutionFilingStatus('pending_review')).toBe('已备案');
    expect(zhExecutionFilingStatus('已备案')).toBe('已备案');
  });

  test('severity', () => {
    expect(zhSeverity('high')).toBe('高');
    expect(zhSeverity('medium')).toBe('中');
  });
});
