import assert from "node:assert/strict";
import test from "node:test";

import { latestSensorSnapshot } from "../src/control/store.js";

test("latest sensor snapshot ranks only a bounded set of recent readings", async () => {
  let query = "";
  let bindings = [];
  const statement = {
    bind(...values) {
      bindings = values;
      return this;
    },
    async all() {
      return {
        results: [{
          metric: "air_temperature",
          value: 25.5,
          quality: "valid",
          measured_at: "2026-09-03T00:00:00Z"
        }]
      };
    }
  };
  const database = {
    prepare(sql) {
      query = sql;
      return statement;
    }
  };

  const snapshot = await latestSensorSnapshot(database);

  assert.match(query, /WITH recent AS MATERIALIZED/);
  assert.match(query, /CROSS JOIN measurement_values/);
  assert.match(query, /LIMIT \?2/);
  assert.deepEqual(bindings, ["esp32-01", 30]);
  assert.deepEqual(snapshot.air_temperature, {
    value: 25.5,
    quality: "valid",
    measured_at: "2026-09-03T00:00:00Z"
  });
});
