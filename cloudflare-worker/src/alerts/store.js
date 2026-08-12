const SITE_ID = "home-lab";
const DEVICE_ID = "esp32-01";

function rows(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

export async function monitoringSnapshot(database) {
  const [rulesResult, statesResult, readingsResult, control] = await Promise.all([
    database.prepare(`
      SELECT * FROM alert_rules
      WHERE site_id = ?1 AND enabled = 1
      ORDER BY sort_order, id
    `).bind(SITE_ID).all(),
    database.prepare(`
      SELECT ars.*, a.opened_at
      FROM alert_rule_states ars
      LEFT JOIN alerts a ON a.id = ars.active_alert_id
    `).all(),
    database.prepare(`
      WITH recent AS (
        SELECT id, measured_at, received_at
        FROM readings
        WHERE device_id = ?1
        ORDER BY measured_at DESC, id DESC
        LIMIT 10
      )
      SELECT recent.id, recent.measured_at, recent.received_at,
        mv.metric, mv.value, mv.quality
      FROM recent
      LEFT JOIN measurement_values mv ON mv.reading_pk = recent.id
      ORDER BY recent.measured_at DESC, recent.id DESC
    `).bind(DEVICE_ID).all(),
    database.prepare(`
      SELECT
        s.enabled, s.on_minute, s.off_minute, s.override_state, s.override_until,
        t.observed_at, t.power_state, t.power_w,
        c.status AS command_status, c.requested_at AS command_requested_at,
        c.provider_message AS command_message
      FROM automation_settings s
      LEFT JOIN actuator_telemetry t ON t.id = (
        SELECT id FROM actuator_telemetry
        WHERE actuator_id = s.actuator_id
        ORDER BY observed_at DESC, id DESC LIMIT 1
      )
      LEFT JOIN actuator_commands c ON c.id = (
        SELECT id FROM actuator_commands
        WHERE actuator_id = s.actuator_id
        ORDER BY requested_at DESC LIMIT 1
      )
      WHERE s.actuator_id = 'tower-01-grow-light'
    `).first()
  ]);

  const readingMap = new Map();
  for (const row of rows(readingsResult)) {
    if (!readingMap.has(row.id)) {
      readingMap.set(row.id, {
        id: row.id,
        measuredAt: row.measured_at,
        receivedAt: row.received_at,
        values: {}
      });
    }
    if (row.metric) {
      readingMap.get(row.id).values[row.metric] = {
        value: row.value === null ? null : Number(row.value),
        quality: row.quality
      };
    }
  }
  return {
    rules: rows(rulesResult).map((rule) => ({
      ...rule,
      config: JSON.parse(rule.config_json || "{}")
    })),
    states: new Map(rows(statesResult).map((state) => [state.rule_id, state])),
    readings: [...readingMap.values()],
    control
  };
}

export async function persistEvaluation(database, changes) {
  if (changes.length === 0) return;
  await database.batch(changes.map((change) => database.prepare(change.sql).bind(...change.bindings)));
}

export async function activePublicAlerts(database) {
  const result = await database.prepare(`
    SELECT a.id, a.alert_type, a.severity, a.opened_at,
      ar.title_ko, ar.title_ja, ar.unit, ar.sort_order,
      ars.last_value, ars.last_observed_at, ars.last_changed_at
    FROM alert_rule_states ars
    JOIN alert_rules ar ON ar.id = ars.rule_id
    JOIN alerts a ON a.id = ars.active_alert_id
    WHERE ar.site_id = ?1 AND ar.public = 1
      AND ars.state IN ('warning', 'critical')
      AND a.state IN ('open', 'acknowledged')
    ORDER BY CASE ars.state WHEN 'critical' THEN 0 ELSE 1 END,
      ar.sort_order, a.opened_at
  `).bind(SITE_ID).all();
  return rows(result).map((row) => ({
    id: row.id,
    type: row.alert_type,
    severity: row.severity,
    title: { ko: row.title_ko, ja: row.title_ja },
    current_value: row.last_value === null ? null : Number(row.last_value),
    unit: row.unit,
    opened_at: row.opened_at,
    observed_at: row.last_observed_at,
    changed_at: row.last_changed_at
  }));
}

export async function pendingNotifications(database, now, limit = 5) {
  const result = await database.prepare(`
    SELECT id, alert_id, event_type, severity, payload_json, attempts
    FROM alert_notifications
    WHERE status = 'pending' AND next_attempt_at <= ?1
    ORDER BY created_at, id
    LIMIT ?2
  `).bind(now.toISOString(), limit).all();
  return rows(result).map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
}

export async function markNotificationDelivered(database, id, now) {
  await database.prepare(`
    UPDATE alert_notifications
    SET status = 'delivered', attempts = attempts + 1,
      delivered_at = ?1, last_error = NULL
    WHERE id = ?2 AND status = 'pending'
  `).bind(now.toISOString(), id).run();
}

export async function markNotificationFailed(database, notification, error, now) {
  const attempts = Number(notification.attempts || 0) + 1;
  const terminal = attempts >= 5;
  const retryAt = new Date(now.getTime() + Math.min(60, 2 ** attempts) * 60_000);
  await database.prepare(`
    UPDATE alert_notifications
    SET status = ?1, attempts = ?2, next_attempt_at = ?3, last_error = ?4
    WHERE id = ?5 AND status = 'pending'
  `).bind(
    terminal ? "failed" : "pending",
    attempts,
    retryAt.toISOString(),
    String(error?.message || error).slice(0, 300),
    notification.id
  ).run();
}
