@echo off
setlocal EnableExtensions

set "LLAMA_DIR=C:\Users\racec\AppData\Local\Microsoft\WinGet\Packages\ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe"
set "MODEL=C:\Dev\Enthusia\.models\hf\hub\models--lmstudio-community--Qwen3.5-35B-A3B-GGUF\snapshots\529ae8d8705097e646043ff81181c6564b6a8449\Qwen3.5-35B-A3B-Q4_K_M.gguf"

if not exist "%MODEL%" (
  echo ERROR: baseline model is missing:
  echo %MODEL%
  exit /b 2
)

for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8091" ^| findstr "LISTENING"') do (
  echo Stopping stale listener on port 8091 ^(PID %%P^)...
  taskkill /PID %%P /F >nul 2>&1
)

cd /d "%LLAMA_DIR%"
echo Starting Qwen3.5-35B-A3B baseline on http://127.0.0.1:8091
echo Threads=12, context=8192, GPU layers=12, slots=1, reasoning=auto
llama-server.exe -m "%MODEL%" -ngl 12 -t 12 -tb 12 -c 8192 -np 1 --reasoning auto --host 127.0.0.1 --port 8091 --metrics
