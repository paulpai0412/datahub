"""Read-only admission check before this project's builds; never invokes Docker.

Conservative headroom policy, not a diagnosis or a guarantee against host stalls.
Exit 0 = snapshot permits considering a build; exit 1 = blocked/unknown.
"""
import json
import math
import os
from pathlib import Path
import shutil

GIB = 1024**3


def snapshot():
    mem = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        name, _, value = line.partition(":")
        if name in {"MemAvailable", "SwapTotal", "SwapFree"}:
            amount, unit = value.split()
            if unit != "kB":
                raise ValueError("unsupported_memory_unit")
            try:
                mem[name] = int(amount) * 1024
            except ValueError:
                raise ValueError("invalid_memory_counter") from None
    pressures = {}
    for kind, level in (("memory", "full"), ("io", "some")):
        lines = Path(f"/proc/pressure/{kind}").read_text().splitlines()
        values = next(line.split()[1:] for line in lines if line.startswith(level + " "))
        try:
            pressures[kind] = float(dict(value.split("=", 1) for value in values)["avg10"])
        except (ValueError, KeyError):
            raise ValueError("invalid_pressure_counter") from None
    wsl = "microsoft" in Path("/proc/sys/kernel/osrelease").read_text().lower()
    if wsl and not os.path.ismount("/mnt/c"):
        raise ValueError("windows_system_disk_check_unavailable")
    return {
        "available_bytes": mem["MemAvailable"],
        "swap_total_bytes": mem["SwapTotal"],
        "swap_free_bytes": mem["SwapFree"],
        "memory_full_avg10": pressures["memory"],
        "io_some_avg10": pressures["io"],
        "linux_free_bytes": shutil.disk_usage("/").free,
        "windows_free_bytes": shutil.disk_usage("/mnt/c").free if wsl else None,
    }


def blocking_reasons(state):
    required = {"available_bytes", "swap_total_bytes", "swap_free_bytes", "memory_full_avg10", "io_some_avg10", "linux_free_bytes", "windows_free_bytes"}
    if set(state) != required:
        return ["incomplete_resource_snapshot"]
    for name, value in state.items():
        if name == "windows_free_bytes" and value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            return ["invalid_resource_snapshot"]
    if state["swap_free_bytes"] > state["swap_total_bytes"] or max(state["memory_full_avg10"], state["io_some_avg10"]) > 100:
        return ["invalid_resource_snapshot"]
    reasons = []
    # ponytail: fixed conservative admission floors, not a capacity scheduler.
    # Recalibrate only with host/build measurements, not a force bypass.
    if state["available_bytes"] < 6 * GIB:
        reasons.append("available_memory_below_6_GiB")
    if state["swap_total_bytes"] and state["swap_free_bytes"] < state["swap_total_bytes"] / 4:
        reasons.append("swap_free_below_25_percent")
    if state["memory_full_avg10"] >= 1:
        reasons.append("recent_memory_stalls")
    if state["io_some_avg10"] >= 5:
        reasons.append("recent_io_stalls")
    if state["linux_free_bytes"] < 20 * GIB:
        reasons.append("linux_disk_free_below_20_GiB")
    if state["windows_free_bytes"] is not None and state["windows_free_bytes"] < 25 * GIB:
        reasons.append("windows_system_disk_free_below_25_GiB")
    return reasons


def main():
    try:
        state = snapshot()
        reasons = blocking_reasons(state)
    except (OSError, ValueError, KeyError, StopIteration):
        state, reasons = None, ["resource_snapshot_unavailable"]
    print(json.dumps({"status": "BLOCKED" if reasons else "READY_FOR_REVIEW", "reasons": reasons, "snapshot": state}))
    return 1 if reasons else 0


if __name__ == "__main__":
    raise SystemExit(main())
