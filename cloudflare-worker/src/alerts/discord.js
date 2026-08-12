import {
  markNotificationDelivered,
  markNotificationFailed,
  pendingNotifications
} from "./store.js";

const COLORS = Object.freeze({ info: 0x2f9e78, warning: 0xe0a21a, critical: 0xd94841 });

function discordBody(notification) {
  const payload = notification.payload;
  const eventLabels = {
    opened: notification.severity === "critical" ? "경보 발생" : "주의 발생",
    escalated: "경보로 격상",
    resolved: "정상 복구"
  };
  let value = Number.isFinite(payload.value)
    ? `${payload.value}${payload.unit ? ` ${payload.unit}` : ""}`
    : "측정값 없음";
  if (payload.alert_type === "device_data_gap") {
    value = Number.isFinite(payload.value) ? `${Math.round(payload.value)}분 단절` : "수신 시각 확인 불가";
  } else if (String(payload.alert_type || "").startsWith("sensor_missing_")) {
    value = Number.isFinite(payload.value) ? `${Math.round(payload.value)}회 연속 결측` : "측정값 없음";
  } else if (payload.alert_type === "light_control_mismatch") {
    value = "목표 상태와 실제 상태 불일치";
  }
  const fields = [{ name: "현재 상태", value, inline: true }];
  if (payload.duration_minutes !== null) {
    fields.push({ name: "지속시간", value: `${payload.duration_minutes}분`, inline: true });
  }
  fields.push({ name: "관측 시각", value: payload.observed_at || "확인 불가", inline: false });
  return {
    username: "Hydroponics Monitor",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `${notification.event_type === "resolved" ? "🟢" : notification.severity === "critical" ? "🔴" : "🟠"} ${payload.title_ko}`,
      description: eventLabels[notification.event_type],
      color: COLORS[notification.severity] || COLORS.info,
      fields,
      footer: { text: `Hydroponics · ${notification.id}` },
      timestamp: payload.event_at
    }]
  };
}

async function postDiscord(webhookUrl, notification) {
  const separator = webhookUrl.includes("?") ? "&" : "?";
  const response = await fetch(`${webhookUrl}${separator}wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(discordBody(notification))
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Discord returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 120)}` : ""}`);
  }
}

export async function deliverDiscordNotifications(environment, now = new Date()) {
  if (!environment.DISCORD_WEBHOOK_URL || !environment.HYDROPONICS_DB) {
    return { attempted: 0, delivered: 0 };
  }
  const notifications = await pendingNotifications(environment.HYDROPONICS_DB, now);
  let delivered = 0;
  for (const notification of notifications) {
    try {
      await postDiscord(environment.DISCORD_WEBHOOK_URL, notification);
      await markNotificationDelivered(environment.HYDROPONICS_DB, notification.id, new Date());
      delivered += 1;
    } catch (error) {
      console.error("Discord alert delivery failed", { id: notification.id, error });
      await markNotificationFailed(
        environment.HYDROPONICS_DB, notification, error, new Date()
      );
    }
  }
  return { attempted: notifications.length, delivered };
}
