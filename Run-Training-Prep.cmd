@echo off
setlocal EnableExtensions

set "REPO=C:\Dev\Enthusia\Enthusia-AI"
set "CACHE=C:\Dev\Enthusia\.temporary\Enthusia-AI-SourceCache"
set "BRANCH=training/bootstrap-data-prep"

echo ============================================================
echo Enthusia AI - Training Data Prep
echo ============================================================
echo.

if not exist "%REPO%\.git" (
  echo Repository is missing. Cloning %BRANCH%...
  if not exist "C:\Dev\Enthusia" mkdir "C:\Dev\Enthusia"
  cd /d "C:\Dev\Enthusia"
  gh repo clone wsg138/Enthusia-AI Enthusia-AI -- --branch %BRANCH% --single-branch
  if errorlevel 1 goto :fail
)

cd /d "%REPO%"
if errorlevel 1 goto :fail

echo [1/6] Updating training bootstrap...
git fetch origin %BRANCH%
if errorlevel 1 goto :fail
git switch %BRANCH%
if errorlevel 1 goto :fail
git pull --ff-only origin %BRANCH%
if errorlevel 1 goto :fail

echo.
echo [2/6] Clearing stale source cache...
if exist "%CACHE%" rmdir /s /q "%CACHE%"
mkdir "%CACHE%"
if errorlevel 1 goto :fail

echo.
echo [3/6] Removing stale generated corpus...
if exist "training\bootstrap\artifacts\github-source-corpus.jsonl.gz" del /f /q "training\bootstrap\artifacts\github-source-corpus.jsonl.gz"
if exist "training\bootstrap\artifacts\github-source-summary.json" del /f /q "training\bootstrap\artifacts\github-source-summary.json"

echo.
echo [4/6] Recording PC preflight...
python "training\bootstrap\pc_preflight.py" --output "training\bootstrap\artifacts\pc-preflight.json"
if errorlevel 1 goto :fail

echo.
echo [5/6] Harvesting approved Enthusia source repositories...
echo This clones one repository at a time and deletes the temporary clone.
echo.
python "training\bootstrap\collect_github_sources.py" ^
  --manifest "training\bootstrap\repositories.json" ^
  --workspace "%CACHE%" ^
  --output "training\bootstrap\artifacts\github-source-corpus.jsonl.gz" ^
  --summary "training\bootstrap\artifacts\github-source-summary.json"
if errorlevel 1 goto :fail

echo.
echo [6/6] Results
echo ------------------------------------------------------------
python -c "import json; d=json.load(open(r'training\bootstrap\artifacts\github-source-summary.json', encoding='utf-8')); print(json.dumps(d['counts'], indent=2))"
for %%A in ("training\bootstrap\artifacts\github-source-corpus.jsonl.gz") do echo Corpus bytes: %%~zA
echo.
echo Summary:
echo %REPO%\training\bootstrap\artifacts\github-source-summary.json
echo.
echo Corpus:
echo %REPO%\training\bootstrap\artifacts\github-source-corpus.jsonl.gz
echo.
echo SUCCESS. No model download or paid training was started.
echo.
pause
exit /b 0

:fail
echo.
echo ============================================================
echo FAILED. The step above returned an error.
echo Nothing was deployed and no paid training was started.
echo ============================================================
echo.
pause
exit /b 1
