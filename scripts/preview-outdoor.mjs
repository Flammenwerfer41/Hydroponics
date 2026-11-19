// Loopback-only, synthetic data preview. Never changes production config or calls the cloud.
// node scripts/preview-outdoor.mjs [ready|stale|partial|empty|error|jma-error|disabled]
import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../docs/", import.meta.url));
const scenario = process.argv[2] || "ready";
if (!["ready", "stale", "partial", "empty", "error", "jma-error", "disabled"].includes(scenario)) throw new Error("Unknown scenario");
const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp" };
http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:8765");
  const json = (body, status = 200) => { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(body)); };
  const recent = new Date(Date.now() - 5 * 60_000).toISOString();
  if (url.pathname === "/v1/readings") {
    console.log("History requested", url.searchParams.get("from"), url.searchParams.get("to"));
    if (scenario === "error") return json({ error: "Synthetic history failure" }, 503);
    const readings = scenario === "empty" ? [] : Array.from({ length: 96 }, (_, i) => ({
      measured_at: new Date(Date.now() - (96 - i) * 900000).toISOString(),
      values: { air_temperature: 16 + 4 * Math.sin(i / 15), humidity: scenario === "partial" ? null : 65 + 15 * Math.cos(i / 15),
        pressure: 1014 + 2 * Math.sin(i / 30), battery_voltage: 3.48 - .02 * Math.sin(i / 30) },
      quality: { air_temperature: "valid", humidity: scenario === "partial" ? "missing" : "valid", pressure: "valid", battery_voltage: "valid" }
    })).filter((_, i) => i < 40 || i > 44);
    return json({ readings, page: { next_cursor: null } });
  }
  if (url.pathname === "/v1/readings/latest") {
    if (scenario === "error") return json({ error: "Synthetic station failure" }, 503);
    const dusk=new Date(); dusk.setUTCHours(9,2,0,0); if(dusk.getTime()>Date.now()) dusk.setUTCDate(dusk.getUTCDate()-1);
    return json({ night_closing: scenario === 'empty' ? null : {
      measured_at:new Date(dusk.getTime()+13*60000).toISOString(), values:{battery_voltage:3.58,air_temperature:14.1},
      quality:{battery_voltage:'valid',air_temperature:'valid'}, astronomy:{night_closing:true,astronomical_dusk:dusk.toISOString(),model:'noaa-fractional-v1-todoroki'}
    }, reading: scenario === "empty" ? null : {
      measured_at: scenario === "stale" ? new Date(Date.now() - 86400000).toISOString() : recent,
      values: { air_temperature: 23.4, humidity: scenario === "partial" ? null : 63, pressure: 1012.8, battery_voltage: 3.95 },
      quality: { air_temperature: "valid", humidity: scenario === "partial" ? "missing" : "valid", pressure: "valid", battery_voltage: "valid" }
    } });
  }
  if (url.pathname === "/v1/current") {
    if (scenario === "jma-error") return json({ error: "Synthetic JMA failure" }, 503);
    return json({ observed_at: recent, current: { temperature: 24.5, humidity: 58, station_pressure: 1011.6,
      precipitation_10m: 0, wind_speed: 2.1, apparent_temperature: 25 }, quality: { stale: false }, condition: { code: "dry" },
      stations: { environment: { name: "東京" }, precipitation: { name: "世田谷" } },
      forecast: { published_at: recent, periods: [0, 1, 2, 3].map(i => ({
        starts_at: new Date(Date.now() + i * 3 * 3600000).toISOString(), temperature: 24 - i, weather: "くもり"
      })) } });
  }
  if (url.pathname.startsWith("/v1/")) return json({ readings: [], buckets: [], telemetry: null, alerts: [], points: [], page: { next_cursor: null } });
  if (url.pathname.startsWith("/admin/api/")) return json({ error: "Not signed in (preview)" }, 401);
  try {
    const path = resolve(root, "." + decodeURIComponent(url.pathname) + (url.pathname.endsWith("/") ? "index.html" : ""));
    if (!path.startsWith(resolve(root) + sep)) { response.writeHead(403); response.end(); return; }
    let body = await readFile(path);
    if (url.pathname === "/weather-config.js") body = body.toString().replace(/balconyWeatherEnabled: (true|false)/, `balconyWeatherEnabled: ${scenario !== "disabled"}`);
    if (extname(path) === ".html") body = body.toString().replace("<body>", `<body><p>LOCAL PREVIEW · synthetic ${scenario} data · not deployed</p>`);
    response.writeHead(200, { "Content-Type": mime[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" }); response.end(body);
  } catch { response.writeHead(404); response.end(); }
}).listen(8765, "127.0.0.1", () => console.log(`Local: http://127.0.0.1:8765/ (${scenario}, synthetic data only)`));
