const LEVEL = Object.freeze({ normal: 0, warning: 1, critical: 2 });

export function calculateVpd(temperature, humidity) {
  if (!Number.isFinite(temperature) || !Number.isFinite(humidity)) return null;
  const saturation = 0.6108 * Math.exp((17.27 * temperature) / (temperature + 237.3));
  return Math.round(saturation * (1 - humidity / 100) * 100) / 100;
}

export function classifyThreshold(rule, value, currentState = "normal") {
  if (!Number.isFinite(value)) return null;
  const warningEnter = Number(rule.warning_enter);
  const warningExit = Number(rule.warning_exit);
  const criticalEnter = Number(rule.critical_enter);
  const criticalExit = Number(rule.critical_exit);

  if (rule.direction === "high") {
    if (currentState === "critical") {
      if (value >= criticalExit) return "critical";
      return value <= warningExit ? "normal" : "warning";
    }
    if (currentState === "warning") {
      if (value >= criticalEnter) return "critical";
      return value <= warningExit ? "normal" : "warning";
    }
    if (value >= criticalEnter) return "critical";
    return value >= warningEnter ? "warning" : "normal";
  }

  if (rule.direction === "low") {
    if (currentState === "critical") {
      if (value <= criticalExit) return "critical";
      return value >= warningExit ? "normal" : "warning";
    }
    if (currentState === "warning") {
      if (value <= criticalEnter) return "critical";
      return value >= warningExit ? "normal" : "warning";
    }
    if (value <= criticalEnter) return "critical";
    return value <= warningEnter ? "warning" : "normal";
  }
  return null;
}

function transitionDuration(previous, desired, durations) {
  if (desired === "normal" || LEVEL[desired] < LEVEL[previous]) {
    return durations.recovery ?? 0;
  }
  return desired === "critical" ? durations.critical ?? 0 : durations.warning ?? 0;
}

export function advanceState(previous, desired, now, durations = {}) {
  const current = previous?.state || "normal";
  const nowIso = new Date(now).toISOString();
  const base = {
    state: current,
    pendingState: previous?.pendingState || null,
    pendingSince: previous?.pendingSince || null,
    changed: false,
    event: null
  };
  if (!Object.hasOwn(LEVEL, desired)) return { ...base, pendingState: null, pendingSince: null };
  if (desired === current) return { ...base, pendingState: null, pendingSince: null };

  const duration = transitionDuration(current, desired, durations) * 1000;
  if (base.pendingState !== desired || !base.pendingSince) {
    if (duration > 0) return { ...base, pendingState: desired, pendingSince: nowIso };
  } else if (new Date(now).getTime() - Date.parse(base.pendingSince) < duration) {
    return base;
  }

  let event = null;
  if (current === "normal" && desired !== "normal") event = "opened";
  else if (current === "warning" && desired === "critical") event = "escalated";
  else if (desired === "normal") event = "resolved";
  else if (current === "critical" && desired === "warning") event = "downgraded";

  return {
    state: desired,
    pendingState: null,
    pendingSince: null,
    changed: true,
    event
  };
}

export function countMetricStreaks(readings, metric) {
  let missing = 0;
  let valid = 0;
  for (const reading of readings) {
    const field = reading.values?.[metric];
    const isValid = Number.isFinite(field?.value) && field.quality === "valid";
    if (isValid) {
      if (missing > 0) break;
      valid += 1;
    } else {
      if (valid > 0) break;
      missing += 1;
    }
  }
  return { missing, valid };
}
