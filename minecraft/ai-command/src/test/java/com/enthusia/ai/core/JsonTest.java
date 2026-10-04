package com.enthusia.ai.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class JsonTest {

    @Test
    void parseObjectPrimitives() {
        Map<String, Object> obj = Json.asObject(
                Json.parse("{\"a\":1,\"b\":2.5,\"c\":true,\"d\":false,\"e\":null,\"f\":\"x\"}"));
        assertEquals(1L, obj.get("a"));
        assertEquals(2.5, obj.get("b"));
        assertEquals(Boolean.TRUE, obj.get("c"));
        assertEquals(Boolean.FALSE, obj.get("d"));
        assertNull(obj.get("e"));
        assertEquals("x", obj.get("f"));
    }

    @Test
    void parseNested() {
        Map<String, Object> obj = Json.asObject(
                Json.parse("{\"outer\":{\"inner\":[1,{\"deep\":\"v\"}]}}"));
        Map<String, Object> outer = Json.asObject(obj.get("outer"));
        List<Object> inner = Json.asList(outer.get("inner"));
        assertEquals(1L, inner.get(0));
        assertEquals("v", Json.asObject(inner.get(1)).get("deep"));
    }

    @Test
    void parseEscapes() {
        Map<String, Object> obj = Json.asObject(
                Json.parse("{\"s\":\"a\\\"b\\\\c\\nd\\te\\u00e9\"}"));
        assertEquals("a\"b\\c\nd\te\u00e9", obj.get("s"));
    }

    @Test
    void parseEmptyContainers() {
        assertTrue(Json.asObject(Json.parse("{}")).isEmpty());
        assertTrue(Json.asList(Json.parse("[]")).isEmpty());
    }

    @Test
    void parseMalformedThrows() {
        assertThrows(Json.JsonException.class, () -> Json.parse("{"));
        assertThrows(Json.JsonException.class, () -> Json.parse("{\"a\":}"));
        assertThrows(Json.JsonException.class, () -> Json.parse("[1,2"));
        assertThrows(Json.JsonException.class, () -> Json.parse("\"unterminated"));
        assertThrows(Json.JsonException.class, () -> Json.parse("{} trailing"));
    }

    @Test
    void stringifyRoundTrip() {
        Map<String, Object> obj = Map.of(
                "s", "a\"b\\c\n",
                "n", 42L,
                "list", List.of("x", Map.of("k", "v")),
                "bool", true);
        String json = Json.stringify(obj);
        Map<String, Object> back = Json.asObject(Json.parse(json));
        assertEquals("a\"b\\c\n", back.get("s"));
        assertEquals(42L, back.get("n"));
        assertEquals("x", Json.asList(back.get("list")).get(0));
        assertEquals(Boolean.TRUE, back.get("bool"));
    }

    @Test
    void stringifyControlChars() {
        String json = Json.stringify(Map.of("s", "a\u0001b"));
        assertTrue(json.contains("\\u0001"), json);
        Map<String, Object> back = Json.asObject(Json.parse(json));
        assertEquals("a\u0001b", back.get("s"));
    }
}
