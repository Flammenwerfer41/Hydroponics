# SwitchBot control and administrator access

The public dashboard remains available at `/`. The management dashboard and every
write endpoint live below `/admin/` so one Cloudflare Access application can protect
both the UI and API.

## Required Worker secrets

- `SWITCHBOT_TOKEN`
- `SWITCHBOT_SECRET`
- `SWITCHBOT_LIGHT_DEVICE_ID`
- `SWITCHBOT_AC_DEVICE_ID`
- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_AUD`

The SwitchBot token and secret never reach the browser. The Worker signs OpenAPI
requests, and `/admin/api/*` additionally verifies the Access JWT signature, issuer,
audience and expiry. Missing Access configuration fails closed with HTTP 401.

## Routes

- `GET /v1/light/current`: public latest plug telemetry
- `GET /v1/light/history`: public raw or hourly light history
- `GET /admin/api/status`: sensors, plug state, schedule, AC last command and audit log
- `PUT /admin/api/light/schedule`: edit the JST light schedule
- `POST /admin/api/light/command`: manual ON/OFF until the next schedule transition
- `POST /admin/api/ac/command`: manual IR command only

The scheduled Worker runs every minute. It reads actual Plug Mini state, stores
telemetry, computes the desired state in `Asia/Tokyo`, and sends a command only when
the two differ. The initial policy is ON at 07:00 and OFF at 21:00 every day.

The air conditioner is an infrared virtual device. A successful API response means
the command was accepted for transmission, not that the appliance confirmed its
state. The UI therefore labels AC information as the last command.

## Cutover

1. Apply D1 migration `0003_actuator_control.sql`.
2. Configure the six Worker secrets.
3. Protect `https://hydroponics-jma-weather.flammenwerfer41.workers.dev/admin/*`
   with Cloudflare Access and allow only the administrator identity.
4. Deploy and confirm telemetry plus manual commands.
5. Disable the old 07:00/21:00 schedule in the SwitchBot app.
6. Install firmware v8.3.0 later; OTA is intentionally a separate operation.

Keep the SwitchBot app installed for IR remote re-registration and account recovery.
