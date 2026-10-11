@echo off
setlocal EnableExtensions
cd /d C:\Dev\Enthusia\Enthusia-AI

if /I not "%ENTHUSIA_ALLOW_30%"=="YES" (
  echo ERROR: this legacy wrapper runs 30 examples.
  echo The current owner gate must use Run-Qwen35-Owner-Review-10.cmd.
  echo Use the explicitly named Run-Qwen35-Baseline-30.cmd only after owner approval.
  exit /b 9
)

echo Waiting for local baseline server...
set /a COUNT=0
:wait_health
curl -fsS http://127.0.0.1:8091/health >nul 2>&1
if not errorlevel 1 goto server_ready
set /a COUNT+=1
if %COUNT% GEQ 90 (
  echo ERROR: local baseline server did not become healthy within 90 seconds.
  exit /b 2
)
ping 127.0.0.1 -n 2 >nul
goto wait_health

:server_ready
echo Server is healthy.
if exist training\bootstrap\artifacts\baseline-generation-results.jsonl del /f /q training\bootstrap\artifacts\baseline-generation-results.jsonl
if exist training\bootstrap\artifacts\baseline-generation-summary.json del /f /q training\bootstrap\artifacts\baseline-generation-summary.json

python -u training\bootstrap\run_generation_benchmark.py ^
  --jobs training\bootstrap\artifacts\generation-jobs.jsonl.gz ^
  --output training\bootstrap\artifacts\baseline-generation-results.jsonl ^
  --summary training\bootstrap\artifacts\baseline-generation-summary.json ^
  --endpoint http://127.0.0.1:8091 ^
  --limit 30 ^
  --timeout 300 ^
  --max-tokens 300
exit /b %errorlevel%
