@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "REPO=C:\Dev\Enthusia\Enthusia-AI"
set "EXPECTED_BRANCH=training/bootstrap-data-prep"
set "ENDPOINT=http://127.0.0.1:8091"
set "RESULTS=training\bootstrap\artifacts\owner-review-10-results.jsonl"
set "SUMMARY=training\bootstrap\artifacts\owner-review-10-summary.json"
set "REVIEW=training\bootstrap\artifacts\owner-review-10.md"
set "SERVER_PID="

cd /d "%REPO%" || goto fail

for /f "delims=" %%B in ('git branch --show-current') do set "CURRENT_BRANCH=%%B"
if /I not "%CURRENT_BRANCH%"=="%EXPECTED_BRANCH%" (
  echo ERROR: this exact-10 gate must run from %EXPECTED_BRANCH%.
  echo Current branch: %CURRENT_BRANCH%
  exit /b 2
)

for /f "delims=" %%S in ('git status --porcelain --untracked-files=no') do (
  echo ERROR: tracked working-tree changes exist. Refusing a non-reproducible owner gate.
  git status --short
  exit /b 3
)

echo Refreshing remote gate head...
git fetch origin "%EXPECTED_BRANCH%" || goto fail
for /f "delims=" %%H in ('git rev-parse HEAD') do set "LOCAL_HEAD=%%H"
for /f "delims=" %%H in ('git rev-parse "origin/%EXPECTED_BRANCH%"') do set "REMOTE_HEAD=%%H"
if /I not "%LOCAL_HEAD%"=="%REMOTE_HEAD%" (
  echo ERROR: local gate head is not the current remote head.
  echo Local : %LOCAL_HEAD%
  echo Remote: %REMOTE_HEAD%
  echo Fast-forward the branch before running the owner gate.
  exit /b 4
)

if not exist training\bootstrap\artifacts\generation-jobs.jsonl.gz (
  echo ERROR: generation-jobs.jsonl.gz is missing. Rebuild the corrected source corpus first.
  exit /b 5
)

for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8091" ^| findstr "LISTENING"') do (
  echo ERROR: port 8091 is already occupied by PID %%P.
  echo Refusing to kill or reuse an unidentified listener.
  exit /b 6
)

if exist "%RESULTS%" del /f /q "%RESULTS%"
if exist "%SUMMARY%" del /f /q "%SUMMARY%"
if exist "%REVIEW%" del /f /q "%REVIEW%"

echo Starting Qwen3.5-35B-A3B owner-gate server...
start "Enthusia Qwen Owner Gate" /min cmd /c call "%REPO%\training\bootstrap\Start-Qwen35-Baseline.cmd"

set /a COUNT=0
:wait_health
curl -fsS %ENDPOINT%/health >nul 2>&1
if not errorlevel 1 goto server_ready
set /a COUNT+=1
if %COUNT% GEQ 90 (
  echo ERROR: local Qwen server did not become healthy.
  goto cleanup_fail
)
ping 127.0.0.1 -n 2 >nul
goto wait_health

:server_ready
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8091" ^| findstr "LISTENING"') do set "SERVER_PID=%%P"
if not defined SERVER_PID (
  echo ERROR: healthy endpoint found but listener PID could not be identified.
  goto cleanup_fail
)
echo Qwen server healthy at gate head %LOCAL_HEAD% ^(PID %SERVER_PID%^).
echo Running exactly 10 attempts...

python -u training\bootstrap\run_generation_benchmark.py ^
  --jobs training\bootstrap\artifacts\generation-jobs.jsonl.gz ^
  --output "%RESULTS%" ^
  --summary "%SUMMARY%" ^
  --endpoint %ENDPOINT% ^
  --limit 10 ^
  --timeout 300 ^
  --max-tokens 550
if errorlevel 1 goto cleanup_fail

python training\bootstrap\render_owner_review.py ^
  --results "%RESULTS%" ^
  --output "%REVIEW%"
if errorlevel 1 goto cleanup_fail

echo.
echo Exact-10 owner-review smoke complete.
echo Gate head: %LOCAL_HEAD%
echo Review artifact: %REVIEW%
echo STOP HERE. Do not run 30 examples or W16 conversion before owner review.
call :cleanup
exit /b 0

:cleanup_fail
set "RUN_RC=1"
call :cleanup
exit /b %RUN_RC%

:cleanup
if defined SERVER_PID (
  echo Stopping owner-gate Qwen server PID %SERVER_PID%...
  taskkill /PID %SERVER_PID% /F >nul 2>&1
)
exit /b 0

:fail
echo Exact-10 owner gate failed before model startup.
exit /b 1
