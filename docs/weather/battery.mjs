// Samsung INR18650-35E, Nov 2014 tentative specification, p.3:
// room-temperature 0.2C discharge (680 mA), measured capacity 3482 mAh,
// cutoff 2.65 V. Points digitized from the graph; percent = 100*(1-Q/3482).
// This is NOT a resting OCV curve or a calibrated SOC measurement.
// Charging, temperature, load and ageing affect terminal voltage.
// 4.2 V is the full-charge endpoint; 3.3 V operating reserve is separate.
export const BATTERY_MODEL_VERSION = "samsung-35e-2014-0p2c-v1";
const points = [
  [2.65, 0], [2.7, .5], [2.8, 1.5], [2.9, 3.1], [3, 5.1],
  [3.1, 8], [3.2, 10.9], [3.3, 14.3], [3.4, 21.6], [3.48, 30.5],
  [3.5, 33.3], [3.6, 45.4], [3.7, 55.7], [3.8, 66.8], [3.9, 77.4],
  [4, 87.1], [4.1, 98.9], [4.15, 99.8], [4.2, 100],
];
export function estimatedBatteryPercent(voltage) {
  if (typeof voltage !== "number" || !Number.isFinite(voltage) || voltage < 2 || voltage > 4.5) return null;
  if (voltage <= points[0][0]) return 0;
  for (let i = 1; i < points.length; i++) {
    const [v, p] = points[i], [pv, pp] = points[i - 1];
    if (voltage <= v) return Math.round(pp + (voltage - pv) / (v - pv) * (p - pp));
  }
  return 100;
}
