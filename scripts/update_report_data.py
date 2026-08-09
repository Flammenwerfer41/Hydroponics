#!/usr/bin/env python3
"""Build a compact daily report bridge from Cloudflare D1 telemetry."""

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
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


SCHEMA_VERSION = 1
DEFAULT_BASE_URL = "https://hydroponics-jma-weather.flammenwerfer41.workers.dev"
DEFAULT_DEVICE_ID = "esp32-01"
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


def load_timezone(name: str) -> ZoneInfo | timezone:
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        if name == "Asia/Tokyo":
            return timezone(timedelta(hours=9), name)
        raise


def timezone_name(value: ZoneInfo | timezone) -> str:
    return getattr(value, "key", None) or value.tzname(None) or DEFAULT_TIMEZONE


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


def fetch_json(url: str) -> dict[str, Any]:
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "HydroponicsReportBridge/2.0",
        },
    )
    with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        if response.status != 200:
            raise RuntimeError(f"Cloudflare API returned HTTP {response.status}")
        body = response.read()
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("Cloudflare API response was not valid UTF-8 JSON") from error
    if not isinstance(payload, dict):
        raise RuntimeError("Cloudflare API response root must be an object")
    return payload


def fetch_payload(
    base_url: str,
    device_id: str,
    days: int,
    now: datetime,
    local_timezone: ZoneInfo,
) -> tuple[dict[str, Any], str]:
    yesterday = now.astimezone(local_timezone).date() - timedelta(days=1)
    start_date = yesterday - timedelta(days=days - 2)
    range_start = datetime.combine(start_date, time.min, local_timezone)
    range_end = datetime.combine(yesterday + timedelta(days=1), time.min, local_timezone)
    metrics = "air_temperature,humidity,pressure,wifi_rssi,water_temperature"
    query = urlencode({
        "from": format_timestamp(range_start),
        "to": format_timestamp(range_end),
        "device_id": device_id,
        "metrics": metrics,
    })
    export_url = f"{base_url.rstrip('/')}/v1/export.json?{query}"
    light_url = f"{base_url.rstrip('/')}/v1/light/history?{urlencode({'days': days, 'granularity': 'raw'})}"
    sensor_payload = fetch_json(export_url)
    light_payload = fetch_json(light_url)
    readings = sensor_payload.get("readings")
    points = light_payload.get("points")
    if not isinstance(readings, list):
        raise RuntimeError("Cloudflare export is missing the readings array")
    if not isinstance(points, list):
        raise RuntimeError("Cloudflare light history is missing the points array")

    light_records: list[tuple[datetime, dict[str, Any]]] = []
    for point in points:
        if not isinstance(point, dict):
            continue
        try:
            timestamp = parse_timestamp(point.get("time"))
        except ValueError:
            continue
        light_records.append((timestamp, point))
    light_records.sort(key=lambda item: item[0])

    feeds: list[dict[str, Any]] = []
    light_index = 0
    for reading in sorted(
        (item for item in readings if isinstance(item, dict)),
        key=lambda item: item.get("measured_at") or "",
    ):
        measured_at = reading.get("measured_at")
        try:
            reading_time = parse_timestamp(measured_at)
        except ValueError:
            continue
        while (
            light_index + 1 < len(light_records)
            and light_records[light_index + 1][0] <= reading_time
        ):
            light_index += 1
        nearest = None
        candidates = light_records[max(0, light_index - 1):light_index + 2]
        if candidates:
            candidate_time, candidate = min(candidates, key=lambda item: abs((item[0] - reading_time).total_seconds()))
            if abs((candidate_time - reading_time).total_seconds()) <= GAP_THRESHOLD_SECONDS:
                nearest = candidate
        values = reading.get("values") if isinstance(reading.get("values"), dict) else {}
        feed = {
            "created_at": measured_at,
            "reading_id": reading.get("reading_id"),
            "field1": values.get("air_temperature"),
            "field2": values.get("humidity"),
            "field3": values.get("pressure"),
            "field4": values.get("wifi_rssi"),
            "field5": values.get("water_temperature"),
            "field6": nearest.get("light_status") if nearest else None,
            "field7": nearest.get("light_power") if nearest else None,
            "field8": nearest.get("light_uptime") if nearest else None,
        }
        feeds.append(feed)

    payload = {
        "channel": {
            "id": device_id,
            "name": "Hydroponics Cloudflare telemetry",
            "description": "ESP32 sensor and SwitchBot actuator telemetry stored in Cloudflare D1",
            **FIELD_NAMES,
        },
        "feeds": feeds,
    }
    validate_payload(payload)
    return payload, export_url


def load_payload(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as source:
        payload = json.load(source)
    validate_payload(payload)
    return payload


def validate_payload(payload: Any) -> None:
    if not isinstance(payload, dict):
        raise RuntimeError("report source root must be an object")
    if not isinstance(payload.get("channel"), dict):
        raise RuntimeError("report source is missing channel metadata")
    if not isinstance(payload.get("feeds"), list):
        raise RuntimeError("report source is missing the feeds array")


def normalize_feed(feed: dict[str, Any], local_timezone: ZoneInfo) -> tuple[datetime, dict[str, Any]]:
    source_time = parse_timestamp(feed.get("created_at"))
    local_time = source_time.astimezone(local_timezone)
    normalized: dict[str, Any] = {
        "time": format_timestamp(local_time),
        "entry_id": finite_number(feed.get("entry_id"), integer=True),
        "reading_id": feed.get("reading_id") if isinstance(feed.get("reading_id"), str) else None,
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
    seen_reading_ids: set[str] = set()
    for feed in feeds:
        if not isinstance(feed, dict):
            continue
        try:
            local_time, record = normalize_feed(feed, local_timezone)
        except (TypeError, ValueError):
            continue
        entry_id = record["entry_id"]
        reading_id = record["reading_id"]
        if isinstance(reading_id, str):
            if reading_id in seen_reading_ids:
                continue
            seen_reading_ids.add(reading_id)
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


def channel_metadata(channel: dict[str, Any], source_id: str) -> dict[str, Any]:
    fields = {
        field: channel.get(field) or fallback
        for field, fallback in FIELD_NAMES.items()
    }
    return {
        "id": channel.get("id") or source_id,
        "name": channel.get("name") or None,
        "description": channel.get("description") or None,
        "latitude": finite_number(channel.get("latitude")),
        "longitude": finite_number(channel.get("longitude")),
        "fields": fields,
    }


def build_report(
    payload: dict[str, Any],
    *,
    source_id: str,
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
        "timezone": timezone_name(local_timezone),
        "channel": channel_metadata(payload["channel"], source_id),
        "period": {
            "yesterday": yesterday.isoformat(),
            "seven_day_start": seven_day_start.isoformat(),
            "seven_day_end": yesterday.isoformat(),
        },
        "quality": {
            "source": "Cloudflare D1",
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
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--device-id", default=DEFAULT_DEVICE_ID)
    parser.add_argument("--days", type=int, default=DEFAULT_FETCH_DAYS)
    parser.add_argument("--timezone", default=DEFAULT_TIMEZONE)
    parser.add_argument("--output", type=Path, default=Path("docs/report-data.json"))
    parser.add_argument("--input-json", type=Path, help="Use a saved normalized source response instead of HTTP")
    parser.add_argument("--now", help="Override current time for deterministic testing")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.days < 8:
        raise ValueError("--days must be at least 8 to cover seven complete JST dates")
    local_timezone = load_timezone(args.timezone)
    now = parse_now(args.now, local_timezone)
    if args.input_json:
        payload = load_payload(args.input_json)
        source_url = str(args.input_json)
    else:
        payload, source_url = fetch_payload(
            args.base_url,
            args.device_id,
            args.days,
            now,
            local_timezone,
        )
    report = build_report(
        payload,
        source_id=args.device_id,
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
