# @enthusia/inference-adapter

Swappable local inference adapter (W03).

Spec: `MASTER-SPECIFICATION.md` §§9.2, 10, 36 · `WORKER-EXECUTION-PLAN.md` §6.

## What this owns

- OpenAI-compatible chat completions HTTP client (`/v1/chat/completions`)
- Model capabilities descriptor (context length, streaming support, …)
- Token/context limit enforcement (pre-flight, estimate-based)
- Health checks (`/v1/models` → model loaded, model name/version)
- Retry with exponential backoff + jitter, bounded per-attempt timeouts
- SSE streaming support
- Metrics: tokens in/out, latency, queue depth, active requests, retries

## Adapter boundary

This package is the **only** place that talks HTTP to the inference runtime,
and it only speaks **OpenAI-compatible routes** (`/v1/chat/completions`,
`/v1/models`). No llama.cpp-specific or vendor-specific routes are used
anywhere. To swap runtimes (llama.cpp → vLLM → anything OpenAI-compatible),
change `ENTHUSIA_INFERENCE_BASE_URL` — no application code changes.

## Configuration (env)

| Variable | Default | Notes |
|---|---|---|
| `ENTHUSIA_INFERENCE_BASE_URL` | `http://localhost:8080` | OpenAI-compatible endpoint |
| `ENTHUSIA_INFERENCE_MODEL` | `""` (server default) | Sent as `model` when non-empty |
| `ENTHUSIA_INFERENCE_THINKING_MODE` | `default` | Opt-in `disabled` sends Ollama-compatible `think:false` for Qwen3 test inference; other runtimes retain the standard request by default |
| `ENTHUSIA_INFERENCE_API_KEY` | unset in dev/test | Required in production; sent as `Bearer`, **never logged** |
| `ENTHUSIA_INFERENCE_TIMEOUT_MS` | `120000` | Bounded per-attempt generation timeout |
| `ENTHUSIA_INFERENCE_MAX_RETRIES` | `3` | Retries on 5xx / 429 / network errors |
| `ENTHUSIA_INFERENCE_RETRY_BASE_DELAY_MS` | `500` | Exponential backoff base |
| `ENTHUSIA_INFERENCE_RETRY_MAX_DELAY_MS` | `10000` | Backoff cap |
| `ENTHUSIA_INFERENCE_MAX_CONTEXT_TOKENS` | `32768` | Context window for limit enforcement (§10.4) |
| `ENTHUSIA_INFERENCE_MAX_OUTPUT_TOKENS` | `4096` | Per-request output budget |
| `ENTHUSIA_INFERENCE_HEALTH_TIMEOUT_MS` | `5000` | Health probe timeout |

`loadInferenceConfig()` extends the shared `@enthusia/config` schema;
`redactedInferenceConfig()` renders a log-safe view (the API key is shown as
`<set>`/`<unset>`, never its value).

## Usage

```ts
import {
  InferenceClient,
  checkInferenceHealth,
  loadInferenceConfig,
} from '@enthusia/inference-adapter';

const client = new InferenceClient({ config: loadInferenceConfig() });

// Non-streaming
const result = await client.complete({
  messages: [{ role: 'user', content: 'What is the server IP?' }],
  maxTokens: 256,
  temperature: 0.2,
});
console.log(result.content, result.usage, result.attempts);

// Streaming (SSE)
await client.completeStream(
  { messages: [{ role: 'user', content: 'Hello' }] },
  (delta) => process.stdout.write(delta.content),
);

// Health → feed into /health/ready
const report = await checkInferenceHealth(client);
// { status: 'ok'|'degraded'|'down', modelLoaded, modelName, modelVersion, latencyMs, metrics }
```

## Behavior notes

- **Timeouts**: every attempt is bounded by `ENTHUSIA_INFERENCE_TIMEOUT_MS`
  (default 120s). A timeout throws `ToolTimeoutError` (504) and is **not**
  retried by this client — the caller decides.
- **Retries**: HTTP 5xx, 429, and network errors are retried up to
  `ENTHUSIA_INFERENCE_MAX_RETRIES` times with exponential backoff + jitter.
  Other 4xx, validation failures, and caller aborts are never retried.
- **Context limits**: `complete`/`completeStream` estimate prompt tokens
  (heuristic ~4 chars/token; inject your own estimator) and throw
  `ValidationError` when the prompt exceeds
  `maxContextTokens − maxOutputTokens`. Authoritative counts come from the
  server's `usage` field after generation.
- **Concurrency**: in-flight requests are bounded by the shared
  `ENTHUSIA_INFERENCE_CONCURRENCY`; waiters are visible as `queueDepth` in
  `client.getMetrics()`.
- **Errors** are the shared contract types (`ExternalServiceError`,
  `ToolTimeoutError`, `ValidationError`) with trace IDs; upstream bodies are
  truncated to 500 chars in `detail` and never include the API key.

## Tests

- `test/client.test.ts` — mock HTTP server: completions, retry/backoff,
  retry exhaustion, no-retry on 4xx, bounded timeout, SSE streaming, auth
  header, model selection, queue depth.
- `test/config.test.ts`, `test/capabilities.test.ts`, `test/health.test.ts`,
  `test/metrics.test.ts` — unit coverage of the supporting modules.
- `test/integration.smoke.test.ts` — real-model smoke test, skipped unless
  `ENTHUSIA_INFERENCE_SMOKE_URL` is set (never downloads models, never runs
  in CI by default).

### Existing PC Ollama local testing (no Discord deployment)

When a local Ollama service runs on `127.0.0.1:11434`, the adapter can use its
OpenAI-compatible endpoints (the adapter **appends** `/v1`; do not add it to the base URL):

```ini
ENTHUSIA_INFERENCE_BASE_URL=http://127.0.0.1:11434
ENTHUSIA_INFERENCE_MODEL=qwen3:8b
ENTHUSIA_INFERENCE_THINKING_MODE=disabled
```

The last option is intentionally **opt-in**: it sends the Ollama-specific
`think:false` request field to prevent Qwen3's internal thinking tokens from
consuming a short output budget without returning player-facing text. It is
not an OpenAI-standard field; use `default` for llama.cpp/other runtimes.
This setting changes local inference only. It does not configure or start a
Discord bot, grant server evidence tools, authorize ticket actions or permit
fine-tuning or production deployment.
