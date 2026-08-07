#!/usr/bin/env python3
"""Build a compact, stable report-data.json from a public ThingSpeak channel."""

from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import sys
import tempfile
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


SCHEMA_VERSION = 1
DEFAULT_CHANNEL_ID = 3436358
DEFAULT_TIMEZONE = "Asia/Tokyo"
DEFAULT_FETCH_DAYS = 8
EXPECTED_INTERVAL_SECONDS = 120
GAP_THRESHOLD_SECONDS = 360
REQUEST_TIMEOUT_SECONDS = 30

FIELD_NAMES = {
    "field1": "Temperature",
    "field2": "Humidity",
    "field3": "Pressure",
    "field4": "WiFi RSSI",
    "field5": "Water Temperature",
    "field6": "LightStatus",
    "field7": "LightPower",
    "field8": "LightUptime",
}

NORMALIZED_FIELDS = {
    "field1": "temperature",
    "field2": "humidity",
    "field3": "pressure",
    "field4": "wifi_rssi",
    "field5": "water_temperature",
    "field6": "light_status",
    "field7": "light_power",
    "field8": "light_uptime",
}

SUMMARY_FIELDS = (
    "temperature",
    "humidity",
    "pressure",
    "wifi_rssi",
    "water_temperature",
)


def finite_number(value: Any, *, integer: bool = False) -> int | float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    if integer and number.is_integer():
        return int(number)
    return number


def parse_timestamp(value: Any) -> datetime:
    if not isinstance(value, str) or not value:
        raise ValueError("feed is missing created_at")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"created_at is not timezone-aware: {value}")
    return parsed


def format_timestamp(value: datetime) -> str:
    return value.isoformat(timespec="seconds")


def fetch_payload(channel_id: int, days: int) -> tuple[dict[str, Any], str]:
    query = urlencode({"days": days})
    url = f"https://api.thingspeak.com/channels/{channel_id}/feeds.json?{query}"
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "HydroponicsReportBridge/1.0",
        },
    )
    with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        if response.status != 200:
            raise RuntimeError(f"ThingSpeak returned HTTP {response.status}")
        body = response.read()
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("ThingSpeak response was not valid UTF-8 JSON") from error
    validate_payload(payload)
    return payload, url


def load_payload(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as source:
        payload = json.load(source)
    validate_payload(payload)
    return payload


def validate_payload(payload: Any) -> None:
    if not isinstance(payload, dict):
        raise RuntimeError("ThingSpeak response root must be an object")
    if not isinstance(payload.get("channel"), dict):
        raise RuntimeError("ThingSpeak response is missing channel metadata")
    if not isinstance(payload.get("feeds"), list):
        raise RuntimeError("ThingSpeak response is missing the feeds array")


def normalize_feed(feed: dict[str, Any], local_timezone: ZoneInfo) -> tuple[datetime, dict[str, Any]]:
    source_time = parse_timestamp(feed.get("created_at"))
    local_time = source_time.astimezone(local_timezone)
    normalized: dict[str, Any] = {
        "time": format_timestamp(local_time),
        "entry_id": finite_number(feed.get("entry_id"), integer=True),
    }
    for source_name, output_name in NORMALIZED_FIELDS.items():
        normalized[output_name] = finite_number(
            feed.get(source_name),
            integer=source_name in {"field4", "field6", "field8"},
        )
    return local_time, normalized


def normalize_feeds(feeds: Iterable[Any], local_timezone: ZoneInfo) -> list[tuple[datetime, dict[str, Any]]]:
    normalized: list[tuple[datetime, dict[str, Any]]] = []
    seen_entry_ids: set[int] = set()
    for feed in feeds:
        if not isinstance(feed, dict):
            continue
        try:
            local_time, record = normalize_feed(feed, local_timezone)
        except (TypeError, ValueError):
            continue
        entry_id = record["entry_id"]
        if isinstance(entry_id, int):
            if entry_id in seen_entry_ids:
                continue
            seen_entry_ids.add(entry_id)
        normalized.append((local_time, record))
    normalized.sort(key=lambda item: item[0])
    return normalized


def number_stats(values: Iterable[int | float | None]) -> dict[str, int | float | None]:
    valid = [float(value) for value in values if isinstance(value, (int, float)) and math.isfinite(value)]
    if not valid:
        return {"valid_count": 0, "min": None, "max": None, "mean": None}
    return {
        "valid_count": len(valid),
        "min": round(min(valid), 3),
        "max": round(max(valid), 3),
        "mean": round(statistics.fmean(valid), 3),
    }


def interval_quality(records: list[tuple[datetime, dict[str, Any]]]) -> dict[str, int | float | None]:
    intervals = [
        (records[index][0] - records[index - 1][0]).total_seconds()
        for index in range(1, len(records))
        if records[index][0] > records[index - 1][0]
    ]
    gaps = [interval for interval in intervals if interval > GAP_THRESHOLD_SECONDS]
    return {
        "gap_threshold_seconds": GAP_THRESHOLD_SECONDS,
        "gap_count": len(gaps),
        "max_gap_seconds": round(max(intervals), 3) if intervals else None,
        "mean_interval_seconds": round(statistics.fmean(intervals), 3) if intervals else None,
    }


def light_summary(records: list[tuple[datetime, dict[str, Any]]]) -> dict[str, Any]:
    known = [item for item in records if item[1]["light_status"] in (0, 1)]
    on = [item for item in known if item[1]["light_status"] == 1]
    power_on = [item[1]["light_power"] for item in on]
    uptime_values = [
        item[1]["light_uptime"]
        for item in records
        if isinstance(item[1]["light_uptime"], (int, float))
    ]
    on_seconds = 0.0
    for index in range(len(records) - 1):
        current_time, current = records[index]
        next_time = records[index + 1][0]
        duration = (next_time - current_time).total_seconds()
        if current["light_status"] == 1 and 0 < duration <= GAP_THRESHOLD_SECONDS:
            on_seconds += duration
    return {
        "valid_status_count": len(known),
        "on_sample_count": len(on),
        "off_sample_count": len(known) - len(on),
        "unknown_sample_count": len(records) - len(known),
        "first_on": format_timestamp(on[0][0]) if on else None,
        "last_on": format_timestamp(on[-1][0]) if on else None,
        "estimated_on_minutes": round(on_seconds / 60, 2),
        "power_when_on": number_stats(power_on),
        "last_reported_uptime_minutes": uptime_values[-1] if uptime_values else None,
        "max_reported_uptime_minutes": max(uptime_values) if uptime_values else None,
    }


def summarize_day(day_value: date, records: list[tuple[datetime, dict[str, Any]]]) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "date": day_value.isoformat(),
        "sample_count": len(records),
        "first_sample": format_timestamp(records[0][0]) if records else None,
        "last_sample": format_timestamp(records[-1][0]) if records else None,
    }
    for field in SUMMARY_FIELDS:
        summary[field] = number_stats(record[field] for _, record in records)
    summary["light"] = light_summary(records)
    summary["quality"] = interval_quality(records)
    return summary


def hourly_summary(records: list[tuple[datetime, dict[str, Any]]]) -> list[dict[str, Any]]:
    grouped: dict[int, list[tuple[datetime, dict[str, Any]]]] = {}
    for item in records:
        grouped.setdefault(item[0].hour, []).append(item)
    output: list[dict[str, Any]] = []
    for hour in sorted(grouped):
        hour_records = grouped[hour]
        known_light = [record for _, record in hour_records if record["light_status"] in (0, 1)]
        on_count = sum(1 for record in known_light if record["light_status"] == 1)
        item: dict[str, Any] = {
            "hour": f"{hour:02d}:00",
            "sample_count": len(hour_records),
        }
        for field in SUMMARY_FIELDS:
            item[field] = number_stats(record[field] for _, record in hour_records)
        item["light"] = {
            "valid_status_count": len(known_light),
            "on_fraction": round(on_count / len(known_light), 4) if known_light else None,
            "power_when_on": number_stats(
                record["light_power"]
                for record in known_light
                if record["light_status"] == 1
            ),
        }
        output.append(item)
    return output


def channel_metadata(channel: dict[str, Any], channel_id: int) -> dict[str, Any]:
    fields = {
        field: channel.get(field) or fallback
        for field, fallback in FIELD_NAMES.items()
    }
    return {
        "id": finite_number(channel.get("id"), integer=True) or channel_id,
        "name": channel.get("name") or None,
        "description": channel.get("description") or None,
        "latitude": finite_number(channel.get("latitude")),
        "longitude": finite_number(channel.get("longitude")),
        "fields": fields,
    }


def build_report(
    payload: dict[str, Any],
    *,
    channel_id: int,
    source_url: str,
    now: datetime,
    local_timezone: ZoneInfo,
) -> dict[str, Any]:
    normalized = normalize_feeds(payload["feeds"], local_timezone)
    yesterday = now.astimezone(local_timezone).date() - timedelta(days=1)
    seven_day_start = yesterday - timedelta(days=6)
    day_start = datetime.combine(yesterday, time.min, local_timezone)
    day_end = datetime.combine(yesterday, time.max, local_timezone)

    yesterday_records = [item for item in normalized if item[0].date() == yesterday]
    seven_day_records = [
        item for item in normalized
        if seven_day_start <= item[0].date() <= yesterday
    ]
    grouped: dict[date, list[tuple[datetime, dict[str, Any]]]] = {}
    for item in seven_day_records:
        grouped.setdefault(item[0].date(), []).append(item)

    report = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": format_timestamp(now.astimezone(local_timezone)),
        "timezone": local_timezone.key,
        "channel": channel_metadata(payload["channel"], channel_id),
        "period": {
            "yesterday": yesterday.isoformat(),
            "seven_day_start": seven_day_start.isoformat(),
            "seven_day_end": yesterday.isoformat(),
        },
        "quality": {
            "source": "ThingSpeak",
            "source_url": source_url,
            "expected_interval_seconds": EXPECTED_INTERVAL_SECONDS,
            "seven_day_sample_count": len(seven_day_records),
            "yesterday_raw_count": len(yesterday_records),
            **interval_quality(yesterday_records),
        },
        "daily_summary": [
            summarize_day(day_value, grouped.get(day_value, []))
            for day_value in (seven_day_start + timedelta(days=offset) for offset in range(7))
        ],
        "hourly_summary": hourly_summary(yesterday_records),
        "yesterday": {
            "date": yesterday.isoformat(),
            "start": format_timestamp(day_start),
            "end": format_timestamp(day_end),
            "feeds": [record for _, record in yesterday_records],
        },
    }
    # This catches accidental NaN/Infinity values before the destination is touched.
    json.dumps(report, ensure_ascii=False, allow_nan=False)
    return report


def comparable_report(report: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in report.items() if key != "generated_at"}


def render_report(report: dict[str, Any]) -> str:
    return json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"


def write_report_atomically(output: Path, report: dict[str, Any]) -> bool:
    if output.exists():
        try:
            existing_text = output.read_text(encoding="utf-8")
            existing = json.loads(existing_text)
            if comparable_report(existing) == comparable_report(report):
                comparison_copy = dict(report)
                comparison_copy["generated_at"] = existing.get("generated_at")
                if render_report(comparison_copy) == existing_text:
                    print(f"Report data is unchanged: {output}")
                    return False
        except (OSError, json.JSONDecodeError, TypeError):
            pass

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=output.parent,
            prefix=f".{output.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(render_report(report))
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, output)
    finally:
        if temporary_path and temporary_path.exists():
            temporary_path.unlink()
    print(f"Wrote {output}")
    return True


def parse_now(value: str | None, local_timezone: ZoneInfo) -> datetime:
    if not value:
        return datetime.now(local_timezone)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=local_timezone)
    return parsed.astimezone(local_timezone)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channel-id", type=int, default=DEFAULT_CHANNEL_ID)
    parser.add_argument("--days", type=int, default=DEFAULT_FETCH_DAYS)
    parser.add_argument("--timezone", default=DEFAULT_TIMEZONE)
    parser.add_argument("--output", type=Path, default=Path("docs/report-data.json"))
    parser.add_argument("--input-json", type=Path, help="Use a saved ThingSpeak response instead of HTTP")
    parser.add_argument("--now", help="Override current time for deterministic testing")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.days < 8:
        raise ValueError("--days must be at least 8 to cover seven complete JST dates")
    local_timezone = ZoneInfo(args.timezone)
    now = parse_now(args.now, local_timezone)
    if args.input_json:
        payload = load_payload(args.input_json)
        source_url = str(args.input_json)
    else:
        payload, source_url = fetch_payload(args.channel_id, args.days)
    report = build_report(
        payload,
        channel_id=args.channel_id,
        source_url=source_url,
        now=now,
        local_timezone=local_timezone,
    )
    write_report_atomically(args.output, report)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
