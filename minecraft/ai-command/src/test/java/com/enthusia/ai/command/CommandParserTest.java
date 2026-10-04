package com.enthusia.ai.command;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class CommandParserTest {

    @Test
    void emptyArgsIsUnknown() {
        assertEquals(ParsedCommand.Kind.UNKNOWN, CommandParser.parse(new String[] {}).kind());
    }

    @Test
    void bareQuestionIsAsk() {
        ParsedCommand parsed = CommandParser.parse(new String[] {"what", "is", "the", "ip?"});
        assertEquals(ParsedCommand.Kind.ASK, parsed.kind());
        assertEquals("what is the ip?", parsed.question());
        assertFalse(parsed.isStaffCommand());
    }

    @Test
    void askSubcommandIsAsk() {
        ParsedCommand parsed = CommandParser.parse(new String[] {"ask", "how", "do", "i", "claim?"});
        assertEquals(ParsedCommand.Kind.ASK, parsed.kind());
        assertEquals("how do i claim?", parsed.question());
    }

    @Test
    void askWithNoQuestionIsUnknown() {
        assertEquals(ParsedCommand.Kind.UNKNOWN, CommandParser.parse(new String[] {"ask"}).kind());
    }

    @Test
    void helpVariants() {
        assertEquals(ParsedCommand.Kind.HELP, CommandParser.parse(new String[] {"help"}).kind());
        assertEquals(ParsedCommand.Kind.HELP, CommandParser.parse(new String[] {"HELP"}).kind());
        assertEquals(ParsedCommand.Kind.HELP, CommandParser.parse(new String[] {"?"}).kind());
    }

    @Test
    void clearAndHistory() {
        assertEquals(ParsedCommand.Kind.CLEAR, CommandParser.parse(new String[] {"clear"}).kind());
        assertEquals(ParsedCommand.Kind.CLEAR, CommandParser.parse(new String[] {"reset"}).kind());
        assertEquals(ParsedCommand.Kind.HISTORY, CommandParser.parse(new String[] {"history"}).kind());
    }

    @Test
    void staffAsk() {
        ParsedCommand parsed = CommandParser.parse(new String[] {"staff", "ask", "why", "lag?"});
        assertEquals(ParsedCommand.Kind.STAFF_ASK, parsed.kind());
        assertEquals("why lag?", parsed.question());
        assertTrue(parsed.isStaffCommand());
        assertFalse(parsed.isAdminCommand());
    }

    @Test
    void staffAskWithNoQuestionIsUnknown() {
        assertEquals(ParsedCommand.Kind.UNKNOWN,
                CommandParser.parse(new String[] {"staff", "ask"}).kind());
    }

    @Test
    void staffStatus() {
        ParsedCommand parsed = CommandParser.parse(new String[] {"staff", "status"});
        assertEquals(ParsedCommand.Kind.STAFF_STATUS, parsed.kind());
        assertTrue(parsed.isStaffCommand());
        assertFalse(parsed.isAdminCommand());
    }

    @Test
    void staffReloadIsAdmin() {
        ParsedCommand parsed = CommandParser.parse(new String[] {"staff", "reload"});
        assertEquals(ParsedCommand.Kind.STAFF_RELOAD, parsed.kind());
        assertTrue(parsed.isAdminCommand());
    }

    @Test
    void staffRatelimitClear() {
        ParsedCommand parsed = CommandParser.parse(
                new String[] {"staff", "ratelimit", "clear", "Notch"});
        assertEquals(ParsedCommand.Kind.STAFF_RATELIMIT_CLEAR, parsed.kind());
        assertEquals("Notch", parsed.target());
        assertTrue(parsed.isAdminCommand());
        assertNull(parsed.question());
    }

    @Test
    void staffRatelimitWithoutClearIsUnknown() {
        assertEquals(ParsedCommand.Kind.UNKNOWN,
                CommandParser.parse(new String[] {"staff", "ratelimit"}).kind());
        assertEquals(ParsedCommand.Kind.UNKNOWN,
                CommandParser.parse(new String[] {"staff", "ratelimit", "Notch"}).kind());
    }

    @Test
    void unknownStaffSubcommand() {
        assertEquals(ParsedCommand.Kind.UNKNOWN,
                CommandParser.parse(new String[] {"staff", "frobnicate"}).kind());
    }

    @Test
    void bareStaffIsUnknown() {
        assertEquals(ParsedCommand.Kind.UNKNOWN,
                CommandParser.parse(new String[] {"staff"}).kind());
    }
}
