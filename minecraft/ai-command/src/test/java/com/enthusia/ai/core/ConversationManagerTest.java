package com.enthusia.ai.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class ConversationManagerTest {

    private final ConversationManager manager = new ConversationManager();
    private final UUID player = UUID.randomUUID();

    @Test
    void conversationIdIsStable() {
        assertEquals(manager.conversationId(player), manager.conversationId(player));
    }

    @Test
    void idsArePerPlayer() {
        assertNotEquals(manager.conversationId(player),
                manager.conversationId(UUID.randomUUID()));
    }

    @Test
    void clearRotatesIdAndDropsHistory() {
        String before = manager.conversationId(player);
        manager.recordExchange(player, "q", "a");
        manager.clear(player);
        assertNotEquals(before, manager.conversationId(player));
        assertTrue(manager.history(player).isEmpty());
    }

    @Test
    void historyBoundedToMax() {
        for (int i = 0; i < ConversationManager.MAX_HISTORY + 5; i++) {
            manager.recordExchange(player, "q" + i, "a" + i);
        }
        List<ConversationManager.Exchange> history = manager.history(player);
        assertEquals(ConversationManager.MAX_HISTORY, history.size());
        // Oldest entries were evicted.
        assertEquals("q5", history.get(0).question());
        assertEquals("q" + (ConversationManager.MAX_HISTORY + 4),
                history.get(history.size() - 1).question());
    }

    @Test
    void answerExcerptTruncated() {
        String longAnswer = "x".repeat(ConversationManager.EXCERPT_CHARS + 50);
        manager.recordExchange(player, "q", longAnswer);
        String excerpt = manager.history(player).get(0).answerExcerpt();
        assertTrue(excerpt.endsWith("..."));
        assertEquals(ConversationManager.EXCERPT_CHARS + 3, excerpt.length());
    }

    @Test
    void emptyHistoryForNewPlayer() {
        assertTrue(manager.history(UUID.randomUUID()).isEmpty());
    }
}
