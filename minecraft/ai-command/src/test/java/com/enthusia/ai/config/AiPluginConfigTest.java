package com.enthusia.ai.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.api.Test;

class AiPluginConfigTest {

    @Test
    void defaultsMatchCurrentGateway() {
        AiPluginConfig config = AiPluginConfig.defaults();
        assertEquals("http://127.0.0.1:4100", config.getGatewayBaseUrl());
        assertEquals(Duration.ofSeconds(30), config.getGatewayTimeout());
    }

    @Test
    void rejectsNonHttpGatewayUrl() {
        assertThrows(IllegalArgumentException.class,
                () -> AiPluginConfig.builder().gatewayBaseUrl("file:///tmp/socket").build());
    }

    @Test
    void rejectsGatewayUrlWithCredentialsOrPath() {
        assertThrows(IllegalArgumentException.class,
                () -> AiPluginConfig.builder().gatewayBaseUrl("http://user:pass@localhost:4100").build());
        assertThrows(IllegalArgumentException.class,
                () -> AiPluginConfig.builder().gatewayBaseUrl("http://localhost:4100/proxy").build());
    }

    @Test
    void rejectsUnboundedTimeoutAndLineWidth() {
        assertThrows(IllegalArgumentException.class,
                () -> AiPluginConfig.builder().gatewayTimeout(Duration.ZERO).build());
        assertThrows(IllegalArgumentException.class,
                () -> AiPluginConfig.builder().gatewayTimeout(Duration.ofSeconds(121)).build());
        assertThrows(IllegalArgumentException.class,
                () -> AiPluginConfig.builder().maxLineChars(241).build());
    }

    @Test
    void rejectsMalformedNumericConfiguration() {
        Map<String, Object> root = Map.of(
                "rate-limit", Map.of("max-per-minute", "many"));
        assertThrows(IllegalArgumentException.class, () -> AiPluginConfig.fromNestedMap(root));
    }
}
