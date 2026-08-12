import { activePublicAlerts } from "./store.js";

function response(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=30",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export async function handlePublicAlerts(request, environment) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400"
  } });
  if (request.method !== "GET") return response({ error: "Method not allowed" }, 405);
  if (!environment.HYDROPONICS_DB) return response({ error: "Database unavailable" }, 503);
  const alerts = await activePublicAlerts(environment.HYDROPONICS_DB);
  return response({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    active_count: alerts.length,
    highest_severity: alerts.some(({ severity }) => severity === "critical")
      ? "critical" : alerts.length ? "warning" : null,
    alerts
  });
}
