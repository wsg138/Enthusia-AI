package com.enthusia.ai.command;

/**
 * Parses {@code /ai} command arguments into {@link ParsedCommand}.
 *
 * <p>Pure logic — no Bukkit dependency — so it is directly unit-testable.
 */
public final class CommandParser {

    private CommandParser() {
    }

    /**
     * Parse the raw argument array.
     *
     * @param args command arguments (never null)
     * @return the parsed command; {@link ParsedCommand.Kind#UNKNOWN} when the
     *         arguments match nothing (caller should show usage)
     */
    public static ParsedCommand parse(String[] args) {
        if (args == null || args.length == 0) {
            return ParsedCommand.of(ParsedCommand.Kind.UNKNOWN);
        }
        String first = args[0].toLowerCase();
        return switch (first) {
            case "help", "?" -> ParsedCommand.of(ParsedCommand.Kind.HELP);
            case "clear", "reset" -> ParsedCommand.of(ParsedCommand.Kind.CLEAR);
            case "history", "log" -> ParsedCommand.of(ParsedCommand.Kind.HISTORY);
            case "ask" -> {
                String question = join(args, 1);
                yield question.isBlank()
                        ? ParsedCommand.of(ParsedCommand.Kind.UNKNOWN)
                        : ParsedCommand.ask(question);
            }
            case "staff" -> parseStaff(args);
            default -> ParsedCommand.ask(join(args, 0));
        };
    }

    private static ParsedCommand parseStaff(String[] args) {
        if (args.length < 2) {
            return ParsedCommand.of(ParsedCommand.Kind.UNKNOWN);
        }
        String sub = args[1].toLowerCase();
        return switch (sub) {
            case "ask" -> {
                String question = join(args, 2);
                yield question.isBlank()
                        ? ParsedCommand.of(ParsedCommand.Kind.UNKNOWN)
                        : ParsedCommand.staffAsk(question);
            }
            case "status", "health", "ping" -> ParsedCommand.of(ParsedCommand.Kind.STAFF_STATUS);
            case "reload" -> ParsedCommand.of(ParsedCommand.Kind.STAFF_RELOAD);
            case "ratelimit", "rate-limit" -> {
                // /ai staff ratelimit clear <player>
                if (args.length == 4 && args[2].equalsIgnoreCase("clear") && !args[3].isBlank()) {
                    yield ParsedCommand.ratelimitClear(args[3]);
                }
                yield ParsedCommand.of(ParsedCommand.Kind.UNKNOWN);
            }
            default -> ParsedCommand.of(ParsedCommand.Kind.UNKNOWN);
        };
    }

    private static String join(String[] args, int from) {
        StringBuilder sb = new StringBuilder();
        for (int i = from; i < args.length; i++) {
            if (sb.length() > 0) {
                sb.append(' ');
            }
            sb.append(args[i]);
        }
        return sb.toString().strip();
    }
}
