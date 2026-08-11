import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "..");
const output = path.resolve(root, "../docs/admin/journal/image-codec");

await mkdir(output, { recursive: true });

await build({
  entryPoints: [path.resolve(root, "frontend/journal-webp-worker.js")],
  outdir: output,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: ["safari17", "chrome120", "firefox120"],
  entryNames: "webp-worker",
  chunkNames: "chunk-[hash]",
  assetNames: "asset-[hash]",
  loader: { ".wasm": "file" },
  legalComments: "linked",
  sourcemap: false,
  minify: true
});

console.log(`Built journal WebP worker in ${output}`);
