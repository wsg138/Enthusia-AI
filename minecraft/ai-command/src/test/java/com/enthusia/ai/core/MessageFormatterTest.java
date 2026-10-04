package com.enthusia.ai.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class MessageFormatterTest {

    private static AgentResponse response(String text) {
        return AgentResponse.parse("{\"text\":" + Json.stringify(text)
                + ",\"actions\":[],\"sources\":[],\"memoryUpdates\":[],"
                + "\"escalation\":null,\"traceId\":\"t1\"}");
    }

    @Test
    void sanitizeStripsSectionCodes() {
        String out = MessageFormatter.sanitize("§cRed §lBold §rnormal");
        assertFalse(out.contains("§"), out);
        assertTrue(out.contains("Red"));
        assertTrue(out.contains("normal"));
    }

    @Test
    void sanitizeEscapesAmpersandCodes() {
        // "&c" typed by the model must not become a color code in chat.
        String out = MessageFormatter.sanitize("use &c for red");
        assertFalse(out.contains("&c"), out);
        assertTrue(out.contains("&&c") || out.contains("&"), out);
    }

    @Test
    void sanitizeStripsControlCharsKeepsNewlines() {
        String out = MessageFormatter.sanitize("a\u0007b\nc\td");
        assertEquals("ab\nc\td", out);
    }

    @Test
    void wrapRespectsWordBoundaries() {
        List<String> lines = MessageFormatter.wrap(
                "one two three four five six", 10);
        for (String line : lines) {
            assertTrue(line.length() <= 10, line);
        }
        assertEquals(List.of("one two", "three four", "five six"), lines);
    }

    @Test
    void wrapKeepsParagraphBreaks() {
        List<String> lines = MessageFormatter.wrap("para one\n\npara two", 200);
        assertEquals(List.of("para one", "", "para two"), lines);
    }

    @Test
    void wrapSplitsLongWords() {
        List<String> lines = MessageFormatter.wrap("x".repeat(25), 10);
        assertEquals(3, lines.size());
        for (String line : lines) {
            assertTrue(line.length() <= 10);
        }
    }

    @Test
    void formatAnswerPrefixesEveryLine() {
        AgentResponse resp = response("The server IP is play.example.com. Join any time!");
        List<String> lines = MessageFormatter.formatAnswer(resp, false, 20);
        assertTrue(lines.size() > 1);
        for (String line : lines) {
            assertTrue(line.startsWith(MessageFormatter.PREFIX), line);
        }
    }

    @Test
    void formatAnswerEmptyText() {
        List<String> lines = MessageFormatter.formatAnswer(response("   "), false, 200);
        assertEquals(1, lines.size());
        assertTrue(lines.get(0).contains("empty response"));
    }

    @Test
    void formatEscalationHuman() {
        AgentResponse resp = AgentResponse.parse(
                "{\"text\":\"\",\"actions\":[],\"sources\":[],\"memoryUpdates\":[],"
                        + "\"escalation\":{\"reason\":\"needs staff\",\"target\":\"human\"},"
                        + "\"traceId\":\"t2\"}");
        List<String> lines = MessageFormatter.formatAnswer(resp, false, 200);
        assertEquals(1, lines.size());
        assertTrue(lines.get(0).contains("staff review"), lines.get(0));
    }

    @Test
    void formatEscalationStrongModel() {
        AgentResponse resp = AgentResponse.parse(
                "{\"text\":\"\",\"actions\":[],\"sources\":[],\"memoryUpdates\":[],"
                        + "\"escalation\":{\"reason\":\"complex\",\"target\":\"strong-model\"},"
                        + "\"traceId\":\"t3\"}");
        List<String> lines = MessageFormatter.formatAnswer(resp, false, 200);
        assertTrue(lines.get(0).contains("escalating"), lines.get(0));
    }

    @Test
    void staffViewAppendsSources() {
        AgentResponse resp = AgentResponse.parse(
                "{\"text\":\"answer\",\"actions\":[],"
                        + "\"sources\":[{\"description\":\"plugin.yml of Staff v2\","
                        + "\"visibility\":\"STAFF\"}],"
                        + "\"memoryUpdates\":[],\"escalation\":null,\"traceId\":\"t4\"}");
        List<String> playerLines = MessageFormatter.formatAnswer(resp, false, 200);
        List<String> staffLines = MessageFormatter.formatAnswer(resp, true, 200);
        assertTrue(staffLines.size() > playerLines.size());
        assertTrue(staffLines.stream().anyMatch(l -> l.contains("plugin.yml of Staff v2")));
        assertTrue(playerLines.stream().noneMatch(l -> l.contains("Sources")));
    }

    @Test
    void formatAnswerBoundsVeryLargeGatewayOutput() {
        List<String> lines = MessageFormatter.formatAnswer(response("word ".repeat(5000)), false, 40);
        assertTrue(lines.size() <= MessageFormatter.MAX_OUTPUT_LINES, lines::toString);
        assertTrue(lines.get(lines.size() - 1).contains("truncated"), lines::toString);
    }

    @Test
    void formatErrorIsPlayerSafe() {
        GatewayException ex = new GatewayException.UnavailableException("conn refused: secret details");
        String line = MessageFormatter.formatError(ex);
        assertTrue(line.startsWith("§c[AI]"), line);
        assertTrue(line.contains("currently unavailable"), line);
        assertFalse(line.contains("secret details"), line);
    }
}
