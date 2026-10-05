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
        # Semgrep cannot prove the executable was resolved locally. Arguments
        # are internal argv values and shell interpolation is disabled.
        completed = subprocess.run(  # nosec B603  # nosemgrep
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


def _cuda_devices(torch) -> list[dict[str, object]]:
    return [
        {
            "index": index,
            "name": torch.cuda.get_device_name(index),
            "total_memory_bytes": torch.cuda.get_device_properties(index).total_memory,
        }
        for index in range(torch.cuda.device_count())
    ]


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
            "devices": _cuda_devices(torch) if cuda_available else [],
        }
    except (RuntimeError, OSError) as exc:
        return {"installed": True, "error": f"{type(exc).__name__}: {exc}"}


def _disk_report() -> dict[str, int | str]:
    disk_root = Path.cwd().anchor or "/"
    usage = shutil.disk_usage(disk_root)
    return {
        "root": disk_root,
        "total_bytes": usage.total,
        "free_bytes": usage.free,
    }


def _executables_report() -> dict[str, str | None]:
    return {
        name: shutil.which(name)
        for name in ["git", "gh", "git-lfs", "nvidia-smi", "python", "pip"]
    }


def _nvidia_report() -> dict[str, object]:
    executable = _resolved_executable("nvidia-smi")
    if executable is None:
        return {"ok": False, "error": "nvidia-smi not found"}
    return run_command(
        executable,
        [
            "--query-gpu=name,memory.total,memory.free,driver_version",
            "--format=csv,noheader,nounits",
        ],
    )


def _build_report() -> dict[str, object]:
    python_executable = Path(sys.executable).resolve()
    return {
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
        "disk": _disk_report(),
        "executables": _executables_report(),
        "nvidia_smi": _nvidia_report(),
        "torch": torch_report(),
        "recommendation": {
            "paid_gpu_started": False,
            "next": (
                "Use this report to choose local smoke-training limits before "
                "any rented GPU is started."
            ),
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(_build_report(), indent=2), encoding="utf-8")
    print(output)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
