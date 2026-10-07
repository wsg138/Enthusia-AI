#!/usr/bin/env bash
# =============================================================================
# Enthusia AI — Pterodactyl startup script (TEMPLATE, W21 prepare-only).
#
# Selects the service role from $AI_SERVICE and launches it with the resource
# bounds from the environment (see resource-limits.env and
# deploy/RESOURCE-LIMITS.md). No deployment is performed by committing this
# file; it only runs when the egg is applied to a panel server.
#
# SMP safety (MASTER-SPECIFICATION.md §§35.2–35.4, 63):
#   - CPU threads are explicitly bounded (INFERENCE_THREADS / INDEXER_THREADS).
#   - Optional taskset CPU pinning via CPU_PIN keeps AI off SMP-critical cores.
#   - The AI process is marked expendable: under OOM it must die before SMP,
#     moderation, or the Ticket Bot (OOM_SCORE_ADJ).
# =============================================================================
set -euo pipefail

ROLE="${AI_SERVICE:-agent}"
LOG_LEVEL="${LOG_LEVEL:-info}"
METRICS_PORT="${METRICS_PORT:-9090}"
HEALTH_PORT="${HEALTH_PORT:-8080}"
INFERENCE_BIND_HOST="${INFERENCE_BIND_HOST:-127.0.0.1}"
VERSION="${ENTHUSIA_VERSION:-0.1.0-w21-template}"

log() { printf '%s [startup] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

log "Enthusia AI startup — role=${ROLE} version=${VERSION}"
log "Resource bounds: MODEL_RAM_MAX_GB=${MODEL_RAM_MAX_GB:-28} INFERENCE_THREADS=${INFERENCE_THREADS:-8} INDEXER_THREADS=${INDEXER_THREADS:-2} CPU_PIN=${CPU_PIN:-none} INFERENCE_BIND_HOST=${INFERENCE_BIND_HOST}"

# Mark this process expendable relative to SMP/moderation/Ticket Bot (§35.4).
if [ -n "${OOM_SCORE_ADJ:-}" ]; then
  echo "${OOM_SCORE_ADJ}" > /proc/self/oom_score_adj 2>/dev/null \
    && log "oom_score_adj set to ${OOM_SCORE_ADJ}" \
    || log "WARNING: could not set oom_score_adj (non-privileged container)"
fi

# Optional CPU pinning — keeps inference off SMP-critical cores (§35.2).
PIN_ARGS=()
if [ -n "${CPU_PIN:-}" ]; then
  if command -v taskset >/dev/null 2>&1; then
    PIN_ARGS=(taskset -c "${CPU_PIN}")
    log "CPU pinning enabled: ${CPU_PIN}"
  else
    log "WARNING: CPU_PIN set but taskset is unavailable; continuing unpinned"
  fi
fi

export LOG_LEVEL METRICS_PORT HEALTH_PORT ENTHUSIA_VERSION="${VERSION}"

case "${ROLE}" in
  agent)
    if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
      log "Ticket video evidence media tools available: ffmpeg + ffprobe"
    else
      log "WARNING: ffmpeg/ffprobe unavailable; ticket video evidence will fail closed while image evidence remains available"
    fi
    log "Starting W12 agent service"
    exec "${PIN_ARGS[@]}" node apps/agent-service/dist/main.js
    ;;
  gateway)
    log "Starting W02 AI Gateway"
    exec node apps/ai-gateway/dist/main.js
    ;;
  discord)
    log "FATAL: discord adapter entrypoint not yet implemented (W06)"
    exit 1
    ;;
  inference)
    # llama.cpp server with bounded threads and authenticated HTTP (§9.2):
    #   -t = thread count (INFERENCE_THREADS, explicitly bounded)
    #   --metrics exposes /metrics on the SAME port as /health and /v1/*
    MODEL_PATH="${MODEL_PATH:-/home/container/models/model.gguf}"
    if [ ! -f "${MODEL_PATH}" ]; then
      log "FATAL: model artifact not found at ${MODEL_PATH} (see deploy/MODEL-ARTIFACTS.md)"
      exit 1
    fi
    if [ -z "${ENTHUSIA_INFERENCE_API_KEY:-}" ]; then
      log "FATAL: ENTHUSIA_INFERENCE_API_KEY is required for the inference runtime"
      exit 1
    fi
    export LLAMA_API_KEY="${ENTHUSIA_INFERENCE_API_KEY}"
    log "Starting llama.cpp server: threads=${INFERENCE_THREADS:-8} model=${MODEL_PATH} bind=${INFERENCE_BIND_HOST}"
    exec "${PIN_ARGS[@]}" llama-server \
      -m "${MODEL_PATH}" \
      -t "${INFERENCE_THREADS:-8}" \
      --host "${INFERENCE_BIND_HOST}" \
      --port "${HEALTH_PORT}" \
      --metrics
    ;;
  indexer)
    log "FATAL: indexer entrypoint not yet implemented (W07/W08/W09)"
    exit 1
    ;;
  *)
    log "FATAL: unknown AI_SERVICE='${ROLE}' (expected agent|gateway|discord|inference|indexer)"
    exit 1
    ;;
esac
