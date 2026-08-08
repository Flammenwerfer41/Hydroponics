import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { sha256Hex } from "../src/ingestion/auth.js";

const TOKEN = "device-key-1234567890-abcdefghij";

class FakeStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.bindings = [];
  }

  bind(...bindings) {
    this.bindings = bindings;
    return this;
  }

  async first() {
    if (this.sql.includes("FROM device_credentials")) {
      return this.bindings[0] === this.database.credentialHash
        ? { credential_id: "credential-01", device_id: "esp32-01" }
        : null;
    }
    if (this.sql.includes("payload_sha256") && this.sql.includes("reading_id = ?2")) {
      return this.database.readings.get(`${this.bindings[0]}|${this.bindings[1]}`) ?? null;
    }
    throw new Error(`Unexpected first() statement: ${this.sql}`);
  }

  async run() {
    return { success: true, meta: { changes: 1 } };
  }
}

class FakeD1 {
  constructor(credentialHash) {
    this.credentialHash = credentialHash;
    this.readings = new Map();
    this.sequences = new Map();
    this.values = new Map();
    this.nextId = 1;
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) {
      if (statement.sql.includes("INSERT OR IGNORE INTO readings")) {
        const [
          deviceId,
          readingId,
          bootId,
          sequence,
          measuredAt,
          receivedAt,
          firmwareVersion,
          resetReason,
          payloadHash
        ] = statement.bindings;
        const readingKey = `${deviceId}|${readingId}`;
        const sequenceKey = `${deviceId}|${bootId}|${sequence}`;
        const conflict = this.readings.has(readingKey) || this.sequences.has(sequenceKey);
        if (!conflict) {
          this.readings.set(readingKey, {
            id: this.nextId++,
            payload_sha256: payloadHash,
            measured_at: measuredAt,
            received_at: receivedAt,
            firmware_version: firmwareVersion,
            reset_reason: resetReason
          });
          this.sequences.set(sequenceKey, readingId);
        }
        results.push({ success: true, meta: { changes: conflict ? 0 : 1 } });
        continue;
      }

      if (statement.sql.includes("INSERT OR IGNORE INTO measurement_values")) {
        const identityOffset = statement.bindings.length - 3;
        const [deviceId, readingId, payloadHash] = statement.bindings.slice(identityOffset);
        const reading = this.readings.get(`${deviceId}|${readingId}`);
        if (reading?.payload_sha256 === payloadHash) {
          for (let offset = 0; offset < identityOffset; offset += 5) {
            const [metric, value, unit, quality, diagnostic] =
              statement.bindings.slice(offset, offset + 5);
            this.values.set(`${deviceId}|${readingId}|${metric}`, {
              value,
              unit,
              quality,
              diagnostic
            });
          }
        }
        results.push({ success: true, meta: { changes: reading ? 1 : 0 } });
        continue;
      }
      throw new Error(`Unexpected batch statement: ${statement.sql}`);
    }
    return results;
  }
}

function reading(overrides = {}) {
  return {
    schema_version: 1,
    reading_id: "boot0001:42",
    boot_id: "boot0001",
    sequence: 42,
    measured_at: "2026-08-08T09:59:00+09:00",
    firmware_version: "8.1.0",
    values: {
      air_temperature: 25.3,
      humidity: 61.2,
      water_temperature: 24.6
    },
    ...overrides
  };
}

function post(path, body, token = TOKEN) {
  return new Request(`https://worker.example${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function environment() {
  return { HYDROPONICS_DB: new FakeD1(await sha256Hex(TOKEN)) };
}

const context = { waitUntil(promise) { return promise; } };

test("rejects a device with an unknown credential", async () => {
  const env = await environment();
  const response = await worker.fetch(post("/v1/readings", reading(), "x".repeat(32)), env, context);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "unauthorized");
});

test("stores a partial reading without discarding valid fields", async () => {
  const env = await environment();
  const input = reading({
    values: { air_temperature: 25.3, humidity: null, water_temperature: 24.6 },
    quality: { humidity: "missing" },
    diagnostics: { humidity: "bme280_read_failed" }
  });
  const response = await worker.fetch(post("/v1/readings", input), env, context);
  const result = await response.json();

  assert.equal(response.status, 201);
  assert.equal(result.status, "accepted");
  assert.equal(env.HYDROPONICS_DB.values.get("esp32-01|boot0001:42|air_temperature").quality, "valid");
  assert.deepEqual(env.HYDROPONICS_DB.values.get("esp32-01|boot0001:42|humidity"), {
    value: null,
    unit: "percent",
    quality: "missing",
    diagnostic: "bme280_read_failed"
  });
});

test("distinguishes an idempotent replay from a changed-payload conflict", async () => {
  const env = await environment();
  const first = await worker.fetch(post("/v1/readings", reading()), env, context);
  const duplicate = await worker.fetch(post("/v1/readings", reading()), env, context);
  const changed = reading({ values: { air_temperature: 30 } });
  const conflict = await worker.fetch(post("/v1/readings", changed), env, context);

  assert.equal(first.status, 201);
  assert.equal((await duplicate.json()).status, "duplicate");
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).reason, "reading_id_conflict");
});

test("handles accepted, duplicate, delayed, partial and malformed bulk items", async () => {
  const env = await environment();
  const normal = reading();
  const delayedPartial = reading({
    reading_id: "boot0001:43",
    sequence: 43,
    measured_at: "2026-07-27T12:00:00+09:00",
    values: { air_temperature: null, water_temperature: 24.1 },
    quality: { air_temperature: "missing" }
  });
  const malformed = reading({ reading_id: "bad", sequence: -1 });
  const response = await worker.fetch(post("/v1/readings/bulk", {
    schema_version: 1,
    readings: [normal, normal, delayedPartial, malformed]
  }), env, context);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.summary, { accepted: 2, duplicate: 1, rejected: 1 });
  assert.deepEqual(body.results.map(({ status }) => status), [
    "accepted",
    "duplicate",
    "accepted",
    "rejected"
  ]);
  assert.equal(body.results[3].reason, "validation_failed");
});

test("rejects a second reading ID that reuses one boot sequence", async () => {
  const env = await environment();
  await worker.fetch(post("/v1/readings", reading()), env, context);
  const response = await worker.fetch(post("/v1/readings", reading({
    reading_id: "boot0001:alternate"
  })), env, context);
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.reason, "sequence_conflict");
});

test("keeps bulk requests within the D1 Free query budget", async () => {
  const env = await environment();
  const readings = Array.from({ length: 16 }, (_, index) => reading({
    reading_id: `boot0001:${String(index).padStart(6, "0")}`,
    sequence: index
  }));
  const response = await worker.fetch(post("/v1/readings/bulk", {
    schema_version: 1,
    readings
  }), env, context);

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_batch_size");
  assert.equal(env.HYDROPONICS_DB.readings.size, 0);
});
