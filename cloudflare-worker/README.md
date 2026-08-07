# JMA weather Worker

This Worker converts the latest JMA AMeDAS observations into a small JSON response for the public dashboard.

- Tokyo (`44132`): temperature, humidity, pressure, wind and sunshine
- Setagaya (`44126`): local precipitation
- Endpoint: `/v1/current` (the root path returns the same response)
- Cache: five minutes
- No API key, KV namespace or secret is required

The dashboard URL is configured separately in `docs/weather-config.js` after the first Cloudflare deployment.

## Cloudflare dashboard setup

1. Open **Workers & Pages** and create a Worker by importing the GitHub repository.
2. Select `Flammenwerfer41/Hydroponics` and the `main` branch.
3. Set the root directory to `cloudflare-worker`.
4. Leave the build command empty and use `npx wrangler deploy` as the deploy command if Cloudflare asks for them.
5. Keep the Worker name `hydroponics-jma-weather`, or update `wrangler.jsonc` before deployment.
6. After deployment, copy the `workers.dev` URL and append `/v1/current`.

Do not configure the GitLab mirror as a second deployment source for the same Worker.
