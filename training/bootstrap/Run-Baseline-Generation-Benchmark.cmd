@echo off
setlocal
cd /d C:\Dev\Enthusia\Enthusia-AI
python training\bootstrap\run_generation_benchmark.py ^
  --jobs training\bootstrap\artifacts\generation-jobs.jsonl.gz ^
  --output training\bootstrap\artifacts\baseline-generation-results.jsonl ^
  --summary training\bootstrap\artifacts\baseline-generation-summary.json ^
  --endpoint http://127.0.0.1:8091 ^
  --limit 30 ^
  --timeout 300 ^
  --max-tokens 450
