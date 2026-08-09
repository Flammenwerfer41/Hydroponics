import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareTableCounts,
  normalizeCountRows,
  parseWranglerJson,
  tableCountQuery,
  verifyArtifact
} from "./backup-support.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const manifestArgument = argument("--manifest");
const archiveArgument = argument("--archive");
const persistenceArgument = argument("--persist-to");
const DATABASE = argument("--database") || "hydroponics";
const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

if (!manifestArgument || !archiveArgument || !persistenceArgument) {
  console.error("Usage: node scripts/restore-d1-backup.mjs --manifest <file> --archive <file> --persist-to <new-directory>");
  process.exit(2);
}

const manifestPath = resolve(manifestArgument);
const archivePath = resolve(archiveArgument);
const persistencePath = resolve(persistenceArgument);
if (existsSync(persistencePath)) {
  console.error("Restore target already exists; choose a new directory to prevent accidental overwrite");
  process.exit(2);
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

const temporary = mkdtempSync(join(tmpdir(), "hydroponics-restore-"));
try {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const archive = readFileSync(archivePath);
  const sql = verifyArtifact(archive, manifest?.artifacts?.database);
  const sqlPath = join(temporary, "restore.sql");
  writeFileSync(sqlPath, sql);
  mkdirSync(persistencePath, { recursive: false });

  wrangler([
    "d1", "execute", DATABASE,
    "--local", "--persist-to", persistencePath,
    "--file", sqlPath, "--yes"
  ]);
  const countOutput = wrangler([
    "d1", "execute", DATABASE,
    "--local", "--persist-to", persistencePath,
    "--json", "--command", tableCountQuery()
  ]);
  const restoredCounts = normalizeCountRows(parseWranglerJson(countOutput));
  const mismatches = compareTableCounts(manifest.snapshot_table_counts, restoredCounts);
  if (mismatches.length) {
    throw new Error(`Restore row-count comparison failed: ${JSON.stringify(mismatches)}`);
  }

  console.log(JSON.stringify({
    status: "verified",
    restored_to: persistencePath,
    table_counts: restoredCounts
  }, null, 2));
} catch (error) {
  rmSync(persistencePath, { recursive: true, force: true });
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
