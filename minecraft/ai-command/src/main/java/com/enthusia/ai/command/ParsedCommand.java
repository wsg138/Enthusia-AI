package com.enthusia.ai.command;

/**
 * Result of parsing {@code /ai} arguments.
 *
 * <p>Command surface:
 * <ul>
 *   <li>{@code /ai <question>} — ask the AI (also {@code /ai ask <question>})</li>
 *   <li>{@code /ai help} — usage</li>
 *   <li>{@code /ai clear} — reset conversation continuity</li>
 *   <li>{@code /ai history} — show recent exchanges</li>
 *   <li>{@code /ai staff ask <question>} — staff-visibility query</li>
 *   <li>{@code /ai staff status} — gateway health</li>
 *   <li>{@code /ai staff reload} — reload plugin config (admin)</li>
 *   <li>{@code /ai staff ratelimit clear <player>} — reset a player's rate limit (admin)</li>
 * </ul>
 */
public final class ParsedCommand {

    public enum Kind {
        ASK,
        HELP,
        CLEAR,
        HISTORY,
        STAFF_ASK,
        STAFF_STATUS,
        STAFF_RELOAD,
        STAFF_RATELIMIT_CLEAR,
        /** Arguments did not match any known form — show usage. */
        UNKNOWN
    }

    private final Kind kind;
    /** The joined question text for ASK / STAFF_ASK. */
    private final String question;
    /** Target player name for STAFF_RATELIMIT_CLEAR. */
    private final String target;

    private ParsedCommand(Kind kind, String question, String target) {
        this.kind = kind;
        this.question = question;
        this.target = target;
    }

    public Kind kind() {
        return kind;
    }

    public String question() {
        return question;
    }

    public String target() {
        return target;
    }

    /** True for the staff-only subcommands (need {@code enthusia.ai.staff}). */
    public boolean isStaffCommand() {
        return switch (kind) {
            case STAFF_ASK, STAFF_STATUS, STAFF_RELOAD, STAFF_RATELIMIT_CLEAR -> true;
            default -> false;
        };
    }

    /** True for the admin-only subcommands (need {@code enthusia.ai.admin}). */
    public boolean isAdminCommand() {
        return kind == Kind.STAFF_RELOAD || kind == Kind.STAFF_RATELIMIT_CLEAR;
    }

    static ParsedCommand ask(String question) {
        return new ParsedCommand(Kind.ASK, question, null);
    }

    static ParsedCommand staffAsk(String question) {
        return new ParsedCommand(Kind.STAFF_ASK, question, null);
    }

    static ParsedCommand of(Kind kind) {
        return new ParsedCommand(kind, null, null);
    }

    static ParsedCommand ratelimitClear(String target) {
        return new ParsedCommand(Kind.STAFF_RATELIMIT_CLEAR, null, target);
    }
}
