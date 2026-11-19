# Main dashboard integration — activated 2026-11-14

## Station history charts — deployed 2026-11-15

Scroll fix deployed 2026-11-15: viewport-height changes no longer recreate the
history section. Container resizing updates only SVG geometry when its actual
width changes, retaining cards, focusable SVG nodes, selected readings and battery
display mode. Regression suite: 114 tests passed. Simulated mobile height change
kept scrollY at 2822 and retained focus/selection; width changes retained selection
and focus as well. Production history loaded 77 readings after deployment.
Fix deployment: `f413d9a0-fd68-4a65-a7e2-b1b2f1a0d230`.

The public `/weather/` page now loads history only when the user clicks its chart
button. It offers trailing 24-hour, 48-hour and 7-day ranges, with temperature,
humidity, station pressure and a voltage/estimated-percentage battery chart.
The existing battery conversion remains display-only and is not a calibrated SOC
measurement. All dates use Asia/Tokyo; invalid fields and gaps above 20 minutes
break lines. Charts support pointer/touch inspection and keyboard arrow keys.

One raw history request includes only the four station metrics and the station
device filter. Pagination has a fixed range, a 1,000-row page size and a maximum
of three requests. Exhausted pagination fails explicitly instead of silently
displaying a truncated history. There is no automatic history refresh or retry.
The existing latest-value polling is unchanged. No migration or firmware update
is required.

Validation: 113 tests passed, mobile layout and battery toggle checked with
synthetic data, production button loaded 64 real readings successfully.
Deployment version: `9f78a9ef-1cc9-49ec-9ed3-154840cd4e4f`.

## Main dashboard activation

The main dashboard's `docs/weather-config.js` explicitly sets
`balconyWeatherEnabled: true` following user approval and real BME280 reception.
Asset cache versions are updated. Cloudflare deployment completed and the public
assets and live balcony readings were verified. Worker code was byte-identical to
the previous deployment; only five dashboard assets changed.
Deployment version: `7a5ec628-d0d6-44f0-bf19-da718480005c`.
No station fetch or scene DOM replacement occurs if the flag is later disabled.
This work requires no firmware, D1 migration or JMA collection change.

When enabled after approval:

- `docs/dashboard/outdoor.js` mounts balcony temperature/humidity as the primary
  outdoor readings. Native `<details>` compares temperature, humidity and **station
  pressure** with JMA. Sea-level pressure is never substituted or differenced.
- JMA precipitation (10-minute amount), wind, and the existing forecast remain.
  JMA calculated apparent temperature is explicitly labeled inside the disclosure.
- Both observation timestamps (JST date + time), source station names, and the
  forecast's independent publication timestamp are preserved.
- A single latest-reading query for `balcony-weather-01`, four metrics and at most
  seven days lookback runs with the existing 15-minute weather refresh, not the
  tower's minute refresh. Hidden tabs cancel requests; there is no retry loop.
- The existing minute refresh recomputes age locally. Over 35 minutes old, missing,
  invalid-quality or failed-fetch balcony values are not displayed as current.
  JMA never silently fills balcony gaps. JMA observations expire at 30 minutes.
- Independent requests allow either source to work when the other fails. No
  historical graph joins different sources. Korean/Japanese are both supported.

## Local verification

From the repository root:

```powershell
node --test cloudflare-worker/test/outdoor-dashboard.test.mjs
node scripts/preview-outdoor.mjs ready
```

Open `http://127.0.0.1:8765/`. The preview enables the feature **in the served
response only**, supplies synthetic data, and never contacts production. Stop with
Ctrl+C. Other scenarios: `disabled`, `stale`, `partial`, `empty`, `error`, `jma-error`.
The preview is loopback-only and must never be deployed.

Before activation: connect/validate BME280; review expanded/collapsed layout on
desktop/mobile; explicitly enable the flag; bump the app/CSS/config asset version
query strings in `docs/index.html`; then deploy only upon user instruction. Avoid
shipping unrelated pending weather-station changes accidentally.
