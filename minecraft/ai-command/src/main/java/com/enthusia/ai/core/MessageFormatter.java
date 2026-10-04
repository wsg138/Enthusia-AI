package com.enthusia.ai.core;

import java.util.ArrayList;
import java.util.List;

/**
 * Renders {@link AgentResponse}s as safe Minecraft chat lines.
 *
 * <p>Safety rules (spec section 19):
 * <ul>
 *   <li>Plain text only — no click/hover events, so output stays compatible
 *       with Bedrock/Geyser players.</li>
 *   <li>Any formatting codes ({@code §} or {@code &}) produced by the model
 *       are stripped, so the AI cannot inject formatting or obfuscation.</li>
 *   <li>Lines are wrapped at word boundaries to {@code maxLineChars} visible
 *       characters, keeping every chat message well under the client limit.</li>
 *   <li>Internal detail (trace ids beyond staff view, error causes) never
 *       reaches chat.</li>
 * </ul>
 *
 * <p>Output uses legacy {@code §} color codes; the command executor converts
 * lines to Adventure components. The formatter itself is pure Java and fully
 * unit-testable without a server.
 */
public final class MessageFormatter {

    /** Default visible characters per chat line. */
    public static final int DEFAULT_MAX_LINE_CHARS = 200;
    public static final int MAX_RESPONSE_CHARS = 4000;
    public static final int MAX_OUTPUT_LINES = 32;

    /** Chat prefix shown on every AI line. */
    public static final String PREFIX = "§b[AI] §r";

    private MessageFormatter() {
    }

    /**
     * Format a normal answer into chat lines.
     *
     * @param response  the parsed agent response
     * @param staffView when true, append a compact source list for staff
     * @param maxLineChars wrap width in visible characters
     */
    public static List<String> formatAnswer(AgentResponse response, boolean staffView, int maxLineChars) {
        List<String> lines = new ArrayList<>();
        if (response.isEscalated()) {
            lines.addAll(formatEscalation(response, maxLineChars));
            return lines;
        }
        String text = boundedText(sanitize(response.getText()));
        if (text.isBlank()) {
            lines.add(PREFIX + "§7The AI returned an empty response. Please try again.");
            return lines;
        }
        for (String chunk : wrap(text, maxLineChars)) {
            lines.add(PREFIX + chunk);
        }
        if (staffView) {
            lines.addAll(formatSources(response, maxLineChars));
        }
        return capLines(lines);
    }

    /** Format an escalated response into player-safe chat lines. */
    public static List<String> formatEscalation(AgentResponse response, int maxLineChars) {
        List<String> lines = new ArrayList<>();
        String notice = switch (response.getEscalationTarget()) {
            case HUMAN -> "I've flagged this for staff review — someone will follow up.";
            case STRONG_MODEL -> "This needs deeper investigation — escalating it now.";
            default -> "I couldn't answer that directly.";
        };
        for (String chunk : wrap(notice, maxLineChars)) {
            lines.add("§e[AI] §r" + chunk);
        }
        return lines;
    }

    /** Player-safe rendering of a gateway failure. */
    public static String formatError(GatewayException failure) {
        return "§c[AI] §r" + sanitize(failure.getPlayerMessage());
    }

    /** Compact source list for staff view (already visibility-filtered by the gateway). */
    private static List<String> formatSources(AgentResponse response, int maxLineChars) {
        List<String> lines = new ArrayList<>();
        List<AgentResponse.Source> sources = response.getSources();
        if (sources.isEmpty()) {
            return lines;
        }
        lines.add("§8[AI] §7Sources (" + sources.size() + "):");
        int shown = 0;
        for (AgentResponse.Source source : sources) {
            if (shown >= 3) {
                lines.add("§8[AI] §7...and " + (sources.size() - shown) + " more");
                break;
            }
            String desc = sanitize(source.description());
            if (desc.isBlank()) {
                continue;
            }
            for (String chunk : wrap("• " + desc, maxLineChars)) {
                lines.add("§8[AI] §7" + chunk);
            }
            shown++;
        }
        return lines;
    }

    /**
     * Strip anything that could change rendering: legacy {@code §} codes,
     * ampersand color codes, control characters, and excessive blank lines.
     * Visible newlines are preserved so the model's paragraphs survive.
     */
    public static String sanitize(String raw) {
        if (raw == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder(raw.length());
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c == '§') {
                // Drop the section sign AND the formatting char that follows it.
                i++;
                continue;
            }
            if (c == '&' && i + 1 < raw.length() && isFormatCode(raw.charAt(i + 1))) {
                // Escape ampersand color codes so they render literally.
                sb.append("&&");
                i++;
                continue;
            }
            if (c < 0x20 && c != '\n' && c != '\t') {
                continue;
            }
            sb.append(c);
        }
        // Collapse 3+ newlines and trim.
        return sb.toString().replaceAll("\n{3,}", "\n\n").strip();
    }

    private static String boundedText(String text) {
        if (text.length() <= MAX_RESPONSE_CHARS) {
            return text;
        }
        return text.substring(0, MAX_RESPONSE_CHARS - 1).stripTrailing() + "…";
    }

    private static List<String> capLines(List<String> lines) {
        if (lines.size() <= MAX_OUTPUT_LINES) {
            return lines;
        }
        List<String> bounded = new ArrayList<>(lines.subList(0, MAX_OUTPUT_LINES - 1));
        bounded.add("§7[AI] …response truncated.");
        return bounded;
    }

    private static boolean isFormatCode(char c) {
        return "0123456789abcdefklmnorABCDEFKLMNOR".indexOf(c) >= 0;
    }

    /**
     * Wrap text into lines of at most {@code maxChars} visible characters,
     * breaking at word boundaries. Explicit newlines force line breaks.
     */
    public static List<String> wrap(String text, int maxChars) {
        List<String> lines = new ArrayList<>();
        for (String paragraph : text.split("\n", -1)) {
            wrapParagraph(paragraph.strip(), maxChars, lines);
        }
        // Drop trailing empty lines produced by trailing newlines.
        while (!lines.isEmpty() && lines.get(lines.size() - 1).isEmpty()) {
            lines.remove(lines.size() - 1);
        }
        if (lines.isEmpty()) {
            lines.add("");
        }
        return lines;
    }

    private static void wrapParagraph(String paragraph, int maxChars, List<String> lines) {
        if (paragraph.isEmpty()) {
            lines.add("");
            return;
        }
        String[] words = paragraph.split("\\s+");
        StringBuilder current = new StringBuilder();
        for (String word : words) {
            if (word.length() > maxChars) {
                // Hard-split pathological long words (e.g. URLs).
                if (current.length() > 0) {
                    lines.add(current.toString());
                    current.setLength(0);
                }
                for (int i = 0; i < word.length(); i += maxChars) {
                    lines.add(word.substring(i, Math.min(word.length(), i + maxChars)));
                }
                continue;
            }
            int extra = current.length() == 0 ? 0 : 1;
            if (current.length() + extra + word.length() > maxChars) {
                lines.add(current.toString());
                current.setLength(0);
            } else if (extra == 1) {
                current.append(' ');
            }
            current.append(word);
        }
        if (current.length() > 0) {
            lines.add(current.toString());
        }
    }
}
