package com.enthusia.ai.core;

/**
 * Base class for failures talking to the AI Gateway.
 *
 * <p>Carries a player-safe message (safe to show in chat) separately from the
 * internal detail (logged server-side only). Gateway error internals must
 * never leak to players below the appropriate visibility.
 */
public class GatewayException extends Exception {

    /** Message safe to display to the player who triggered the request. */
    private final String playerMessage;

    public GatewayException(String playerMessage, String detail) {
        super(detail);
        this.playerMessage = playerMessage;
    }

    public GatewayException(String playerMessage, String detail, Throwable cause) {
        super(detail, cause);
        this.playerMessage = playerMessage;
    }

    public String getPlayerMessage() {
        return playerMessage;
    }

    /** Gateway returned HTTP 429 (its own rate limiter). */
    public static final class RateLimitedException extends GatewayException {
        private final long retryAfterSeconds;

        public RateLimitedException(long retryAfterSeconds) {
            super("The AI is busy right now. Try again in " + retryAfterSeconds + "s.",
                    "Gateway rate limit exceeded; retry-after=" + retryAfterSeconds + "s");
            this.retryAfterSeconds = retryAfterSeconds;
        }

        public long getRetryAfterSeconds() {
            return retryAfterSeconds;
        }
    }

    /** HTTP 401 — the plugin's service API key was rejected. Server misconfiguration. */
    public static final class AuthenticationException extends GatewayException {
        public AuthenticationException() {
            super("The AI is misconfigured. Staff have been notified.",
                    "Gateway rejected the service API key (401)");
        }
    }

    /** HTTP 403 — surface/actor/visibility rejected by the gateway. */
    public static final class AuthorizationException extends GatewayException {
        public AuthorizationException(String detail) {
            super("The AI refused this request.", "Gateway authorization failure (403): " + detail);
        }
    }

    /** HTTP 400/413/422 — the request itself was invalid. */
    public static final class BadRequestException extends GatewayException {
        public BadRequestException(String detail) {
            super("That question could not be sent to the AI.", "Gateway rejected request: " + detail);
        }
    }

    /** The gateway did not answer in time. */
    public static final class TimeoutException extends GatewayException {
        public TimeoutException(long timeoutMs) {
            super("The AI took too long to respond. Please try again.",
                    "Gateway request timed out after " + timeoutMs + "ms");
        }
    }

    /** Connection refused / reset / 5xx — the gateway is down or erroring. */
    public static final class UnavailableException extends GatewayException {
        public UnavailableException(String detail) {
            super("The AI is currently unavailable. Please try again later.",
                    "Gateway unavailable: " + detail);
        }

        public UnavailableException(String detail, Throwable cause) {
            super("The AI is currently unavailable. Please try again later.",
                    "Gateway unavailable: " + detail, cause);
        }
    }

    /** The gateway answered with something that is not a valid AgentResponse. */
    public static final class ProtocolException extends GatewayException {
        public ProtocolException(String detail) {
            super("The AI gave an unexpected response. Please try again.",
                    "Gateway protocol error: " + detail);
        }
    }
}
