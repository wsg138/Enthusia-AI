#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ctypes
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str]) -> dict:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=20, check=False)
        return {"ok": p.returncode == 0, "returncode": p.returncode, "stdout": p.stdout.strip(), "stderr": p.stderr.strip()}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def memory_bytes() -> int | None:
    try:
        if platform.system() == "Windows":
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]
            status = MEMORYSTATUSEX()
            status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return int(status.ullTotalPhys)
            return None
        page = os.sysconf("SC_PAGE_SIZE")
        pages = os.sysconf("SC_PHYS_PAGES")
        return int(page * pages)
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)

    disk_root = Path.cwd().anchor or "/"
    du = shutil.disk_usage(disk_root)

    report = {
        "schema_version": 1,
        "platform": platform.platform(),
        "python": sys.version,
        "python_executable": sys.executable,
        "python_m_pip": run([sys.executable, "-m", "pip", "--version"]),
        "cpu_count_logical": os.cpu_count(),
        "memory_bytes": memory_bytes(),
        "disk": {
            "root": disk_root,
            "total_bytes": du.total,
            "free_bytes": du.free,
        },
        "executables": {
            name: shutil.which(name)
            for name in ["git", "gh", "git-lfs", "nvidia-smi", "python", "pip"]
        },
        "nvidia_smi": run([
            "nvidia-smi",
            "--query-gpu=name,memory.total,memory.free,driver_version",
            "--format=csv,noheader,nounits",
        ]) if shutil.which("nvidia-smi") else {"ok": False, "error": "nvidia-smi not found"},
        "torch": None,
        "recommendation": {
            "paid_gpu_started": False,
            "next": "Use this report to choose local smoke-training limits before any rented GPU is started."
        },
    }

    try:
        import torch  # type: ignore
        report["torch"] = {
            "version": torch.__version__,
            "cuda_available": bool(torch.cuda.is_available()),
            "cuda_version": torch.version.cuda,
            "device_count": int(torch.cuda.device_count()),
            "devices": [
                {
                    "index": i,
                    "name": torch.cuda.get_device_name(i),
                    "total_memory_bytes": torch.cuda.get_device_properties(i).total_memory,
                }
                for i in range(torch.cuda.device_count())
            ] if torch.cuda.is_available() else [],
        }
    except Exception as exc:
        report["torch"] = {"installed": False, "error": f"{type(exc).__name__}: {exc}"}

    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
