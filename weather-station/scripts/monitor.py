"""Bounded USB commissioning log, with hardware identity check and secret filtering.

Run with PlatformIO's Python (pyserial installed). Does not write any files.
"""
import argparse
import re
import time

import serial
from serial.tools import list_ports

parser = argparse.ArgumentParser()
parser.add_argument("--port", required=True)
parser.add_argument("--serial", required=True, help="Expected USB serial number")
parser.add_argument("--seconds", type=int, default=40, choices=range(1, 61), metavar="1..60")
parser.add_argument("--reset", action="store_true", help="Reset the checked USB-JTAG board")
parser.add_argument("--wait", action="store_true", help="Wait for/reconnect the same USB board within the time limit")
args = parser.parse_args()
deadline = time.monotonic() + args.seconds
reset_pending = args.reset
done = False
print("Monitoring selected station (filtered logs only)...", flush=True)
while time.monotonic() < deadline and not done:
    device = next((p for p in list_ports.comports() if p.device == args.port), None)
    if device and ((device.vid, device.pid) != (0x303A, 0x1001) or (device.serial_number or "").lower() != args.serial.lower()):
        parser.error("USB identity mismatch; no reset performed")
    if not device:
        if not args.wait:
            parser.error("Device not present; no reset performed")
        time.sleep(0.1)
        continue
    port = serial.Serial()
    port.port = args.port
    port.baudrate = 115200
    port.timeout = 0.25
    port.dtr = False
    port.rts = False
    try:
        port.open()
        if reset_pending:
            # ESP USB-Serial/JTAG hard-reset sequence, not GPIO0 download mode.
            port.rts = True
            time.sleep(0.2)
            port.rts = False
            time.sleep(0.2)
            reset_pending = False
        while time.monotonic() < deadline:
            line = port.readline().decode("utf-8", errors="replace").strip()
            line = re.sub(r"\x1b\[[0-9;]*m", "", line)
            if any(marker in line for marker in ("weather:", "ESP-ROM:", "rst:", "waiting for download", "assert failed", "Guru Meditation", "abort()", "Backtrace", "ESP_ERROR_CHECK")):
                print(line, flush=True)
                if "weather: Deep sleep" in line:
                    done = True
                    break
    except serial.SerialException:
        print("USB serial disconnected/unavailable; reset or deep sleep can disconnect native USB.", flush=True)
        if not args.wait:
            break
        time.sleep(0.1)
    finally:
        port.close()
