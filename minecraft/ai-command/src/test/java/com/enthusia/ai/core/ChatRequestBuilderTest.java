package com.enthusia.ai.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Verifies the ChatRequest documents match the {@code @enthusia/contracts}
 * chat contract: surface, actor, conversationId, message, context,
 * visibilityCeiling, traceId.
 */
class ChatRequestBuilderTest {

    private final UUID playerId = UUID.fromString("123e4567-e89b-12d3-a456-426614174000");

    @Test
    void playerRequestMatchesContract() {
        Map<String, Object> context = Map.of("serverName", "smp", "worldName", "world");
        String json = ChatRequestBuilder.buildPlayerRequest(
                playerId, "Steve", "conv-1", "what is the ip?",
                context, ChatRequestBuilder.Visibility.PLAYER_SELF);

        Map<String, Object> root = Json.asObject(Json.parse(json));
        assertEquals("minecraft", root.get("surface"));
        assertEquals("conv-1", root.get("conversationId"));
        assertEquals("what is the ip?", root.get("message"));
        assertEquals("PLAYER_SELF", root.get("visibilityCeiling"));
        assertTrue(root.containsKey("traceId"), "traceId must be present");

        Map<String, Object> actor = Json.asObject(root.get("actor"));
        assertEquals(playerId.toString(), actor.get("id"));
        assertEquals("player", actor.get("type"));
        assertEquals("Steve", actor.get("displayName"));
        assertEquals(playerId.toString(), actor.get("linkedUuid"));

        Map<String, Object> parsedContext = Json.asObject(root.get("context"));
        assertEquals("smp", parsedContext.get("serverName"));
        assertEquals("world", parsedContext.get("worldName"));
    }

    @Test
    void staffRequestUsesStaffActorAndCeiling() {
        String json = ChatRequestBuilder.buildStaffRequest(
                playerId, "Admin", "conv-2", "investigate lag",
                Map.of(), ChatRequestBuilder.Visibility.STAFF);

        Map<String, Object> root = Json.asObject(Json.parse(json));
        assertEquals("STAFF", root.get("visibilityCeiling"));
        Map<String, Object> actor = Json.asObject(root.get("actor"));
        assertEquals("staff", actor.get("type"));
    }

    @Test
    void consoleRequestUsesSystemActor() {
        String json = ChatRequestBuilder.buildConsoleRequest(
                "conv-3", "restart when?", Map.of("senderType", "console"),
                ChatRequestBuilder.Visibility.STAFF);

        Map<String, Object> root = Json.asObject(Json.parse(json));
        Map<String, Object> actor = Json.asObject(root.get("actor"));
        assertEquals("console", actor.get("id"));
        assertEquals("system", actor.get("type"));
        assertFalse(actor.containsKey("linkedUuid"), "console has no linkedUuid");
    }

    @Test
    void emptyContextIsOmitted() {
        String json = ChatRequestBuilder.buildPlayerRequest(
                playerId, "Steve", "conv-1", "hi", Map.of(),
                ChatRequestBuilder.Visibility.PLAYER_SELF);
        Map<String, Object> root = Json.asObject(Json.parse(json));
        assertFalse(root.containsKey("context"));
    }

    @Test
    void traceIdsAreUnique() {
        String first = ChatRequestBuilder.buildPlayerRequest(
                playerId, "Steve", "c", "hi", null, ChatRequestBuilder.Visibility.PLAYER_SELF);
        String second = ChatRequestBuilder.buildPlayerRequest(
                playerId, "Steve", "c", "hi", null, ChatRequestBuilder.Visibility.PLAYER_SELF);
        String t1 = Json.optString(Json.asObject(Json.parse(first)), "traceId", "");
        String t2 = Json.optString(Json.asObject(Json.parse(second)), "traceId", "");
        assertFalse(t1.isEmpty());
        assertFalse(t1.equals(t2));
    }

    @Test
    void messageWithSpecialCharsRoundTrips() {
        String tricky = "quote: \" backslash: \\ newline:\n unicode: \u00e9";
        String json = ChatRequestBuilder.buildPlayerRequest(
                playerId, "Steve", "c", tricky, null, ChatRequestBuilder.Visibility.PLAYER_SELF);
        Map<String, Object> root = Json.asObject(Json.parse(json));
        assertEquals(tricky, root.get("message"));
    }
}
