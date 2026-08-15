const PPFD_OUTPUT_UNIT = "umol/m2/s";

export const LIGHT_CALIBRATION_PROFILES = Object.freeze([
  Object.freeze({
    profileId: "grow-light-01",
    version: 1,
    effectiveFrom: "2026-08-16T00:00:00+09:00",
    recordedOn: "2026-08-16",
    method: "fixed_lux_coefficient",
    luxToPpfdCoefficient: 0.01732,
    source: "user-provided grow-light conversion coefficient",
    note: "Estimated PPFD from a grow-light-specific lux coefficient; not a PAR sensor measurement."
  })
]);

function coefficient(profile) {
  return profile.luxToPpfdCoefficient;
}

export function lightCalibrationAt(measuredAt = new Date()) {
  const measuredMs = measuredAt instanceof Date
    ? measuredAt.getTime()
    : Date.parse(measuredAt);
  if (!Number.isFinite(measuredMs)) return null;
  return [...LIGHT_CALIBRATION_PROFILES]
    .reverse()
    .find((profile) => Date.parse(profile.effectiveFrom) <= measuredMs) ?? null;
}

export function activeLightCalibration() {
  return LIGHT_CALIBRATION_PROFILES.at(-1) ?? null;
}

export function publicLightCalibration(profile = activeLightCalibration()) {
  if (!profile) return null;
  return {
    profile_id: profile.profileId,
    version: profile.version,
    status: profile === activeLightCalibration() ? "active" : "superseded",
    effective_from: profile.effectiveFrom,
    recorded_on: profile.recordedOn,
    method: profile.method,
    coefficient: coefficient(profile),
    source: profile.source,
    note: profile.note,
    output: {
      metric: "estimated_ppfd",
      unit: PPFD_OUTPUT_UNIT,
      qualifier: "estimated"
    }
  };
}

export function estimatePpfd(illuminance, profile = activeLightCalibration()) {
  if (!profile || !Number.isFinite(illuminance) || illuminance < 0) return null;
  return Math.round(illuminance * coefficient(profile) * 100) / 100;
}

export function deriveLightMetrics(reading) {
  const illuminance = reading?.values?.illuminance;
  if (!Number.isFinite(illuminance) || reading?.quality?.illuminance !== "valid") {
    return null;
  }
  const profile = lightCalibrationAt(reading.measured_at);
  const value = estimatePpfd(illuminance, profile);
  if (value === null) return null;
  return {
    estimated_ppfd: {
      value,
      unit: PPFD_OUTPUT_UNIT,
      qualifier: "estimated",
      calibration_profile: profile.profileId,
      calibration_version: profile.version
    }
  };
}
