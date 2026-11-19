export const INTERVALS = [300, 600, 900, 1800, 3600];
export function intervalSeconds(schedule, fallback = 900) {
  return INTERVALS.includes(schedule?.applied_interval_seconds) ? schedule.applied_interval_seconds : fallback;
}
export function staleMilliseconds(schedule) { return (intervalSeconds(schedule) * 2 + 300) * 1000; }
export function scheduleLabel(schedule) {
  if (!schedule) return '관측 주기 미보고 · 기존 펌웨어';
  const reasons = { default_setting: '기본 설정', manual_setting: '사용자 설정',
    emergency_voltage: '저전압 비상 절전', battery_unavailable: '전압 확인 불가 · 비상 절전' };
  return `${intervalSeconds(schedule) / 60}분 주기 · ${reasons[schedule.reason] || '사유 미확인'}`;
}
