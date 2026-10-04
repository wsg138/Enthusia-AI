package com.enthusia.ai.core;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Parsed {@code AgentResponse} from the AI Gateway contract
 * ({@code @enthusia/contracts} chat.ts).
 *
 * <p>Only the fields the Minecraft surface needs are retained: the
 * user-facing text, escalation state, sources (staff view), and trace id.
 */
public final class AgentResponse {

    /** Where the gateway escalated instead of answering directly. */
    public enum EscalationTarget {
        HUMAN, STRONG_MODEL, NONE;

        static EscalationTarget fromContract(String target) {
            if ("human".equals(target)) {
                return HUMAN;
            }
            if ("strong-model".equals(target)) {
                return STRONG_MODEL;
            }
            return NONE;
        }
    }

    /** A single evidence source backing the answer. */
    public record Source(String description, String visibility, String artifactId) {
    }

    private final String text;
    private final EscalationTarget escalationTarget;
    private final String escalationReason;
    private final List<Source> sources;
    private final String traceId;

    private AgentResponse(String text, EscalationTarget escalationTarget, String escalationReason,
            List<Source> sources, String traceId) {
        this.text = Objects.requireNonNull(text, "text");
        this.escalationTarget = Objects.requireNonNull(escalationTarget, "escalationTarget");
        this.escalationReason = escalationReason;
        this.sources = Collections.unmodifiableList(new ArrayList<>(sources));
        this.traceId = Objects.requireNonNull(traceId, "traceId");
    }

    public String getText() {
        return text;
    }

    public boolean isEscalated() {
        return escalationTarget != EscalationTarget.NONE;
    }

    public EscalationTarget getEscalationTarget() {
        return escalationTarget;
    }

    public String getEscalationReason() {
        return escalationReason;
    }

    public List<Source> getSources() {
        return sources;
    }

    public String getTraceId() {
        return traceId;
    }

    /** Parse an AgentResponse JSON document per the contracts schema. */
    public static AgentResponse parse(String json) {
        final Map<String, Object> root;
        try {
            root = Json.asObject(Json.parse(json));
        } catch (Json.JsonException ex) {
            throw new IllegalArgumentException("Response is not a JSON object: " + ex.getMessage(), ex);
        }

        String text = Json.optString(root, "text", "");
        String traceId = Json.optString(root, "traceId", "");

        EscalationTarget target = EscalationTarget.NONE;
        String reason = null;
        Map<String, Object> escalation = Json.optObject(root, "escalation");
        if (escalation != null) {
            target = EscalationTarget.fromContract(Json.optString(escalation, "target", ""));
            reason = Json.optString(escalation, "reason", null);
        }

        List<Source> sources = new ArrayList<>();
        Object rawSources = root.get("sources");
        if (rawSources instanceof List<?> list) {
            for (Object item : list) {
                if (item instanceof Map<?, ?>) {
                    Map<String, Object> src = Json.asObject(item);
                    sources.add(new Source(
                            Json.optString(src, "description", ""),
                            Json.optString(src, "visibility", ""),
                            Json.optString(src, "artifactId", null)));
                }
            }
        }

        if (traceId.isEmpty()) {
            throw new IllegalArgumentException("AgentResponse missing required 'traceId'");
        }
        return new AgentResponse(text, target, reason, sources, traceId);
    }
}
