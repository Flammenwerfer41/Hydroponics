const API_BASE = "https://api.switch-bot.com/v1.1";

function required(environment, name) {
  // Wrangler can receive a UTF-8 BOM or a line ending when a secret is piped
  // from Windows PowerShell. Neither is part of a SwitchBot credential.
  const value = typeof environment?.[name] === "string"
    ? environment[name].replace(/^\uFEFF/, "").trim()
    : environment?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

function base64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function signature(token, secret, timestamp, nonce) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${token}${timestamp}${nonce}`)
  );
  return base64(new Uint8Array(digest));
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function request(environment, path, init = {}) {
  const token = required(environment, "SWITCHBOT_TOKEN");
  const secret = required(environment, "SWITCHBOT_SECRET");
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Authorization": token,
      "sign": await signature(token, secret, timestamp, nonce),
      "t": timestamp,
      "nonce": nonce,
      "Content-Type": "application/json; charset=utf-8",
      ...(init.headers || {})
    }
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`SwitchBot returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok || payload?.statusCode !== 100) {
    const error = new Error(payload?.message || `SwitchBot HTTP ${response.status}`);
    error.httpStatus = response.status;
    error.providerStatus = finite(payload?.statusCode);
    throw error;
  }
  return payload;
}

export async function getPlugStatus(environment) {
  const deviceId = required(environment, "SWITCHBOT_LIGHT_DEVICE_ID");
  const payload = await request(environment, `/devices/${encodeURIComponent(deviceId)}/status`);
  const body = payload.body || {};
  const state = body.power === "on" ? "on" : body.power === "off" ? "off" : "unknown";
  return {
    observedAt: new Date().toISOString(),
    state,
    powerW: finite(body.weight),
    voltageV: finite(body.voltage),
    currentA: finite(body.electricCurrent) === null ? null : finite(body.electricCurrent) / 1000,
    runtimeMinutes: finite(body.electricityOfDay),
    providerStatus: payload.statusCode,
    raw: body
  };
}

export async function setPlugPower(environment, power) {
  if (power !== "on" && power !== "off") throw new Error("Invalid plug power state");
  const deviceId = required(environment, "SWITCHBOT_LIGHT_DEVICE_ID");
  return request(environment, `/devices/${encodeURIComponent(deviceId)}/commands`, {
    method: "POST",
    body: JSON.stringify({
      command: power === "on" ? "turnOn" : "turnOff",
      parameter: "default",
      commandType: "command"
    })
  });
}

export async function setAirConditioner(environment, settings) {
  const deviceId = required(environment, "SWITCHBOT_AC_DEVICE_ID");
  if (settings.power === "off") {
    return request(environment, `/devices/${encodeURIComponent(deviceId)}/commands`, {
      method: "POST",
      body: JSON.stringify({ command: "turnOff", parameter: "default", commandType: "command" })
    });
  }
  return request(environment, `/devices/${encodeURIComponent(deviceId)}/commands`, {
    method: "POST",
    body: JSON.stringify({
      command: "setAll",
      parameter: `${settings.temperature},${settings.mode},${settings.fan},on`,
      commandType: "command"
    })
  });
}
