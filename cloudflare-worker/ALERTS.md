# Alert monitoring

The Worker evaluates alert rules once per minute after the SwitchBot status poll.
Measurement ingestion, light control, alert evaluation and Discord delivery are
failure-isolated so an alert-provider outage cannot interrupt sensor storage or control.

## Initial rules

| Rule | Warning | Critical | Recovery |
|---|---|---|---|
| Device data gap | 10 minutes | 30 minutes | two recent readings |
| Per-sensor missing value | 3 readings | 10 readings | two valid readings |
| Grow-light mismatch | 10 minutes | 30 minutes | 5 minutes matched |
| High air temperature | 32 °C for 30 min | 35 °C for 10 min | below 31/34 °C for 15 min |
| Low air temperature | 15 °C for 30 min | 10 °C for 15 min | above 16/12 °C for 15 min |
| High VPD | 2.5 kPa for 30 min | 3.0 kPa for 15 min | below 2.3/2.7 kPa for 15 min |
| High water temperature | 28 °C for 30 min | 30 °C for 15 min | below 27.5/29 °C for 15 min |
| Low water temperature | 18 °C for 30 min | 15 °C for 15 min | above 19/16 °C for 15 min |

The missing-value rules cover air temperature, humidity, pressure and water
temperature. Wi-Fi signal quality is intentionally not an alert source.

## State and delivery

Each rule persists `normal`, `warning` or `critical` state in D1, with a separate
pending transition timestamp. Crossing a threshold starts a timer; returning across
the hysteresis boundary cancels it. An incident creates at most one warning, one
critical escalation and one recovery notification.

Discord messages are first inserted into `alert_notifications` with a deterministic
event ID. Delivery is retried with exponential backoff and stops after five failed
attempts. The webhook URL must exist only as the Worker Secret
`DISCORD_WEBHOOK_URL`.

The public `GET /v1/alerts/active` response contains only currently active,
public-safe alert summaries. The dashboard hides its alert panel when this list is
empty and displays it above the current-environment scene when an incident is open.

Thresholds live in `alert_rules`, rather than source constants, so a future protected
management UI can edit them without changing firmware or the public dashboard.
