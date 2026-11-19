import { normalizeExperimentStatus } from './experiments.js';
export const HARDWARE = "firebeetle2-esp32c6-v1.2";
export const MAX_FIRMWARE_BYTES = 0x1b0000;
export const SHA_PATTERN = /^[a-f0-9]{64}$/;
export const VERSION_PATTERN = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
export const INTERVALS = Object.freeze([300, 600, 900, 1800, 3600]);
export const SOLAR_MODEL = 'noaa-fractional-v1-todoroki';
const jstDate = ms => new Date(ms + 9*3600000).toISOString().slice(0,10);
export function normalizeAstronomy(input, measuredMs, schedule) {
  const date = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  const dawn=date(input?.astronomical_dawn), dusk=date(input?.astronomical_dusk);
  if (!input || input.model!==SOLAR_MODEL || typeof input.night!=='boolean' || typeof input.night_closing!=='boolean' ||
      typeof input.solar_altitude_deg!=='number' || !Number.isFinite(input.solar_altitude_deg) || Math.abs(input.solar_altitude_deg)>90 ||
      !Number.isFinite(measuredMs) || !Number.isFinite(dawn) || !Number.isFinite(dusk) || dawn>=dusk ||
      jstDate(dawn)!==jstDate(measuredMs) || jstDate(dusk)!==jstDate(measuredMs) ||
      (Math.abs(input.solar_altitude_deg+18)>.02 && input.night!==(input.solar_altitude_deg < -18)) ||
      (input.night_closing && (!schedule || !input.night || measuredMs<dusk || measuredMs-dusk>(schedule.applied_interval_seconds+300)*1000)))
    throw new Error('Invalid astronomy metadata');
  return {model:input.model,solar_altitude_deg:input.solar_altitude_deg,night:input.night,night_closing:input.night_closing,
    astronomical_dawn:new Date(dawn).toISOString(),astronomical_dusk:new Date(dusk).toISOString()};
}
export function normalizeSchedule(input) {
  if (!input || !INTERVALS.includes(input.normal_interval_seconds) ||
      !INTERVALS.includes(input.applied_interval_seconds) ||
      !Number.isInteger(input.revision) || input.revision < 0 || input.revision > 2147483647 ||
      !['default_setting','manual_setting','emergency_voltage','battery_unavailable'].includes(input.reason) ||
      (['emergency_voltage','battery_unavailable'].includes(input.reason)
        ? input.applied_interval_seconds !== 3600
        : input.applied_interval_seconds !== input.normal_interval_seconds)) throw new Error('Invalid station schedule');
  return Object.fromEntries(['normal_interval_seconds','applied_interval_seconds','revision','reason'].map(k => [k,input[k]]));
}
export function manifestMessage(manifest) {
  return `weather-ota-v1\n${manifest.hardware}\n${manifest.version}\n${manifest.size}\n${manifest.sha256}`;
}
export function validateManifest(manifest) {
  if (!manifest || manifest.hardware !== HARDWARE || !VERSION_PATTERN.test(manifest.version) ||
      !SHA_PATTERN.test(manifest.sha256) || !Number.isInteger(manifest.size) ||
      manifest.size < 512 || manifest.size > MAX_FIRMWARE_BYTES ||
      typeof manifest.signature !== "string" || !/^[A-Za-z0-9+/]{342}==$/.test(manifest.signature)) {
    throw new Error("Invalid station release manifest");
  }
  return Object.fromEntries(["hardware", "version", "size", "sha256", "signature"].map(key => [key, manifest[key]]));
}
export async function verifyManifest(manifest, pem) {
  try {
    validateManifest(manifest);
    if (typeof pem !== "string" || !pem.includes("BEGIN PUBLIC KEY")) return false;
    const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), ch => ch.charCodeAt(0));
    const key = await crypto.subtle.importKey("spki", der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (key.algorithm.modulusLength !== 2048) return false;
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key,
      Uint8Array.from(atob(manifest.signature), ch => ch.charCodeAt(0)),
      new TextEncoder().encode(manifestMessage(manifest)));
  } catch { return false; }
}
export function normalizeStatus(input) {
  if (!input || !VERSION_PATTERN.test(input.firmware_version) ||
      !["normal", "maintenance", "emergency"].includes(input.mode) ||
      !Number.isInteger(input.queued) || input.queued < 0 || input.queued > 1344 ||
      !Number.isSafeInteger(input.dropped) || input.dropped < 0 ||
      !Number.isInteger(input.ota_attempts) || input.ota_attempts < 0 || input.ota_attempts > 3 ||
      !(input.ota_sha256 === "" || SHA_PATTERN.test(input.ota_sha256)) ||
      !Number.isSafeInteger(input.ota_next_attempt) || input.ota_next_attempt < 0) {
    throw new Error("Invalid station status");
  }
  const status = Object.fromEntries(["firmware_version", "mode", "queued", "dropped", "ota_attempts",
    "ota_sha256", "ota_next_attempt"].map(key => [key, input[key]]));
  if (input.schedule !== undefined) {
    status.schedule = normalizeSchedule(input.schedule);
    if (!['normal','emergency'].includes(input.power_mode) ||
        !(input.battery_voltage === null || (typeof input.battery_voltage === 'number' && Number.isFinite(input.battery_voltage) && input.battery_voltage >= 2 && input.battery_voltage <= 4.5)) ||
        input.automatic_ota_min_voltage !== 3.6 || input.manual_ota_min_voltage !== 3.5)
      throw new Error('Invalid power status');
    for (const key of ['power_mode','battery_voltage','automatic_ota_min_voltage','manual_ota_min_voltage']) status[key] = input[key];
  }
  if (input.experiment !== undefined) status.experiment = normalizeExperimentStatus(input.experiment);
  return status;
}
