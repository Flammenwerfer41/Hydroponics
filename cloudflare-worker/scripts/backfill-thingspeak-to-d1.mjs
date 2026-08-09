import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWranglerJson } from "./backup-support.mjs";
import {
  CHANNEL_ID,
  batchSql,
  feedToReading,
  remainingReadings,
  sqlLiteral,
  uniqueFeeds,
  utcWindows
} from "./thingspeak-backfill-support.mjs";

const DATABASE = process.env.HYDRO_BACKFILL_DATABASE || "hydroponics";
const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function positiveInteger(name, fallback) {
  const value = Number(option(name, fallback));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function wrangler(args) {
  try {
    return execFileSync(process.execPath, [WRANGLER, ...args], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const detail = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    throw new Error(detail || `Wrangler command failed: ${args.slice(0, 3).join(" ")}`);
  }
}

function thingSpeakTimestamp(value) {
  return new Date(value).toISOString().replace("T", " ").slice(0, 19);
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`ThingSpeak returned HTTP ${response.status}`);
  return response.json();
}

async function fetchAllFeeds(start, end) {
  const feeds = [];
  for (const window of utcWindows(start, end)) {
    const parameters = new URLSearchParams({
      start: thingSpeakTimestamp(window.start),
      end: thingSpeakTimestamp(window.end)
    });
    const payload = await fetchJson(
      `https://api.thingspeak.com/channels/${CHANNEL_ID}/feeds.json?${parameters}`
    );
    if (!Array.isArray(payload?.feeds)) throw new Error("ThingSpeak response is missing feeds");
    feeds.push(...payload.feeds);
  }
  return uniqueFeeds(feeds);
}

function executionMeta(output) {
  const payload = parseWranglerJson(output);
  const blocks = Array.isArray(payload) ? payload : [payload];
  return blocks.reduce((total, block) => ({
    rowsWritten: total.rowsWritten + Number(block?.meta?.rows_written ?? 0),
    changes: total.changes + Number(block?.meta?.changes ?? 0)
  }), { rowsWritten: 0, changes: 0 });
}

function backfillProgress(start, before) {
  const output = wrangler([
    "d1", "execute", DATABASE, "--remote", "--command",
    `SELECT COUNT(*) AS count, MIN(measured_at) AS oldest
     FROM readings
     WHERE source = 'thingspeak_backfill'
       AND measured_at >= ${sqlLiteral(start.toISOString())}
       AND measured_at < ${sqlLiteral(before.toISOString())};`,
    "--json"
  ]);
  const payload = parseWranglerJson(output);
  const block = Array.isArray(payload) ? payload[0] : payload;
  return block?.results?.[0] ?? { count: 0, oldest: null };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const beforeRaw = option("--before");
  if (!beforeRaw) throw new Error("--before <ISO timestamp> is required");
  const before = new Date(beforeRaw);
  if (Number.isNaN(before.getTime())) throw new Error("--before must be a valid timestamp");

  const channel = await fetchJson(
    `https://api.thingspeak.com/channels/${CHANNEL_ID}/feeds.json?results=1`
  );
  const channelCreated = new Date(channel?.channel?.created_at);
  const start = new Date(option("--start", channelCreated.toISOString()));
  if (Number.isNaN(start.getTime()) || start >= before) throw new Error("Backfill start is invalid");

  const batchSize = positiveInteger("--batch-size", 50);
  const maximumRowsWritten = positiveInteger("--max-rows-written", 60_000);
  const feeds = (await fetchAllFeeds(start, before))
    .filter((feed) => Date.parse(feed.created_at) < before.getTime());
  const readings = feeds.map(feedToReading)
    .sort((left, right) => right.entryId - left.entryId);
  const missingValues = readings.reduce(
    (count, reading) => count + reading.values.filter((field) => field.value === null).length,
    0
  );

  if (!apply) {
    console.log(JSON.stringify({
      status: "dry-run",
      channel_id: CHANNEL_ID,
      start: start.toISOString(),
      before: before.toISOString(),
      readings: readings.length,
      measurement_rows: readings.length * 8,
      missing_values: missingValues,
      newest: readings[0]?.measuredAt ?? null,
      oldest: readings.at(-1)?.measuredAt ?? null
    }, null, 2));
    return;
  }

  const progress = backfillProgress(start, before);
  const pending = remainingReadings(readings, progress);
  if (pending.length === 0) {
    console.log(JSON.stringify({
      status: "already-complete",
      channel_id: CHANNEL_ID,
      available_readings: readings.length,
      existing_readings: Number(progress.count),
      attempted_readings: 0,
      rows_written: 0,
      changes: 0
    }, null, 2));
    return;
  }

  const temporary = mkdtempSync(join(tmpdir(), "thingspeak-backfill-"));
  let rowsWritten = 0;
  let changes = 0;
  let attemptedReadings = 0;
  try {
    for (let index = 0; index < pending.length; index += batchSize) {
      if (rowsWritten >= maximumRowsWritten) break;
      const batch = pending.slice(index, index + batchSize);
      const file = join(temporary, `batch-${String(index / batchSize).padStart(4, "0")}.sql`);
      writeFileSync(file, batchSql(batch), "utf8");
      const result = executionMeta(wrangler([
        "d1", "execute", DATABASE, "--remote", "--file", file, "--yes", "--json"
      ]));
      rowsWritten += result.rowsWritten;
      changes += result.changes;
      attemptedReadings += batch.length;
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    status: rowsWritten >= maximumRowsWritten ? "write-limit-reached" : "complete",
    channel_id: CHANNEL_ID,
    available_readings: readings.length,
    existing_readings: Number(progress.count),
    pending_readings: pending.length,
    attempted_readings: attemptedReadings,
    rows_written: rowsWritten,
    changes,
    max_rows_written: maximumRowsWritten
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
