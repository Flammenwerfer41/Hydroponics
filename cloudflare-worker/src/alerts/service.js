import { scheduledPower } from "../control/service.js";
import { advanceState, calculateVpd, classifyThreshold, countMetricStreaks } from "./engine.js";
import { monitoringSnapshot, persistEvaluation } from "./store.js";

const DEVICE_ID = "esp32-01";
const ZONE_ID = "tower-01";

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function latestMetric(readings, metric) {
  const reading = readings[0];
  const field = reading?.values?.[metric];
  return {
    value: field?.quality === "valid" && Number.isFinite(field.value) ? field.value : null,
    observedAt: reading?.measuredAt || null
  };
}

function recentDataRecovered(readings, now) {
  if (readings.length < 2) return false;
  const latest = Date.parse(readings[0].measuredAt);
  const previous = Date.parse(readings[1].measuredAt);
  return Number.isFinite(latest) && Number.isFinite(previous) &&
    now.getTime() - latest <= 5 * 60_000 && latest - previous <= 5 * 60_000;
}

function missingDesired(rule, readings, currentState) {
  const streaks = countMetricStreaks(readings, rule.metric);
  if (streaks.missing >= Number(rule.critical_enter)) return { desired: "critical", value: streaks.missing };
  if (streaks.missing >= Number(rule.warning_enter)) return { desired: "warning", value: streaks.missing };
  if (currentState !== "normal" && streaks.valid < Number(rule.config.recovery_readings || 2)) {
    return { desired: currentState, value: streaks.missing };
  }
  return { desired: "normal", value: streaks.missing };
}

function dataGapDesired(rule, readings, currentState, now) {
  const latest = Date.parse(readings[0]?.measuredAt);
  const gapSeconds = Number.isFinite(latest) ? Math.max(0, (now.getTime() - latest) / 1000) : Infinity;
  const gapMinutes = Number.isFinite(gapSeconds) ? Math.round(gapSeconds / 60) : null;
  if (gapSeconds >= Number(rule.critical_enter)) return { desired: "critical", value: gapMinutes, observedAt: readings[0]?.measuredAt || null };
  if (gapSeconds >= Number(rule.warning_enter)) return { desired: "warning", value: gapMinutes, observedAt: readings[0]?.measuredAt || null };
  if (currentState !== "normal" && !recentDataRecovered(readings, now)) {
    return { desired: currentState, value: gapMinutes, observedAt: readings[0]?.measuredAt || null };
  }
  return { desired: "normal", value: gapMinutes, observedAt: readings[0]?.measuredAt || null };
}

function lightDesired(rule, control, currentState, now) {
  if (!control) return { desired: currentState, value: null, observedAt: null };
  const desiredPower = scheduledPower(control, now);
  const telemetryAge = now.getTime() - Date.parse(control.observed_at);
  const threshold = Number(rule.config.power_threshold_w || 5);
  const stateMismatch = desiredPower && control.power_state !== desiredPower;
  const powerMismatch = control.power_state === "on"
    ? finite(control.power_w) !== null && finite(control.power_w) < threshold
    : control.power_state === "off" && finite(control.power_w) !== null && finite(control.power_w) >= threshold;
  const stale = !Number.isFinite(telemetryAge) || telemetryAge > 10 * 60_000;
  const commandFailed = control.command_status === "failed" &&
    now.getTime() - Date.parse(control.command_requested_at) <= 10 * 60_000;
  const mismatch = Boolean(stateMismatch || powerMismatch || stale || commandFailed);
  return {
    desired: mismatch ? (currentState === "warning" || currentState === "critical" ? "critical" : "warning") : "normal",
    value: mismatch ? 1 : 0,
    observedAt: control.observed_at || null,
    warningDuration: commandFailed ? 0 : Number(rule.warning_duration_seconds)
  };
}

function evaluateRule(rule, state, snapshot, now) {
  const currentState = state?.state || "normal";
  if (rule.direction === "gap") return dataGapDesired(rule, snapshot.readings, currentState, now);
  if (rule.direction === "missing") {
    return { ...missingDesired(rule, snapshot.readings, currentState), observedAt: snapshot.readings[0]?.measuredAt || null };
  }
  if (rule.direction === "mismatch") return lightDesired(rule, snapshot.control, currentState, now);

  let metric = latestMetric(snapshot.readings, rule.metric);
  if (rule.metric === "vpd") {
    const temperature = latestMetric(snapshot.readings, "air_temperature");
    const humidity = latestMetric(snapshot.readings, "humidity");
    metric = {
      value: calculateVpd(temperature.value, humidity.value),
      observedAt: temperature.observedAt || humidity.observedAt
    };
  }
  return {
    desired: classifyThreshold(rule, metric.value, currentState) || currentState,
    value: metric.value,
    observedAt: metric.observedAt
  };
}

function notificationPayload(rule, alertId, eventType, severity, evaluation, openedAt, now) {
  const opened = Date.parse(openedAt);
  return {
    id: `${alertId}:${eventType === "escalated" ? "critical" : eventType}`,
    alertId,
    eventType,
    severity: eventType === "resolved" ? "info" : severity,
    payload: {
      alert_type: rule.alert_type,
      title_ko: rule.title_ko,
      title_ja: rule.title_ja,
      value: evaluation.value,
      unit: rule.unit,
      observed_at: evaluation.observedAt,
      event_at: now.toISOString(),
      duration_minutes: Number.isFinite(opened)
        ? Math.max(0, Math.round((now.getTime() - opened) / 60_000))
        : null
    }
  };
}

function stateUpsert(rule, next, activeAlertId, evaluation, now) {
  return {
    sql: `
      INSERT INTO alert_rule_states (
        rule_id, state, pending_state, pending_since, active_alert_id,
        last_value, last_observed_at, last_evaluated_at, last_changed_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT(rule_id) DO UPDATE SET
        state = excluded.state, pending_state = excluded.pending_state,
        pending_since = excluded.pending_since, active_alert_id = excluded.active_alert_id,
        last_value = excluded.last_value, last_observed_at = excluded.last_observed_at,
        last_evaluated_at = excluded.last_evaluated_at,
        last_changed_at = CASE
          WHEN alert_rule_states.state <> excluded.state THEN excluded.last_changed_at
          ELSE alert_rule_states.last_changed_at END
    `,
    bindings: [
      rule.id, next.state, next.pendingState, next.pendingSince, activeAlertId,
      evaluation.value, evaluation.observedAt, now.toISOString(), now.toISOString()
    ]
  };
}

function notificationInsert(notification, now) {
  return {
    sql: `
      INSERT OR IGNORE INTO alert_notifications (
        id, alert_id, event_type, severity, payload_json,
        status, attempts, next_attempt_at, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?6)
    `,
    bindings: [
      notification.id, notification.alertId, notification.eventType,
      notification.severity, JSON.stringify(notification.payload), now.toISOString()
    ]
  };
}

export async function evaluateAlerts(environment, now = new Date()) {
  const database = environment.HYDROPONICS_DB;
  const snapshot = await monitoringSnapshot(database);
  const changes = [];
  const events = [];

  for (const rule of snapshot.rules) {
    const stored = snapshot.states.get(rule.id);
    const evaluation = evaluateRule(rule, stored, snapshot, now);
    const next = advanceState({
      state: stored?.state || "normal",
      pendingState: stored?.pending_state || null,
      pendingSince: stored?.pending_since || null
    }, evaluation.desired, now, {
      warning: evaluation.warningDuration ?? Number(rule.warning_duration_seconds),
      critical: Number(rule.critical_duration_seconds),
      recovery: Number(rule.recovery_duration_seconds)
    });

    let activeAlertId = stored?.active_alert_id || null;
    let openedAt = stored?.opened_at || null;
    if (next.event === "opened") {
      activeAlertId = crypto.randomUUID();
      openedAt = now.toISOString();
      changes.push({
        sql: `INSERT INTO alerts (
          id, site_id, zone_id, device_id, alert_type, severity,
          state, opened_at, details_json
        ) VALUES (?1, 'home-lab', ?2, ?3, ?4, ?5, 'open', ?6, ?7)`,
        bindings: [activeAlertId, ZONE_ID, DEVICE_ID, rule.alert_type, next.state,
          openedAt, JSON.stringify({ value: evaluation.value, unit: rule.unit, observed_at: evaluation.observedAt })]
      });
      const notification = notificationPayload(
        rule, activeAlertId, "opened", next.state, evaluation, openedAt, now
      );
      changes.push(notificationInsert(notification, now));
      events.push(notification);
    } else if (next.event === "escalated" && activeAlertId) {
      changes.push({
        sql: `UPDATE alerts SET severity = 'critical', details_json = ?1 WHERE id = ?2`,
        bindings: [JSON.stringify({ value: evaluation.value, unit: rule.unit, observed_at: evaluation.observedAt }), activeAlertId]
      });
      const notification = notificationPayload(
        rule, activeAlertId, "escalated", "critical", evaluation, openedAt, now
      );
      changes.push(notificationInsert(notification, now));
      events.push(notification);
    } else if (next.event === "downgraded" && activeAlertId) {
      changes.push({
        sql: `UPDATE alerts SET severity = 'warning', details_json = ?1 WHERE id = ?2`,
        bindings: [JSON.stringify({ value: evaluation.value, unit: rule.unit, observed_at: evaluation.observedAt }), activeAlertId]
      });
    } else if (next.event === "resolved" && activeAlertId) {
      changes.push({
        sql: `UPDATE alerts SET state = 'resolved', resolved_at = ?1, details_json = ?2 WHERE id = ?3`,
        bindings: [now.toISOString(), JSON.stringify({ value: evaluation.value, unit: rule.unit, observed_at: evaluation.observedAt }), activeAlertId]
      });
      const notification = notificationPayload(
        rule, activeAlertId, "resolved", "info", evaluation, openedAt, now
      );
      changes.push(notificationInsert(notification, now));
      events.push(notification);
      activeAlertId = null;
    } else if (activeAlertId) {
      changes.push({
        sql: `UPDATE alerts SET details_json = ?1 WHERE id = ?2`,
        bindings: [JSON.stringify({ value: evaluation.value, unit: rule.unit, observed_at: evaluation.observedAt }), activeAlertId]
      });
    }
    changes.push(stateUpsert(rule, next, activeAlertId, evaluation, now));
  }

  await persistEvaluation(database, changes);
  return { evaluated: snapshot.rules.length, events };
}
