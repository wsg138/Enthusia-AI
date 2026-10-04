package com.enthusia.ai.core;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * Builds {@code ChatRequest} JSON documents for the AI Gateway
 * ({@code POST /v1/chat}), following the {@code @enthusia/contracts} chat
 * contract exactly:
 *
 * <pre>
 * {
 *   "surface": "minecraft",
 *   "actor": {"id": "&lt;uuid&gt;", "type": "player|staff|system",
 *              "displayName": "...", "linkedUuid": "..."},
 *   "conversationId": "...",
 *   "message": "...",
 *   "context": {"serverName": ..., "worldName": ..., ...},
 *   "visibilityCeiling": "PLAYER_SELF|STAFF|...",
 *   "traceId": "..."
 * }
 * </pre>
 *
 * <p>Visibility ceiling policy (spec section 17): player queries use
 * {@code PLAYER_SELF}; staff queries use {@code STAFF}. The gateway enforces
 * the actor-type ceiling on top of this.
 */
public final class ChatRequestBuilder {

    /** Visibility ceilings understood by the gateway contract. */
    public enum Visibility {
        PUBLIC, PLAYER_SELF, STAFF, MANAGEMENT, SYSTEM_INTERNAL, SECRET_DENY
    }

    /** Actor types understood by the gateway contract. */
    public enum ActorType {
        PLAYER("player"), STAFF("staff"), SYSTEM("system"), UNKNOWN("unknown");

        private final String contractValue;

        ActorType(String contractValue) {
            this.contractValue = contractValue;
        }

        public String contractValue() {
            return contractValue;
        }
    }

    private ChatRequestBuilder() {
    }

    /**
     * Build a player chat request.
     *
     * @param playerUuid     the player's Minecraft UUID (actor id + linkedUuid)
     * @param displayName    the player's current username
     * @param conversationId stable conversation id for follow-up continuity
     * @param message        the player's question
     * @param context        server/player context (serverName, worldName, ...)
     * @param visibility     visibility ceiling (PLAYER_SELF for players)
     */
    public static String buildPlayerRequest(UUID playerUuid, String displayName,
            String conversationId, String message, Map<String, Object> context,
            Visibility visibility) {
        Objects.requireNonNull(playerUuid, "playerUuid");
        Map<String, Object> actor = actorMap(
                playerUuid.toString(), ActorType.PLAYER,
                displayName, playerUuid.toString());
        return build("minecraft", actor, conversationId, message, context, visibility);
    }

    /**
     * Build a staff chat request (actor type {@code staff}, ceiling
     * {@code STAFF} unless the caller passes a lower ceiling).
     */
    public static String buildStaffRequest(UUID staffUuid, String displayName,
            String conversationId, String message, Map<String, Object> context,
            Visibility visibility) {
        Objects.requireNonNull(staffUuid, "staffUuid");
        Map<String, Object> actor = actorMap(
                staffUuid.toString(), ActorType.STAFF,
                displayName, staffUuid.toString());
        return build("minecraft", actor, conversationId, message, context, visibility);
    }

    /**
     * Build a console chat request (actor type {@code system}).
     */
    public static String buildConsoleRequest(String conversationId, String message,
            Map<String, Object> context, Visibility visibility) {
        Map<String, Object> actor = actorMap("console", ActorType.SYSTEM, "Console", null);
        return build("minecraft", actor, conversationId, message, context, visibility);
    }

    private static Map<String, Object> actorMap(String id, ActorType type,
            String displayName, String linkedUuid) {
        Map<String, Object> actor = new LinkedHashMap<>();
        actor.put("id", id);
        actor.put("type", type.contractValue());
        if (displayName != null && !displayName.isBlank()) {
            actor.put("displayName", displayName);
        }
        if (linkedUuid != null && !linkedUuid.isBlank()) {
            actor.put("linkedUuid", linkedUuid);
        }
        return actor;
    }

    private static String build(String surface, Map<String, Object> actor,
            String conversationId, String message, Map<String, Object> context,
            Visibility visibility) {
        Objects.requireNonNull(conversationId, "conversationId");
        Objects.requireNonNull(message, "message");
        Objects.requireNonNull(visibility, "visibility");

        Map<String, Object> root = new LinkedHashMap<>();
        root.put("surface", surface);
        root.put("actor", actor);
        root.put("conversationId", conversationId);
        root.put("message", message);
        if (context != null && !context.isEmpty()) {
            root.put("context", new LinkedHashMap<>(context));
        }
        root.put("visibilityCeiling", visibility.name());
        root.put("traceId", UUID.randomUUID().toString());
        return Json.stringify(root);
    }
}
