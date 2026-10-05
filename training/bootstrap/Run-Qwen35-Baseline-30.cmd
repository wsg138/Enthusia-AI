@echo off
setlocal EnableExtensions
set "REPO=C:\Dev\Enthusia\Enthusia-AI"

cd /d "%REPO%"
echo Updating training bootstrap...
git pull --ff-only origin training/bootstrap-data-prep
if errorlevel 1 goto fail

echo Clearing any stale listener on port 8091 before startup...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8091" ^| findstr "LISTENING"') do (
  echo Stopping stale baseline server ^(PID %%P^)...
  taskkill /PID %%P /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo Starting baseline server in a separate minimized window...
start "Enthusia Qwen Baseline" /min cmd /c call "%REPO%\training\bootstrap\Start-Qwen35-Baseline.cmd"

call "%REPO%\training\bootstrap\Run-Baseline-Generation-Benchmark.cmd"
set "BENCH_RC=%ERRORLEVEL%"

for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8091" ^| findstr "LISTENING"') do (
  echo Stopping baseline server ^(PID %%P^)...
  taskkill /PID %%P /F >nul 2>&1
)

if not "%BENCH_RC%"=="0" (
  echo Baseline benchmark failed with exit code %BENCH_RC%.
  exit /b %BENCH_RC%
)

echo.
echo Baseline benchmark complete.
echo Summary:
type training\bootstrap\artifacts\baseline-generation-summary.json
exit /b 0

:fail
echo Failed before benchmark started.
exit /b 1
