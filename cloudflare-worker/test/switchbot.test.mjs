import test from "node:test";
import assert from "node:assert/strict";

import {
  getPlugStatus,
  setAirConditioner,
  setPlugPower
} from "../src/switchbot/client.js";

const ENVIRONMENT = Object.freeze({
  SWITCHBOT_TOKEN: "\uFEFF token-value \r\n",
  SWITCHBOT_SECRET: " secret-value \n",
  SWITCHBOT_LIGHT_DEVICE_ID: " light/device ",
  SWITCHBOT_AC_DEVICE_ID: " ac/device "
});

test("signs SwitchBot status requests and normalizes plug telemetry", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return Response.json({
      statusCode: 100,
      body: {
        power: "on",
        weight: "72.5",
        voltage: "101.2",
        electricCurrent: "716",
        electricityOfDay: "285"
      }
    });
  };

  const result = await getPlugStatus(ENVIRONMENT);

  assert.equal(captured.url, "https://api.switch-bot.com/v1.1/devices/light%2Fdevice/status");
  assert.equal(captured.init.headers.Authorization, "token-value");
  assert.match(captured.init.headers.sign, /^[A-Za-z0-9+/]+=*$/);
  assert.match(captured.init.headers.t, /^\d+$/);
  assert.ok(captured.init.headers.nonce);
  assert.equal(result.state, "on");
  assert.equal(result.powerW, 72.5);
  assert.equal(result.currentA, 0.716);
  assert.equal(result.runtimeMinutes, 285);
});

test("sends explicit light and air-conditioner commands", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const commands = [];
  globalThis.fetch = async (url, init) => {
    commands.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({ statusCode: 100, body: {} });
  };

  await setPlugPower(ENVIRONMENT, "off");
  await setAirConditioner(ENVIRONMENT, { power: "off" });
  await setAirConditioner(ENVIRONMENT, {
    power: "on",
    temperature: 26,
    mode: 2,
    fan: 1
  });

  assert.deepEqual(commands.map(({ body }) => body), [
    { command: "turnOff", parameter: "default", commandType: "command" },
    { command: "turnOff", parameter: "default", commandType: "command" },
    { command: "setAll", parameter: "26,2,1,on", commandType: "command" }
  ]);
  assert.match(commands[0].url, /light%2Fdevice\/commands$/);
  assert.match(commands[1].url, /ac%2Fdevice\/commands$/);
});

test("preserves provider status when SwitchBot rejects a command", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json(
    { statusCode: 190, message: "device offline" },
    { status: 200 }
  );

  await assert.rejects(
    () => setPlugPower(ENVIRONMENT, "on"),
    (error) => error.message === "device offline" && error.providerStatus === 190
  );
});
