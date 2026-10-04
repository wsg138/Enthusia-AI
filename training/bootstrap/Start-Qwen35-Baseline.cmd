@echo off
setlocal
set "LLAMA_DIR=C:\Users\racec\AppData\Local\Microsoft\WinGet\Packages\ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe"
set "HF_HOME=C:\Dev\Enthusia\.models\hf"

cd /d "%LLAMA_DIR%"
echo Starting Qwen3.5-35B-A3B baseline on http://127.0.0.1:8091
echo Threads=12, context=8192, GPU layers=12, reasoning=off, parallel=1
llama-server.exe -hf lmstudio-community/Qwen3.5-35B-A3B-GGUF:Q4_K_M -ngl 12 -t 12 -tb 12 -c 8192 -np 1 --reasoning off --host 127.0.0.1 --port 8091 --metrics
