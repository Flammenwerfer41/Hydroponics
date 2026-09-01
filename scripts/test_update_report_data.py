import unittest
from datetime import datetime

from update_report_data import build_report, load_timezone


class ReportDataTest(unittest.TestCase):
    def test_includes_co2_illuminance_estimated_ppfd_and_dli(self):
        payload = {
            "channel": {"id": "esp32-01", "name": "test"},
            "calibrations": {
                "estimated_ppfd": {
                    "profile_id": "grow-light-01",
                    "version": 1,
                    "coefficient": 0.01732,
                    "output": {"unit": "umol/m2/s", "qualifier": "estimated"},
                }
            },
            "feeds": [
                {
                    "created_at": "2026-08-31T00:00:00+09:00",
                    "reading_id": "boot:1",
                    "field1": 26.0,
                    "co2_concentration": 812,
                    "illuminance": 10000,
                },
                {
                    "created_at": "2026-08-31T00:02:00+09:00",
                    "reading_id": "boot:2",
                    "field1": 26.1,
                    "co2_concentration": 824,
                    "illuminance": 10000,
                },
            ],
        }
        report = build_report(
            payload,
            source_id="esp32-01",
            source_url="fixture.json",
            now=datetime.fromisoformat("2026-09-01T01:30:00+09:00"),
            local_timezone=load_timezone("Asia/Tokyo"),
        )

        self.assertEqual(report["schema_version"], 2)
        first = report["yesterday"]["feeds"][0]
        self.assertEqual(first["co2_concentration"], 812)
        self.assertEqual(first["illuminance"], 10000.0)
        self.assertEqual(first["estimated_ppfd"], 173.2)
        summary = report["daily_summary"][-1]
        self.assertEqual(summary["co2_concentration"]["mean"], 818.0)
        self.assertEqual(summary["co2_concentration"]["median"], 818.0)
        self.assertEqual(summary["estimated_ppfd"]["mean"], 173.2)
        self.assertEqual(summary["estimated_dli_mol_m2_day"], 0.0208)
        self.assertEqual(
            report["calibrations"]["estimated_ppfd"]["output"]["qualifier"],
            "estimated",
        )

    def test_keeps_missing_light_values_null(self):
        payload = {
            "channel": {},
            "feeds": [{
                "created_at": "2026-08-31T00:00:00+09:00",
                "reading_id": "boot:1",
                "co2_concentration": None,
                "illuminance": None,
            }],
        }
        report = build_report(
            payload,
            source_id="esp32-01",
            source_url="fixture.json",
            now=datetime.fromisoformat("2026-09-01T01:30:00+09:00"),
            local_timezone=load_timezone("Asia/Tokyo"),
        )
        first = report["yesterday"]["feeds"][0]
        self.assertIsNone(first["co2_concentration"])
        self.assertIsNone(first["illuminance"])
        self.assertIsNone(first["estimated_ppfd"])


if __name__ == "__main__":
    unittest.main()
