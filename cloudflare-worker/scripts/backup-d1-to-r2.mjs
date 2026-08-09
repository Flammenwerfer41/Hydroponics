import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactMetadata,
  gzipArtifact,
  jstDateParts,
  normalizeCountRows,
  parseWranglerJson,
  previousJstDate,
  tableCountQuery
} from "./backup-support.mjs";

const DATABASE = process.env.HYDRO_BACKUP_DATABASE || "hydroponics";
const BUCKET = process.env.HYDRO_BACKUP_BUCKET || "hydroponics-backups";
const HISTORY_URL = process.env.HYDRO_HISTORY_URL ||
  "https://hydroponics-jma-weather.flammenwerfer41.workers.dev";
const DRY_RUN = process.argv.includes("--dry-run");
const LOCAL_SOURCE = process.argv.includes("--local");
const sourceIndex = process.argv.indexOf("--source-dir");
const SOURCE_DIRECTORY = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : null;
const outputIndex = process.argv.indexOf("--output-dir");
const OUTPUT_DIRECTORY = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

function wrangler(args, options = {}) {
  try {
    return execFileSync(process.execPath, [WRANGLER, ...args], {
      cwd: new URL("..", import.meta.url),
      encoding: options.encoding ?? "utf8",
      env: process.env,
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const detail = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    throw new Error(detail || `Wrangler command failed: ${args.slice(0, 3).join(" ")}`);
  }
}

function putObject(key, file, contentType) {
  if (DRY_RUN) return;
  const args = [
    "r2", "object", "put", `${BUCKET}/${key}`,
    "--file", file,
    "--content-type", contentType,
    "--remote"
  ];
  wrangler(args, { stdio: "inherit" });
}

function validateSql(sql) {
  const text = sql.toString("utf8");
  if (sql.length < 256 || !text.includes("CREATE TABLE") || !text.includes("readings")) {
    throw new Error("D1 export is incomplete or does not contain the expected schema");
  }
}

async function main() {
  if (LOCAL_SOURCE && !SOURCE_DIRECTORY) {
    throw new Error("--local requires --source-dir <Wrangler project directory>");
  }
  if (OUTPUT_DIRECTORY && existsSync(OUTPUT_DIRECTORY)) {
    throw new Error("--output-dir must point to a new directory");
  }
  const now = new Date();
  const generatedAt = now.toISOString();
  const { year, month, day, weekday } = jstDateParts(now);
  const stamp = generatedAt.replaceAll(":", "-").replace(".", "-");
  const yesterday = previousJstDate(now);
  const temporary = mkdtempSync(join(tmpdir(), "hydroponics-backup-"));

  try {
    const sqlPath = join(temporary, "hydroponics.sql");
    const exportArguments = [
      "d1", "export", DATABASE,
      "--output", sqlPath,
      "--skip-confirmation"
    ];
    if (LOCAL_SOURCE) exportArguments.push("--local", "--cwd", SOURCE_DIRECTORY);
    else exportArguments.push("--remote");
    wrangler(exportArguments, { stdio: "inherit" });

    const sql = readFileSync(sqlPath);
    validateSql(sql);
    const sqlArchive = gzipArtifact(sql);
    const sqlArchivePath = `${sqlPath}.gz`;
    writeFileSync(sqlArchivePath, sqlArchive);

    const validationPersistence = join(temporary, "validation-d1");
    wrangler([
      "d1", "execute", DATABASE,
      "--local", "--persist-to", validationPersistence,
      "--file", sqlPath, "--yes"
    ]);
    const countsOutput = wrangler([
      "d1", "execute", DATABASE,
      "--local", "--persist-to", validationPersistence, "--json",
      "--command", tableCountQuery()
    ]);
    const tableCounts = normalizeCountRows(parseWranglerJson(countsOutput));

    const sensorResponse = await fetch(
      `${HISTORY_URL}/v1/export.json?date=${encodeURIComponent(yesterday)}`,
      { headers: { Accept: "application/json" } }
    );
    if (!sensorResponse.ok) {
      throw new Error(`Sensor export failed with HTTP ${sensorResponse.status}`);
    }
    const sensorObject = await sensorResponse.json();
    const sensorJson = Buffer.from(`${JSON.stringify(sensorObject, null, 2)}\n`, "utf8");
    const sensorArchive = gzipArtifact(sensorJson);
    const sensorArchivePath = join(temporary, "sensor.json.gz");
    writeFileSync(sensorArchivePath, sensorArchive);

    const dailySqlKey = `d1/daily/${year}/${month}/${day}/hydroponics-${stamp}.sql.gz`;
    const sensorKey = `sensor/daily/${yesterday.slice(0, 4)}/${yesterday.slice(5, 7)}/${yesterday}.json.gz`;
    const manifestKey = `manifests/daily/${year}/${month}/${day}/manifest-${stamp}.json`;
    const artifacts = {
      database: artifactMetadata(sql, sqlArchive, dailySqlKey, "application/sql"),
      sensor: artifactMetadata(sensorJson, sensorArchive, sensorKey, "application/json")
    };

    const manifest = {
      schema_version: 1,
      generated_at: generatedAt,
      timezone: "Asia/Tokyo",
      database: DATABASE,
      source: "Cloudflare D1",
      snapshot_table_counts: tableCounts,
      sensor_archive_date: yesterday,
      artifacts
    };
    const manifestPath = join(temporary, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    if (OUTPUT_DIRECTORY) {
      mkdirSync(OUTPUT_DIRECTORY, { recursive: false });
      copyFileSync(sqlArchivePath, join(OUTPUT_DIRECTORY, "database.sql.gz"));
      copyFileSync(sensorArchivePath, join(OUTPUT_DIRECTORY, "sensor.json.gz"));
      copyFileSync(manifestPath, join(OUTPUT_DIRECTORY, "manifest.json"));
    }

    putObject(dailySqlKey, sqlArchivePath, "application/gzip");
    putObject(sensorKey, sensorArchivePath, "application/gzip");
    putObject(manifestKey, manifestPath, "application/json");
    putObject("manifests/latest.json", manifestPath, "application/json");

    if (weekday === "Sun") {
      const weeklySqlKey = `d1/weekly/${year}/${month}/${day}/hydroponics-${stamp}.sql.gz`;
      const weeklyManifest = structuredClone(manifest);
      weeklyManifest.artifacts.database.key = weeklySqlKey;
      const weeklyManifestPath = join(temporary, "weekly-manifest.json");
      writeFileSync(weeklyManifestPath, `${JSON.stringify(weeklyManifest, null, 2)}\n`, "utf8");
      putObject(weeklySqlKey, sqlArchivePath, "application/gzip");
      putObject(`manifests/weekly/${year}/${month}/${day}/manifest-${stamp}.json`, weeklyManifestPath, "application/json");
      putObject("manifests/latest-weekly.json", weeklyManifestPath, "application/json");
    }

    console.log(JSON.stringify({
      status: DRY_RUN ? "validated" : "uploaded",
      source_mode: LOCAL_SOURCE ? "local" : "remote",
      bucket: BUCKET,
      output_directory: OUTPUT_DIRECTORY,
      manifest: manifestKey,
      table_counts: tableCounts,
      artifacts
    }, null, 2));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
