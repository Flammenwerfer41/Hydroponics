import { handleIngestion } from "./ingestion/handler.js";
import { jsonResponse as sharedJsonResponse, publicCorsHeaders } from "./http/response.js";
import {
  handleAdminExport,
  handleHistory,
  isAdminExportRoute,
  isHistoryRoute
} from "./history/handler.js";
import { handleAdmin, handlePublicLight } from "./control/handler.js";
import { handleJournalAdmin } from "./journal/handler.js";
import { handlePublicJournal } from "./journal/public-handler.js";
import { pollAndReconcile } from "./control/service.js";
import { processJournalCleanup } from "./journal/cleanup.js";
import { deliverDiscordNotifications } from "./alerts/discord.js";
import { handlePublicAlerts } from "./alerts/handler.js";
import { evaluateAlerts } from "./alerts/service.js";
import {
  archiveJmaWeather,
  currentWeather,
  shouldCollectJmaForecast,
  shouldCollectJmaObservation
} from "./weather/service.js";

export {
  buildForecastPayload,
  buildWeatherPayload,
  calculateApparentTemperature,
  mapUrlFor,
  observationCondition,
  readJmaField
} from "./weather/contract.js";
export { shouldCollectJmaForecast, shouldCollectJmaObservation } from "./weather/service.js";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://hydroponics-jma-weather.flammenwerfer41.workers.dev",
  "font-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "upgrade-insecure-requests"
].join("; ");

function secureResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Permissions-Policy",
    "camera=(self), microphone=(), geolocation=(), payment=(), usb=()"
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function publicApiRateLimit(request, environment) {
  if (!environment.PUBLIC_API_RATE_LIMITER || request.method !== "GET") return null;
  const address = request.headers.get("CF-Connecting-IP") || "unknown";
  try {
    const { success } = await environment.PUBLIC_API_RATE_LIMITER.limit({
      key: `public-read:${address}`
    });
    return success ? null : jsonResponse(
      { error: "Too many requests" },
      429,
      { "Cache-Control": "no-store", "Retry-After": "60" }
    );
  } catch (error) {
    console.warn("Public API rate limiter unavailable; allowing request", error);
    return null;
  }
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return sharedJsonResponse(body, status, {
    ...publicCorsHeaders(),
    ...extraHeaders
  });
}

async function routeRequest(request, environment, context) {
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    if (isAdminExportRoute(path)) {
      return handleAdminExport(request, environment, path);
    }
    if (path === "/admin/api/journal" || path.startsWith("/admin/api/journal/")) {
      return handleJournalAdmin(request, environment, path);
    }
    if (path.startsWith("/admin/api/")) {
      return handleAdmin(request, environment, path);
    }
    if (path === "/api/journal" || path.startsWith("/api/journal/")) {
      const limited = await publicApiRateLimit(request, environment);
      if (limited) return limited;
      return handlePublicJournal(request, environment, path);
    }
    if (!path.startsWith("/v1/")) {
      if (environment.ASSETS) return environment.ASSETS.fetch(request);
      return jsonResponse({ error: "Not found" }, 404);
    }

    const limited = await publicApiRateLimit(request, environment);
    if (limited) return limited;

    if (path === "/v1/light/current" || path === "/v1/light/history") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400"
      } });
      return handlePublicLight(request, environment, path);
    }

    if (path === "/v1/alerts/active") {
      return handlePublicAlerts(request, environment);
    }

    if ((request.method === "POST" || request.method === "OPTIONS") &&
        (path === "/v1/readings" || path === "/v1/readings/bulk")) {
      return handleIngestion(request, environment, context, path);
    }

    if (isHistoryRoute(path)) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400"
      } });
      return handleHistory(request, environment, context, path);
    }

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400"
    } });
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405, { "Allow": "GET, OPTIONS" });
    }

    if (path !== "/v1/current") {
      return jsonResponse({ error: "Not found" }, 404);
    }

    try {
      return await currentWeather(request, environment, context);
    } catch (error) {
      console.error("JMA weather fetch failed", error);
      return jsonResponse({
        error: "JMA observation is temporarily unavailable",
        generated_at: new Date().toISOString()
      }, 502, { "Cache-Control": "no-store" });
    }
}

export default {
  async fetch(request, environment, context) {
    return secureResponse(await routeRequest(request, environment, context));
  },

  async scheduled(controller, environment, context) {
    if (!environment.HYDROPONICS_DB) {
      console.error("Scheduled control skipped: D1 binding is unavailable");
      return;
    }
    const scheduledAt = new Date(controller.scheduledTime);
    context.waitUntil((async () => {
      try {
        await pollAndReconcile(environment, scheduledAt);
      } catch (error) {
        console.error("Scheduled SwitchBot reconciliation failed", error);
      }
      try {
        const result = await evaluateAlerts(environment, scheduledAt);
        if (result.events.length) console.log("Scheduled alert evaluation created events", result.events.length);
      } catch (error) {
        console.error("Scheduled alert evaluation failed", error);
      }
      try {
        const result = await deliverDiscordNotifications(environment, new Date());
        if (result.attempted) console.log("Scheduled Discord alert delivery completed", result);
      } catch (error) {
        console.error("Scheduled Discord alert delivery failed", error);
      }
    })());
    if (shouldCollectJmaObservation(scheduledAt)) {
      context.waitUntil(
        archiveJmaWeather(environment, scheduledAt, shouldCollectJmaForecast(scheduledAt))
          .then((result) => {
            if (result.observations || result.forecast) console.log("Scheduled JMA archive completed", result);
          })
          .catch((error) => console.error("Scheduled JMA archive failed", error))
      );
    }
    if (scheduledAt.getUTCMinutes() === 17 && environment.JOURNAL_PHOTOS) {
      context.waitUntil(
        processJournalCleanup(environment.HYDROPONICS_DB, environment.JOURNAL_PHOTOS, scheduledAt)
          .then((result) => {
            if (result.attempted) console.log("Scheduled R2 cleanup completed", result);
          })
          .catch((error) => console.error("Scheduled R2 cleanup failed", error))
      );
    }
  }
};
