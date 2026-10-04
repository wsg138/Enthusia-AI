package com.enthusia.ai.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.net.Authenticator;
import java.net.CookieHandler;
import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Flow;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSession;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * GatewayClient tests with a fake {@link HttpClient} transport — no real
 * TCP is used (the sandbox blocks even localhost sockets for Java).
 */
class GatewayClientTest {

    /** Canned transport: maps request paths to responses, records requests. */
    static class FakeHttpClient extends HttpClient {
        record Route(int status, String body, Map<String, String> headers) {
        }

        private final Map<String, Route> routes = new HashMap<>();
        String lastAuthorization;
        String lastBody;

        void route(String path, int status, String body) {
            route(path, status, body, Map.of());
        }

        void route(String path, int status, String body, Map<String, String> headers) {
            routes.put(path, new Route(status, body, headers));
        }

        @Override
        @SuppressWarnings("unchecked")
        public <T> HttpResponse<T> send(HttpRequest request,
                HttpResponse.BodyHandler<T> responseBodyHandler) throws IOException {
            lastAuthorization = request.headers().firstValue("Authorization").orElse(null);
            lastBody = readBody(request);
            Route route = routes.getOrDefault(request.uri().getPath(),
                    new Route(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"statusCode\":404,"
                            + "\"message\":\"no route\",\"traceId\":\"t\"}}", Map.of()));
            Map<String, List<String>> headerMap = new HashMap<>();
            route.headers().forEach((k, v) -> headerMap.put(k, List.of(v)));
            // The client always uses BodyHandlers.ofString(); the cast is safe here.
            T body = (T) route.body();
            return new FakeResponse<>(route.status(), body, request, headerMap);
        }

        private static String readBody(HttpRequest request) {
            return request.bodyPublisher().map(publisher -> {
                CompletableFuture<String> future = new CompletableFuture<>();
                publisher.subscribe(new Flow.Subscriber<>() {
                    final StringBuilder buf = new StringBuilder();

                    @Override
                    public void onSubscribe(Flow.Subscription s) {
                        s.request(Long.MAX_VALUE);
                    }

                    @Override
                    public void onNext(ByteBuffer item) {
                        byte[] bytes = new byte[item.remaining()];
                        item.get(bytes);
                        buf.append(new String(bytes, StandardCharsets.UTF_8));
                    }

                    @Override
                    public void onError(Throwable t) {
                        future.completeExceptionally(t);
                    }

                    @Override
                    public void onComplete() {
                        future.complete(buf.toString());
                    }
                });
                return future.join();
            }).orElse("");
        }

        @Override
        public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest request,
                HttpResponse.BodyHandler<T> responseBodyHandler) {
            throw new UnsupportedOperationException();
        }

        @Override
        public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest request,
                HttpResponse.BodyHandler<T> responseBodyHandler,
                HttpResponse.PushPromiseHandler<T> pushPromiseHandler) {
            throw new UnsupportedOperationException();
        }

        @Override
        public Optional<CookieHandler> cookieHandler() {
            return Optional.empty();
        }

        @Override
        public Optional<Duration> connectTimeout() {
            return Optional.empty();
        }

        @Override
        public Redirect followRedirects() {
            return Redirect.NEVER;
        }

        @Override
        public Optional<ProxySelector> proxy() {
            return Optional.empty();
        }

        @Override
        public SSLContext sslContext() {
            throw new UnsupportedOperationException();
        }

        @Override
        public SSLParameters sslParameters() {
            throw new UnsupportedOperationException();
        }

        @Override
        public Optional<Authenticator> authenticator() {
            return Optional.empty();
        }

        @Override
        public Version version() {
            return Version.HTTP_1_1;
        }

        @Override
        public Optional<java.util.concurrent.Executor> executor() {
            return Optional.empty();
        }
    }

    static final class FakeResponse<T> implements HttpResponse<T> {
        private final int status;
        private final T body;
        private final HttpRequest request;
        private final HttpHeaders headers;

        FakeResponse(int status, T body, HttpRequest request, Map<String, List<String>> headers) {
            this.status = status;
            this.body = body;
            this.request = request;
            this.headers = HttpHeaders.of(headers, (k, v) -> true);
        }

        @Override
        public int statusCode() {
            return status;
        }

        @Override
        public HttpRequest request() {
            return request;
        }

        @Override
        public Optional<HttpResponse<T>> previousResponse() {
            return Optional.empty();
        }

        @Override
        public HttpHeaders headers() {
            return headers;
        }

        @Override
        public T body() {
            return body;
        }

        @Override
        public Optional<SSLSession> sslSession() {
            return Optional.empty();
        }

        @Override
        public URI uri() {
            return request.uri();
        }

        @Override
        public HttpClient.Version version() {
            return HttpClient.Version.HTTP_1_1;
        }
    }

    private FakeHttpClient transport;

    @BeforeEach
    void setUp() {
        transport = new FakeHttpClient();
    }

    private GatewayClient client() {
        return client("");
    }

    private GatewayClient client(String apiKey) {
        return new GatewayClient("http://gateway.test", apiKey, Duration.ofSeconds(5), transport);
    }

    private static String agentResponseJson(String text) {
        Map<String, Object> doc = new java.util.LinkedHashMap<>();
        doc.put("text", text);
        doc.put("actions", List.of());
        doc.put("sources", List.of());
        doc.put("memoryUpdates", List.of());
        doc.put("escalation", null);
        doc.put("traceId", "trace-1");
        return Json.stringify(doc);
    }

    @Test
    void chatParsesAgentResponse() throws Exception {
        transport.route("/v1/chat", 200, agentResponseJson("hello there"));
        AgentResponse resp = client().chat("{\"surface\":\"minecraft\"}");
        assertEquals("hello there", resp.getText());
        assertEquals("trace-1", resp.getTraceId());
        assertTrue(transport.lastBody.contains("minecraft"));
    }

    @Test
    void chatSendsBearerTokenWhenConfigured() throws Exception {
        transport.route("/v1/chat", 200, agentResponseJson("hi"));
        client("secret-key").chat("{}");
        assertEquals("Bearer secret-key", transport.lastAuthorization);
    }

    @Test
    void chatOmitsAuthHeaderWhenNoKey() throws Exception {
        transport.route("/v1/chat", 200, agentResponseJson("hi"));
        client().chat("{}");
        assertTrue(transport.lastAuthorization == null, "no Authorization header expected");
    }

    @Test
    void invalidResponseBodyIsProtocolError() {
        transport.route("/v1/chat", 200, "not json at all");
        assertThrows(GatewayException.ProtocolException.class, () -> client().chat("{}"));
    }

    @Test
    void rateLimitedUsesRetryAfterHeader() {
        transport.route("/v1/chat", 429,
                "{\"error\":{\"code\":\"RATE_LIMITED\",\"statusCode\":429,"
                        + "\"message\":\"slow down\",\"traceId\":\"t\"}}",
                Map.of("retry-after", "45"));
        GatewayException.RateLimitedException ex = assertThrows(
                GatewayException.RateLimitedException.class, () -> client().chat("{}"));
        assertEquals(45, ex.getRetryAfterSeconds());
        assertTrue(ex.getPlayerMessage().contains("45s"));
    }

    @Test
    void rateLimitedDefaultsWithoutHeader() {
        transport.route("/v1/chat", 429,
                "{\"error\":{\"code\":\"RATE_LIMITED\",\"statusCode\":429,"
                        + "\"message\":\"slow down\",\"traceId\":\"t\"}}");
        GatewayException.RateLimitedException ex = assertThrows(
                GatewayException.RateLimitedException.class, () -> client().chat("{}"));
        assertEquals(30, ex.getRetryAfterSeconds());
    }

    @Test
    void unauthorizedIsAuthenticationError() {
        transport.route("/v1/chat", 401,
                "{\"error\":{\"code\":\"AUTHENTICATION_FAILED\",\"statusCode\":401,"
                        + "\"message\":\"bad key\",\"traceId\":\"t\"}}");
        GatewayException.AuthenticationException ex = assertThrows(
                GatewayException.AuthenticationException.class, () -> client().chat("{}"));
        // Player message must not leak key details.
        assertTrue(ex.getPlayerMessage().contains("misconfigured"));
    }

    @Test
    void forbiddenIsAuthorizationError() {
        transport.route("/v1/chat", 403,
                "{\"error\":{\"code\":\"AUTHORIZATION_ERROR\",\"statusCode\":403,"
                        + "\"message\":\"ceiling too high\",\"traceId\":\"t\"}}");
        assertThrows(GatewayException.AuthorizationException.class, () -> client().chat("{}"));
    }

    @Test
    void badRequestMaps() {
        transport.route("/v1/chat", 400,
                "{\"error\":{\"code\":\"VALIDATION_ERROR\",\"statusCode\":400,"
                        + "\"message\":\"bad\",\"traceId\":\"t\"}}");
        assertThrows(GatewayException.BadRequestException.class, () -> client().chat("{}"));
    }

    @Test
    void serverErrorIsUnavailable() {
        transport.route("/v1/chat", 500, "boom");
        assertThrows(GatewayException.UnavailableException.class, () -> client().chat("{}"));
    }

    @Test
    void transportFailureIsUnavailable() {
        HttpClient failing = new FakeHttpClient() {
            @Override
            public <T> HttpResponse<T> send(HttpRequest request,
                    HttpResponse.BodyHandler<T> responseBodyHandler) throws IOException {
                throw new IOException("connection refused");
            }
        };
        GatewayClient dead = new GatewayClient("http://127.0.0.1:1", "", Duration.ofSeconds(2), failing);
        assertThrows(GatewayException.UnavailableException.class, () -> dead.chat("{}"));
    }

    @Test
    void healthParsesLiveAndReady() throws Exception {
        transport.route("/health/live", 200,
                "{\"status\":\"ok\",\"version\":\"0.1.0\",\"uptimeSeconds\":12}");
        transport.route("/health/ready", 200,
                "{\"status\":\"ok\",\"version\":\"0.1.0\",\"uptimeSeconds\":12,"
                        + "\"dependencies\":[{\"name\":\"agent\",\"status\":\"ok\",\"latencyMs\":3}],"
                        + "\"modelLoaded\":false,\"activeRequests\":0}");
        GatewayClient.HealthStatus status = client().health();
        assertEquals("ok", status.liveStatus());
        assertEquals("0.1.0", status.version());
        assertEquals("ok", status.readyStatus());
        assertEquals(1, status.dependencies().size());
        assertEquals("agent", status.dependencies().get(0).name());
    }
}
