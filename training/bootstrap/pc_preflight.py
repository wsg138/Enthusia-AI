#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ctypes
import json
import os
import platform
import shutil
import subprocess  # nosec B404 -- only resolved local executables are invoked with argv.
import sys
from pathlib import Path


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


def _resolved_executable(name: str) -> Path | None:
    discovered = shutil.which(name)
    return Path(discovered).resolve() if discovered else None


def run_command(executable: Path, arguments: list[str]) -> dict[str, object]:
    try:
        completed = subprocess.run(  # nosec B603 -- resolved executable + argv, never shell interpolation.
            [str(executable), *arguments],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    return {
        "ok": completed.returncode == 0,
        "returncode": completed.returncode,
        "stdout": completed.stdout.strip(),
        "stderr": completed.stderr.strip(),
    }


def _windows_memory_bytes() -> int | None:
    windll = getattr(ctypes, "windll", None)
    if windll is None:
        return None
    status = MEMORYSTATUSEX()
    status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    try:
        global_memory_status = windll.kernel32.GlobalMemoryStatusEx
        global_memory_status.argtypes = [ctypes.POINTER(MEMORYSTATUSEX)]
        global_memory_status.restype = ctypes.c_int
        if global_memory_status(ctypes.byref(status)):
            return int(status.ullTotalPhys)
    except (AttributeError, OSError, TypeError, ValueError):
        return None
    return None


def _posix_memory_bytes() -> int | None:
    try:
        page = os.sysconf("SC_PAGE_SIZE")
        pages = os.sysconf("SC_PHYS_PAGES")
        return int(page * pages)
    except (OSError, ValueError):
        return None


def memory_bytes() -> int | None:
    if platform.system() == "Windows":
        return _windows_memory_bytes()
    return _posix_memory_bytes()


def torch_report() -> dict[str, object]:
    try:
        import torch  # type: ignore
    except ImportError as exc:
        return {"installed": False, "error": f"{type(exc).__name__}: {exc}"}

    try:
        cuda_available = bool(torch.cuda.is_available())
        return {
            "version": torch.__version__,
            "cuda_available": cuda_available,
            "cuda_version": torch.version.cuda,
            "device_count": int(torch.cuda.device_count()),
            "devices": [
                {
                    "index": index,
                    "name": torch.cuda.get_device_name(index),
                    "total_memory_bytes": torch.cuda.get_device_properties(index).total_memory,
                }
                for index in range(torch.cuda.device_count())
            ] if cuda_available else [],
        }
    except (RuntimeError, OSError) as exc:
        return {"installed": True, "error": f"{type(exc).__name__}: {exc}"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)

    disk_root = Path.cwd().anchor or "/"
    du = shutil.disk_usage(disk_root)

    python_executable = Path(sys.executable).resolve()
    nvidia_executable = _resolved_executable("nvidia-smi")

    report = {
        "schema_version": 1,
        "platform": platform.platform(),
        "python": sys.version,
        "python_executable": sys.executable,
        "python_m_pip": run_command(
            python_executable,
            ["-m", "pip", "--version"],
        ),
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
        "nvidia_smi": run_command(
            nvidia_executable,
            [
                "--query-gpu=name,memory.total,memory.free,driver_version",
                "--format=csv,noheader,nounits",
            ],
        ) if nvidia_executable else {"ok": False, "error": "nvidia-smi not found"},
        "torch": torch_report(),
        "recommendation": {
            "paid_gpu_started": False,
            "next": "Use this report to choose local smoke-training limits before any rented GPU is started."
        },
    }

    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
