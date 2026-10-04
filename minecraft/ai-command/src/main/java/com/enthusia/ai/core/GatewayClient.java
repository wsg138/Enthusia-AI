package com.enthusia.ai.core;

import java.io.IOException;
import java.net.ConnectException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * Minimal HTTP client for the AI Gateway (W02).
 *
 * <p>Endpoints used:
 * <ul>
 *   <li>{@code POST /v1/chat} — {@code ChatRequest} in, {@code AgentResponse} out</li>
 *   <li>{@code GET /health/live} and {@code GET /health/ready} — status probing</li>
 * </ul>
 *
 * <p>Authentication: {@code Authorization: Bearer <apiKey>} when an API key is
 * configured (the gateway requires it only when keys are configured server-side).
 *
 * <p>Blocking by design — callers must run {@link #chat} off the server main
 * thread (the command executor dispatches it asynchronously).
 */
public class GatewayClient {

    private final String baseUrl;
    private final String apiKey;
    private final Duration timeout;
    private final HttpClient http;

    public GatewayClient(String baseUrl, String apiKey, Duration timeout) {
        this(baseUrl, apiKey, timeout, HttpClient.newBuilder()
                .connectTimeout(timeout)
                .followRedirects(HttpClient.Redirect.NEVER)
                .build());
    }

    /** Constructor with injectable HttpClient (tests). */
    GatewayClient(String baseUrl, String apiKey, Duration timeout, HttpClient http) {
        this.baseUrl = Objects.requireNonNull(baseUrl, "baseUrl").replaceAll("/+$", "");
        this.apiKey = apiKey == null ? "" : apiKey;
        this.timeout = Objects.requireNonNull(timeout, "timeout");
        this.http = Objects.requireNonNull(http, "http");
    }

    /**
     * Send a chat request and parse the {@code AgentResponse}.
     *
     * @param requestJson the ChatRequest document built by {@link ChatRequestBuilder}
     * @return the parsed agent response
     * @throws GatewayException on any transport, auth, rate-limit, or protocol failure
     */
    public AgentResponse chat(String requestJson) throws GatewayException {
        HttpRequest request = baseRequest("/v1/chat")
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(requestJson))
                .build();
        HttpResponse<String> response = send(request);
        int status = response.statusCode();
        if (status == 200) {
            try {
                return AgentResponse.parse(response.body());
            } catch (IllegalArgumentException ex) {
                throw new GatewayException.ProtocolException(
                        "invalid AgentResponse body: " + ex.getMessage());
            }
        }
        throw mapErrorStatus(status, response);
    }

    /** Probe gateway health. Used by {@code /ai staff status}. */
    public HealthStatus health() throws GatewayException {
        Map<String, Object> live = getJson("/health/live", "liveness probe");
        Map<String, Object> ready = getJson("/health/ready", "readiness probe");
        List<Dependency> deps = new ArrayList<>();
        Object rawDeps = ready.get("dependencies");
        if (rawDeps instanceof List<?> list) {
            for (Object item : list) {
                if (item instanceof Map<?, ?>) {
                    Map<String, Object> dep = Json.asObject(item);
                    deps.add(new Dependency(
                            Json.optString(dep, "name", "?"),
                            Json.optString(dep, "status", "?"),
                            Json.optString(dep, "detail", null)));
                }
            }
        }
        return new HealthStatus(
                Json.optString(live, "status", "?"),
                Json.optString(live, "version", "?"),
                Json.optString(ready, "status", "?"),
                deps);
    }

    /** Liveness/readiness snapshot for the staff status command. */
    public record HealthStatus(String liveStatus, String version, String readyStatus,
            List<Dependency> dependencies) {
    }

    /** A single downstream dependency from the readiness probe. */
    public record Dependency(String name, String status, String detail) {
    }

    // --- internals ---

    private Map<String, Object> getJson(String path, String what) throws GatewayException {
        HttpRequest request = baseRequest(path).GET().build();
        HttpResponse<String> response = send(request);
        if (response.statusCode() != 200) {
            throw mapErrorStatus(response.statusCode(), response);
        }
        try {
            return Json.asObject(Json.parse(response.body()));
        } catch (Json.JsonException | IllegalArgumentException ex) {
            throw new GatewayException.ProtocolException(
                    what + " returned invalid JSON: " + ex.getMessage());
        }
    }

    private HttpRequest.Builder baseRequest(String path) {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + path))
                .timeout(timeout)
                .header("Accept", "application/json")
                .header("X-Request-Id", UUID.randomUUID().toString());
        if (!apiKey.isBlank()) {
            builder.header("Authorization", "Bearer " + apiKey);
        }
        return builder;
    }

    private HttpResponse<String> send(HttpRequest request) throws GatewayException {
        try {
            return http.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (HttpTimeoutException ex) {
            throw new GatewayException.TimeoutException(timeout.toMillis());
        } catch (ConnectException ex) {
            throw new GatewayException.UnavailableException(
                    "connection refused at " + baseUrl, ex);
        } catch (IOException ex) {
            throw new GatewayException.UnavailableException(
                    "I/O error talking to " + baseUrl + ": " + ex.getMessage(), ex);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new GatewayException.UnavailableException("interrupted while waiting for gateway", ex);
        }
    }

    /**
     * Map a non-2xx status to a typed exception, using the gateway's
     * {@code {error: {code, statusCode, message, traceId}}} envelope when present.
     */
    private GatewayException mapErrorStatus(int status, HttpResponse<String> response) {
        String gatewayMessage = extractGatewayMessage(response.body());
        String detail = "HTTP " + status + " from gateway"
                + (gatewayMessage != null ? ": " + gatewayMessage : "");
        return switch (status) {
            case 429 -> new GatewayException.RateLimitedException(extractRetryAfter(response));
            case 401 -> new GatewayException.AuthenticationException();
            case 403 -> new GatewayException.AuthorizationException(
                    gatewayMessage != null ? gatewayMessage : "forbidden");
            case 400, 413, 422 -> new GatewayException.BadRequestException(
                    gatewayMessage != null ? gatewayMessage : "bad request");
            default -> new GatewayException.UnavailableException(detail);
        };
    }

    private static String extractGatewayMessage(String body) {
        if (body == null || body.isBlank()) {
            return null;
        }
        try {
            Map<String, Object> root = Json.asObject(Json.parse(body));
            Map<String, Object> error = Json.optObject(root, "error");
            if (error != null) {
                String message = Json.optString(error, "message", null);
                String code = Json.optString(error, "code", null);
                if (message != null) {
                    return code != null ? code + ": " + message : message;
                }
            }
        } catch (Json.JsonException | IllegalArgumentException ignored) {
            // Not a gateway error envelope; fall through.
        }
        return null;
    }

    private static long extractRetryAfter(HttpResponse<String> response) {
        return response.headers().firstValue("retry-after")
                .map(raw -> {
                    try {
                        return Math.max(1L, Long.parseLong(raw.trim()));
                    } catch (NumberFormatException ex) {
                        return 30L;
                    }
                })
                .orElse(30L);
    }
}
