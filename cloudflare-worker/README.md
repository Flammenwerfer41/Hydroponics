# JMA weather Worker

This Worker hosts the public dashboard with Workers Static Assets, converts the latest
JMA AMeDAS observations into a small JSON response, and contains the authenticated D1
measurement ingestion API, a public read-only history API and an Access-protected
SwitchBot management dashboard.

- Tokyo (`44132`): temperature, humidity, pressure, wind and sunshine
- Setagaya (`44126`): local precipitation
- Tokyo district (`130010`): JMA weather-distribution forecast at three-hour intervals
- Dashboard: `/`
- Management dashboard: `/admin/` (Cloudflare Access required)
- Cultivation journal: `/admin/journal/` (Cloudflare Access required)
- Public journal: `/journal/` (only entries explicitly marked public)
- Weather endpoint: `/v1/current`
- Cache: five minutes
- JMA routes require no API key; control routes use Worker Secrets

The weather route still needs no secret. Measurement ingestion is documented in
[`INGESTION.md`](INGESTION.md), and history queries and exports are documented in
[`HISTORY_API.md`](HISTORY_API.md). The production `HYDROPONICS_DB` binding and the first
device credential have been active since 2026-08-09. Firmware v8.4.0 uses this D1
path as its sole remote measurement destination.

Static asset routing, verification and rollback are documented in
[`DASHBOARD_DEPLOYMENT.md`](DASHBOARD_DEPLOYMENT.md). `docs/weather-config.js` keeps
same-origin API calls on the primary Worker and points the Pages mirrors back to that Worker.

SwitchBot control, the 07:00/21:00 JST light schedule and Access configuration are
documented in [`CONTROL.md`](CONTROL.md).
The date-based cultivation journal, crop sections and manual pH/EC/top-up records are
documented in [`JOURNAL.md`](JOURNAL.md).

## Cloudflare dashboard setup

1. Open **Workers & Pages** and create a Worker by importing the GitHub repository.
2. Select `Flammenwerfer41/Hydroponics` and the `main` branch.
3. Set the root directory to `cloudflare-worker`.
4. Leave the build command empty and use `npx wrangler deploy` as the deploy command if Cloudflare asks for them.
5. Keep the Worker name `hydroponics-jma-weather`, or update `wrangler.jsonc` before deployment.
6. After deployment, copy the `workers.dev` URL and append `/v1/current`.

Do not configure the GitLab mirror as a second deployment source for the same Worker.

## Reproducible deployment

The pinned pnpm lockfile and `pnpm-workspace.yaml` allow only Wrangler's `esbuild` and
`workerd` install scripts. Install and verify locally with:

```text
pnpm install
pnpm test
pnpm deploy
```

`scripts/bootstrap-production.sql` contains the stable production site/device catalog
and a credential digest placeholder. Run `scripts/provision-device-credential.ps1`
from the repository root to generate an ignored bootstrap file and update the ignored
firmware secrets file without printing the bearer token. Applying that bootstrap rotates
the primary device credential, so deploy the matching firmware immediately afterward.
