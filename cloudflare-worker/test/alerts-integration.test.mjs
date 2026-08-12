import test from "node:test";
import assert from "node:assert/strict";

import { deliverDiscordNotifications } from "../src/alerts/discord.js";
import { handlePublicAlerts } from "../src/alerts/handler.js";
import { evaluateAlerts } from "../src/alerts/service.js";

class Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.bindings = [];
  }

  bind(...bindings) {
    this.bindings = bindings;
    return this;
  }

  async all() {
    if (this.sql.includes("FROM alert_rules") && this.sql.includes("enabled = 1")) {
      return { results: this.database.rules };
    }
    if (this.sql.includes("FROM alert_rule_states ars") && this.sql.includes("LEFT JOIN alerts")) {
      return { results: this.database.states };
    }
    if (this.sql.includes("WITH recent AS")) return { results: this.database.readingRows };
    if (this.sql.includes("FROM alert_notifications")) {
      return { results: this.database.notifications };
    }
    if (this.sql.includes("JOIN alerts a ON")) return { results: this.database.publicAlerts };
    throw new Error(`Unexpected all() query: ${this.sql}`);
  }

  async first() {
    if (this.sql.includes("FROM automation_settings")) return this.database.control;
    throw new Error(`Unexpected first() query: ${this.sql}`);
  }

  async run() {
    this.database.runs.push({ sql: this.sql, bindings: this.bindings });
    return { success: true, meta: { changes: 1 } };
  }
}

class AlertDatabase {
  constructor() {
    this.rules = [];
    this.states = [];
    this.readingRows = [];
    this.control = null;
    this.notifications = [];
    this.publicAlerts = [];
    this.batches = [];
    this.runs = [];
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    this.batches.push(...statements.map(({ sql, bindings }) => ({ sql, bindings })));
    return statements.map(() => ({ success: true, meta: { changes: 1 } }));
  }
}

test("opens a persisted warning from the latest valid sensor value", async () => {
  const database = new AlertDatabase();
  database.rules = [{
    id: "high-air-temperature",
    alert_type: "high_air_temperature",
    title_ko: "고온",
    title_ja: "高温",
    metric: "air_temperature",
    unit: "degC",
    direction: "high",
    warning_enter: 30,
    warning_exit: 29,
    critical_enter: 35,
    critical_exit: 33,
    warning_duration_seconds: 0,
    critical_duration_seconds: 0,
    recovery_duration_seconds: 0,
    config_json: "{}"
  }];
  database.readingRows = [{
    id: 1,
    measured_at: "2026-08-12T05:30:00.000Z",
    received_at: "2026-08-12T05:30:01.000Z",
    metric: "air_temperature",
    value: 31.2,
    quality: "valid"
  }];

  const result = await evaluateAlerts(
    { HYDROPONICS_DB: database },
    new Date("2026-08-12T05:31:00.000Z")
  );

  assert.equal(result.evaluated, 1);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].eventType, "opened");
  assert.equal(result.events[0].payload.value, 31.2);
  assert.equal(database.batches.some(({ sql }) => sql.includes("INSERT INTO alerts")), true);
  assert.equal(database.batches.some(({ sql }) => sql.includes("INSERT OR IGNORE INTO alert_notifications")), true);
  assert.equal(database.batches.some(({ sql }) => sql.includes("INSERT INTO alert_rule_states")), true);
});

test("returns minimized active warnings from the public endpoint", async () => {
  const database = new AlertDatabase();
  database.publicAlerts = [{
    id: "alert-1",
    alert_type: "high_vpd",
    severity: "critical",
    opened_at: "2026-08-12T05:00:00.000Z",
    title_ko: "높은 VPD",
    title_ja: "高VPD",
    unit: "kPa",
    sort_order: 1,
    last_value: 3.1,
    last_observed_at: "2026-08-12T05:30:00.000Z",
    last_changed_at: "2026-08-12T05:30:00.000Z"
  }];

  const response = await handlePublicAlerts(
    new Request("https://worker.example/v1/alerts/active"),
    { HYDROPONICS_DB: database }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.active_count, 1);
  assert.equal(body.highest_severity, "critical");
  assert.equal(body.alerts[0].current_value, 3.1);
  assert.equal(body.alerts[0].title.ko, "높은 VPD");
});

test("delivers a pending Discord notification and marks it complete", async (context) => {
  const database = new AlertDatabase();
  database.notifications = [{
    id: "alert-1:opened",
    alert_id: "alert-1",
    event_type: "opened",
    severity: "warning",
    payload_json: JSON.stringify({
      alert_type: "high_air_temperature",
      title_ko: "고온",
      value: 31.2,
      unit: "degC",
      observed_at: "2026-08-12T05:30:00.000Z",
      event_at: "2026-08-12T05:31:00.000Z",
      duration_minutes: 1
    }),
    attempts: 0
  }];
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let request = null;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), body: JSON.parse(init.body) };
    return new Response("ok", { status: 200 });
  };

  const result = await deliverDiscordNotifications({
    HYDROPONICS_DB: database,
    DISCORD_WEBHOOK_URL: "https://discord.example/webhook"
  }, new Date("2026-08-12T05:32:00.000Z"));

  assert.deepEqual(result, { attempted: 1, delivered: 1 });
  assert.equal(request.url, "https://discord.example/webhook?wait=true");
  assert.equal(request.body.allowed_mentions.parse.length, 0);
  assert.match(request.body.embeds[0].title, /고온/);
  assert.equal(database.runs.some(({ sql }) => sql.includes("status = 'delivered'")), true);
});
