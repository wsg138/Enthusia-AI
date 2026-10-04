package com.enthusia.ai.core;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Tracks per-player conversation continuity for the gateway.
 *
 * <p>Each player gets a stable {@code conversationId} (sent as
 * {@code ChatRequest.conversationId}) so follow-up questions keep context.
 * {@code /ai clear} rotates the id and drops local history.
 *
 * <p>A bounded in-memory log of recent exchanges backs {@code /ai history}.
 * This is a display convenience only — the gateway owns real conversation
 * memory (spec section 13).
 */
public final class ConversationManager {

    /** Maximum exchanges kept per player for /ai history. */
    public static final int MAX_HISTORY = 10;
    /** Answer excerpt length stored per exchange. */
    public static final int EXCERPT_CHARS = 200;

    /** A single recorded question/answer pair. */
    public record Exchange(String question, String answerExcerpt) {
    }

    private final Map<UUID, String> conversationIds = new HashMap<>();
    private final Map<UUID, Deque<Exchange>> histories = new HashMap<>();

    /** Stable conversation id for the player, created on first use. */
    public synchronized String conversationId(UUID playerId) {
        return conversationIds.computeIfAbsent(playerId, id -> UUID.randomUUID().toString());
    }

    /** Rotate the conversation id and drop history (the {@code /ai clear} command). */
    public synchronized void clear(UUID playerId) {
        conversationIds.put(playerId, UUID.randomUUID().toString());
        histories.remove(playerId);
    }

    /** Record a completed exchange for {@code /ai history}. */
    public synchronized void recordExchange(UUID playerId, String question, String answer) {
        Deque<Exchange> history = histories.computeIfAbsent(playerId, id -> new ArrayDeque<>());
        String excerpt = answer == null ? "" : answer.strip();
        if (excerpt.length() > EXCERPT_CHARS) {
            excerpt = excerpt.substring(0, EXCERPT_CHARS) + "...";
        }
        history.addLast(new Exchange(question, excerpt));
        while (history.size() > MAX_HISTORY) {
            history.removeFirst();
        }
    }

    /** Recent exchanges, oldest first. Empty when the player has asked nothing yet. */
    public synchronized List<Exchange> history(UUID playerId) {
        Deque<Exchange> history = histories.get(playerId);
        return history == null ? List.of() : new ArrayList<>(history);
    }

    /** Drop all state (plugin disable). */
    public synchronized void clearAll() {
        conversationIds.clear();
        histories.clear();
    }
}
