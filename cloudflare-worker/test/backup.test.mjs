import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactMetadata,
  cloudflareAccessHeaders,
  compareTableCounts,
  DATABASE_TABLES,
  gzipArtifact,
  normalizeCountRows,
  parseWranglerJson,
  previousJstDate,
  sha256,
  tableCountQuery,
  verifyArtifact
} from "../scripts/backup-support.mjs";

test("compressed artifacts round-trip with both checksums", () => {
  const content = Buffer.from("CREATE TABLE readings (id INTEGER);\n", "utf8");
  const archive = gzipArtifact(content);
  const metadata = artifactMetadata(content, archive, "backup.sql.gz", "application/sql");
  assert.deepEqual(verifyArtifact(archive, metadata), content);
  assert.equal(metadata.uncompressed_sha256, sha256(content));
  assert.equal(metadata.storage_content_type, "application/gzip");
});

test("checksum mismatch rejects a damaged archive", () => {
  const content = Buffer.from("safe backup", "utf8");
  const archive = gzipArtifact(content);
  const metadata = artifactMetadata(content, archive, "backup.gz", "text/plain");
  const damaged = Buffer.from(archive);
  damaged[damaged.length - 1] ^= 1;
  assert.throws(() => verifyArtifact(damaged, metadata), /checksum/);
});

test("protected backup export uses normalized Cloudflare Access credentials", () => {
  assert.deepEqual(cloudflareAccessHeaders("\uFEFF client-id.access ", " secret "), {
    Accept: "application/json",
    "CF-Access-Client-Id": "client-id.access",
    "CF-Access-Client-Secret": "secret"
  });
  assert.throws(() => cloudflareAccessHeaders("", "secret"), /CF_ACCESS_CLIENT_ID/);
});

test("JST calendar subtraction is independent of UTC date", () => {
  assert.equal(previousJstDate(new Date("2026-08-09T00:30:00Z")), "2026-08-08");
});

test("Wrangler JSON and table counts normalize", () => {
  const parsed = parseWranglerJson('warning\n[{"results":[{"table_name":"sites","row_count":1}]}]');
  assert.deepEqual(normalizeCountRows(parsed), { sites: 1 });
});

test("count query covers every portable table", () => {
  const query = tableCountQuery();
  for (const table of DATABASE_TABLES) assert.match(query, new RegExp(`FROM "${table}"`));
  for (const table of ["journal_days", "journal_sections", "journal_tags", "journal_section_tags", "journal_day_values", "journal_photos", "journal_crop_photos"]) {
    assert.ok(DATABASE_TABLES.includes(table), `${table} must be included in backup verification`);
  }
});

test("count comparison identifies changed and missing tables", () => {
  const expected = Object.fromEntries(DATABASE_TABLES.map((table) => [table, 0]));
  const actual = { ...expected, readings: 2 };
  assert.deepEqual(compareTableCounts(expected, actual), [
    { table: "readings", source: 0, restored: 2 }
  ]);
});
