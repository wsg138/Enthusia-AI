package com.enthusia.ai.config;

import java.net.URI;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Plugin configuration (pure POJO — no Bukkit dependency).
 *
 * <p>The main plugin class populates this from {@code config.yml}; tests
 * build it from {@link #defaults()} plus overrides.
 */
public final class AiPluginConfig {

    private final String gatewayBaseUrl;
    private final String gatewayApiKey;
    private final Duration gatewayTimeout;
    private final int rateLimitPerMinute;
    private final int maxLineChars;
    private final String serverName;
    private final boolean debug;

    private AiPluginConfig(Builder builder) {
        this.gatewayBaseUrl = builder.gatewayBaseUrl;
        this.gatewayApiKey = builder.gatewayApiKey;
        this.gatewayTimeout = builder.gatewayTimeout;
        this.rateLimitPerMinute = builder.rateLimitPerMinute;
        this.maxLineChars = builder.maxLineChars;
        this.serverName = builder.serverName;
        this.debug = builder.debug;
    }

    public String getGatewayBaseUrl() {
        return gatewayBaseUrl;
    }

    public String getGatewayApiKey() {
        return gatewayApiKey;
    }

    public Duration getGatewayTimeout() {
        return gatewayTimeout;
    }

    public int getRateLimitPerMinute() {
        return rateLimitPerMinute;
    }

    public int getMaxLineChars() {
        return maxLineChars;
    }

    public String getServerName() {
        return serverName;
    }

    public boolean isDebug() {
        return debug;
    }

    public static Builder builder() {
        return new Builder();
    }

    /** Config with all defaults (mirrors config.yml). */
    public static AiPluginConfig defaults() {
        return builder().build();
    }

    /**
     * Expand {@code ${ENV_NAME}} placeholders against environment variables.
     * Used for the API key so secrets never have to live in config.yml.
     */
    public static String expandEnv(String raw) {
        if (raw == null) {
            return "";
        }
        StringBuilder out = new StringBuilder();
        int i = 0;
        while (i < raw.length()) {
            int start = raw.indexOf("${", i);
            if (start < 0) {
                out.append(raw, i, raw.length());
                break;
            }
            out.append(raw, i, start);
            int end = raw.indexOf('}', start + 2);
            if (end < 0) {
                out.append(raw.substring(start));
                break;
            }
            String name = raw.substring(start + 2, end);
            out.append(Objects.requireNonNullElse(System.getenv(name), ""));
            i = end + 1;
        }
        return out.toString();
    }

    public static final class Builder {
        private String gatewayBaseUrl = "http://127.0.0.1:4100";
        private String gatewayApiKey = "";
        private Duration gatewayTimeout = Duration.ofSeconds(30);
        private int rateLimitPerMinute = 10;
        private int maxLineChars = 200;
        private String serverName = "smp";
        private boolean debug = false;

        public Builder gatewayBaseUrl(String gatewayBaseUrl) {
            this.gatewayBaseUrl = gatewayBaseUrl;
            return this;
        }

        public Builder gatewayApiKey(String gatewayApiKey) {
            this.gatewayApiKey = expandEnv(gatewayApiKey);
            return this;
        }

        public Builder gatewayTimeout(Duration gatewayTimeout) {
            this.gatewayTimeout = gatewayTimeout;
            return this;
        }

        public Builder rateLimitPerMinute(int rateLimitPerMinute) {
            this.rateLimitPerMinute = rateLimitPerMinute;
            return this;
        }

        public Builder maxLineChars(int maxLineChars) {
            this.maxLineChars = maxLineChars;
            return this;
        }

        public Builder serverName(String serverName) {
            this.serverName = serverName;
            return this;
        }

        public Builder debug(boolean debug) {
            this.debug = debug;
            return this;
        }

        public AiPluginConfig build() {
            validateGatewayBaseUrl(gatewayBaseUrl);
            Objects.requireNonNull(gatewayTimeout, "gatewayTimeout");
            if (gatewayTimeout.isZero() || gatewayTimeout.isNegative()
                    || gatewayTimeout.compareTo(Duration.ofSeconds(120)) > 0) {
                throw new IllegalArgumentException("gatewayTimeout must be between 1ms and 120s");
            }
            if (rateLimitPerMinute < 1) {
                throw new IllegalArgumentException("rateLimitPerMinute must be >= 1");
            }
            if (maxLineChars < 40 || maxLineChars > 240) {
                throw new IllegalArgumentException("maxLineChars must be between 40 and 240");
            }
            return new AiPluginConfig(this);
        }
    }

    /** Flatten a Bukkit FileConfiguration-style nested map lookup. */
    public static AiPluginConfig fromNestedMap(Map<String, Object> root) {
        Builder builder = builder();
        Map<String, Object> gateway = nested(root, "gateway");
        Map<String, Object> rateLimit = nested(root, "rate-limit");
        Map<String, Object> messages = nested(root, "messages");
        Map<String, Object> server = nested(root, "server");

        if (gateway.containsKey("base-url")) {
            builder.gatewayBaseUrl(String.valueOf(gateway.get("base-url")));
        }
        if (gateway.containsKey("api-key")) {
            builder.gatewayApiKey(String.valueOf(gateway.get("api-key")));
        }
        if (gateway.containsKey("request-timeout-ms")) {
            builder.gatewayTimeout(Duration.ofMillis(toLong(gateway.get("request-timeout-ms"), "gateway.request-timeout-ms")));
        }
        if (rateLimit.containsKey("max-per-minute")) {
            builder.rateLimitPerMinute(toInt(rateLimit.get("max-per-minute"), "rate-limit.max-per-minute"));
        }
        if (messages.containsKey("max-line-chars")) {
            builder.maxLineChars(toInt(messages.get("max-line-chars"), "messages.max-line-chars"));
        }
        if (server.containsKey("name")) {
            builder.serverName(String.valueOf(server.get("name")));
        }
        if (root.containsKey("debug")) {
            builder.debug(Boolean.parseBoolean(String.valueOf(root.get("debug"))));
        }
        return builder.build();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> nested(Map<String, Object> root, String key) {
        Object value = root.get(key);
        return value instanceof Map<?, ?> map ? (Map<String, Object>) new HashMap<>((Map<?, ?>) map)
                : new HashMap<>();
    }

    private static void validateGatewayBaseUrl(String raw) {
        if (raw == null || raw.isBlank()) {
            throw new IllegalArgumentException("gatewayBaseUrl must be a non-empty HTTP(S) URL");
        }
        final URI uri;
        try {
            uri = URI.create(raw);
        } catch (IllegalArgumentException ex) {
            throw new IllegalArgumentException("gatewayBaseUrl must be a valid HTTP(S) URL", ex);
        }
        String scheme = uri.getScheme();
        boolean http = "http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme);
        String path = uri.getPath();
        boolean rootPath = path == null || path.isEmpty() || "/".equals(path);
        if (!http || uri.getHost() == null || uri.getUserInfo() != null
                || uri.getQuery() != null || uri.getFragment() != null || !rootPath) {
            throw new IllegalArgumentException(
                    "gatewayBaseUrl must be an HTTP(S) origin without credentials, query, fragment, or path");
        }
    }

    private static int toInt(Object value, String field) {
        long parsed = toLong(value, field);
        if (parsed < Integer.MIN_VALUE || parsed > Integer.MAX_VALUE) {
            throw new IllegalArgumentException(field + " is outside the supported integer range");
        }
        return (int) parsed;
    }

    private static long toLong(Object value, String field) {
        if (value instanceof Number n) {
            return n.longValue();
        }
        try {
            return Long.parseLong(String.valueOf(value));
        } catch (NumberFormatException ex) {
            throw new IllegalArgumentException(field + " must be an integer", ex);
        }
    }
}
