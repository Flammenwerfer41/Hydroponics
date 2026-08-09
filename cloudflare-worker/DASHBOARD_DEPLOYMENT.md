# Cloudflare dashboard deployment

The primary dashboard is deployed with the API Worker as one Workers Static Assets
unit. The same `docs/` directory remains publishable by GitHub Pages and GitLab Pages
as an emergency read-only mirror.

## Routing

- `/`, HTML, CSS, JavaScript, images and icons are served directly from Static Assets.
- `/v1/*` always runs the Worker first and never falls through to a similarly named asset.
- The primary `workers.dev` dashboard uses same-origin `/v1/*` requests.
- A Pages mirror detects its different origin and reads the public API from the canonical
  Worker origin. Measurement ingestion remains authenticated and is not exposed by the UI.

Static assets are free to serve and do not invoke Worker code. Only `/v1/*` requests
consume Worker requests. The configuration source of truth is `wrangler.jsonc`.

## Verify before deployment

From `cloudflare-worker/`:

```text
pnpm install --frozen-lockfile
pnpm test
node --check ../docs/app.js
pnpm exec wrangler deploy --dry-run
```

The dry run must include the `ASSETS` and `HYDROPONICS_DB` bindings. It must not print
or request device credentials.

## Deploy and smoke test

```text
pnpm deploy
```

Then verify:

1. `/` returns the dashboard HTML.
2. `/styles.css`, `/scene.css` and the scene images return their expected content types.
3. `/v1/readings/latest?days=1` returns D1 data.
4. `/v1/history/hourly?days=7` returns hourly buckets.
5. `/v1/current` returns JMA observations and forecast.
6. Korean/Japanese switching, all three graph ranges and the light timeline render.
7. GitHub Pages and GitLab Pages still load data from the canonical Worker API.

## Roll back

List recent deployments and identify the previous known-good version:

```text
pnpm exec wrangler deployments list
```

Roll back immediately with an explicit version ID:

```text
pnpm exec wrangler rollback <VERSION_ID> --message "rollback dashboard deployment"
```

A Worker rollback changes the active Worker and Static Assets version together. It does
not modify D1 data, R2 backups, firmware, or either Pages mirror. If Cloudflare serving is
unavailable, use the GitHub or GitLab Pages mirror while the primary deployment is fixed.
