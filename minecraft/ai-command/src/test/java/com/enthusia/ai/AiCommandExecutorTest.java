package com.enthusia.ai;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.enthusia.ai.config.AiPluginConfig;
import com.enthusia.ai.core.AgentResponse;
import com.enthusia.ai.core.ConversationManager;
import com.enthusia.ai.core.GatewayClient;
import com.enthusia.ai.core.GatewayException;
import com.enthusia.ai.core.Json;
import com.enthusia.ai.core.RateLimiter;
import com.enthusia.ai.core.TaskRunner;
import java.lang.reflect.Proxy;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.logging.Logger;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.command.ConsoleCommandSender;
import org.bukkit.entity.Player;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Command executor tests. Bukkit objects are hand-rolled dynamic proxies and
 * the gateway is a fake subclass — no mocking framework, no live server.
 */
class AiCommandExecutorTest {

    /** Fake gateway: records the request JSON, returns canned answers. */
    static final class FakeGateway extends GatewayClient {
        String lastRequestJson;
        int chatCalls;
        AgentResponse nextResponse;
        GatewayException failure;
        HealthStatus healthStatus;

        FakeGateway() {
            super("http://localhost:1", "", Duration.ofSeconds(1));
        }

        @Override
        public AgentResponse chat(String requestJson) throws GatewayException {
            chatCalls++;
            lastRequestJson = requestJson;
            if (failure != null) {
                throw failure;
            }
            return nextResponse;
        }

        @Override
        public HealthStatus health() throws GatewayException {
            if (failure != null) {
                throw failure;
            }
            return healthStatus;
        }
    }

    /** Captures chat lines sent to a sender, as plain text. */
    static final class MessageSink {
        final List<String> messages = new ArrayList<>();

        void send(Object arg) {
            if (arg instanceof Component component) {
                messages.add(PlainTextComponentSerializer.plainText().serialize(component));
            } else if (arg != null) {
                messages.add(String.valueOf(arg));
            }
        }

        boolean contains(String fragment) {
            return messages.stream().anyMatch(m -> m.contains(fragment));
        }
    }

    private Player player;
    private MessageSink playerSink;
    private Set<String> playerPermissions;
    private UUID playerId;
    private FakeGateway gateway;
    private ConversationManager conversations;
    private RateLimiter rateLimiter;
    private AiCommandExecutor executor;
    private Command command;

    private final TaskRunner syncTasks = new TaskRunner() {
        @Override
        public void runAsync(Runnable task) {
            task.run();
        }

        @Override
        public void runSync(Runnable task) {
            task.run();
        }
    };

    private static AgentResponse answer(String text) {
        Map<String, Object> doc = new java.util.LinkedHashMap<>();
        doc.put("text", text);
        doc.put("actions", List.of());
        doc.put("sources", List.of());
        doc.put("memoryUpdates", List.of());
        doc.put("escalation", null);
        doc.put("traceId", "t-1");
        return AgentResponse.parse(Json.stringify(doc));
    }

    private World fakeWorld() {
        return (World) Proxy.newProxyInstance(
                getClass().getClassLoader(),
                new Class<?>[] {World.class},
                (p, method, args) -> switch (method.getName()) {
                    case "getName" -> "world";
                    case "getEnvironment" -> World.Environment.NORMAL;
                    default -> method.getReturnType() == boolean.class ? false : null;
                });
    }

    private Location fakeLocation() {
        return new Location(fakeWorld(), 10, 64, -5);
    }

    /** Player proxy that also captures sendMessage arguments. */
    private Player capturingPlayer(UUID id, String name, MessageSink sink, Set<String> permissions) {
        World world = fakeWorld();
        Location location = fakeLocation();
        return (Player) Proxy.newProxyInstance(
                getClass().getClassLoader(),
                new Class<?>[] {Player.class},
                (p, method, args) -> {
                    if (method.getDeclaringClass() == Object.class) {
                        return method.invoke(p, args);
                    }
                    if (method.getName().equals("sendMessage") && args != null && args.length >= 1) {
                        sink.send(args[0]);
                        return null;
                    }
                    if (method.getName().equals("hasPermission") && args != null && args.length == 1) {
                        return permissions.contains(String.valueOf(args[0]));
                    }
                    return switch (method.getName()) {
                        case "getUniqueId" -> id;
                        case "getName" -> name;
                        case "isOnline" -> true;
                        case "getWorld" -> world;
                        case "getLocation" -> location;
                        default -> method.getReturnType() == boolean.class ? false : null;
                    };
                });
    }

    private ConsoleCommandSender fakeConsole(MessageSink sink) {
        return (ConsoleCommandSender) Proxy.newProxyInstance(
                getClass().getClassLoader(),
                new Class<?>[] {ConsoleCommandSender.class},
                (p, method, args) -> {
                    if (method.getDeclaringClass() == Object.class) {
                        return method.invoke(p, args);
                    }
                    if (method.getName().equals("sendMessage") && args != null && args.length >= 1) {
                        sink.send(args[0]);
                        return null;
                    }
                    return switch (method.getName()) {
                        case "getName" -> "CONSOLE";
                        default -> method.getReturnType() == boolean.class ? false : null;
                    };
                });
    }

    @BeforeEach
    void setUp() {
        playerId = UUID.randomUUID();
        playerSink = new MessageSink();
        playerPermissions = new HashSet<>(Set.of(AiCommandExecutor.PERM_USE));
        player = capturingPlayer(playerId, "Steve", playerSink, playerPermissions);

        gateway = new FakeGateway();
        gateway.nextResponse = answer("default answer");
        conversations = new ConversationManager();
        rateLimiter = new RateLimiter(10);
        // The executor never dereferences the Command object (only the label),
        // so null is safe here. Command is a concrete class, not proxyable.
        command = null;

        Map<String, Object> lookup = new HashMap<>();
        executor = new AiCommandExecutor(
                Logger.getLogger("test"),
                AiPluginConfig.defaults(),
                gateway,
                rateLimiter,
                conversations,
                syncTasks,
                name -> (Player) lookup.get(name),
                () -> "reloaded");
    }

    private Map<String, Object> lastRequest() {
        return Json.asObject(Json.parse(gateway.lastRequestJson));
    }

    @Test
    void noArgsShowsUsage() {
        executor.onCommand(player, command, "ai", new String[] {});
        assertTrue(playerSink.contains("Usage"), playerSink.messages.toString());
    }

    @Test
    void missingPermissionDenied() {
        playerPermissions.clear();
        executor.onCommand(player, command, "ai", new String[] {"hello?"});
        assertTrue(playerSink.contains("don't have permission"));
        assertEquals(0, gateway.chatCalls);
    }

    @Test
    void askBuildsContractRequestAndDeliversAnswer() {
        gateway.nextResponse = answer("The IP is play.example.com");

        executor.onCommand(player, command, "ai", new String[] {"what", "is", "the", "ip?"});

        assertEquals(1, gateway.chatCalls);
        Map<String, Object> root = lastRequest();
        assertEquals("minecraft", root.get("surface"));
        assertEquals("what is the ip?", root.get("message"));
        assertEquals("PLAYER_SELF", root.get("visibilityCeiling"));
        Map<String, Object> actor = Json.asObject(root.get("actor"));
        assertEquals(playerId.toString(), actor.get("id"));
        assertEquals("player", actor.get("type"));
        assertEquals("Steve", actor.get("displayName"));
        assertEquals(playerId.toString(), actor.get("linkedUuid"));
        Map<String, Object> context = Json.asObject(root.get("context"));
        assertEquals("smp", context.get("serverName"));
        assertEquals("world", context.get("worldName"));
        assertEquals("10,64,-5", context.get("playerLocation"));

        assertTrue(playerSink.contains("Thinking"), playerSink.messages.toString());
        assertTrue(playerSink.contains("The IP is play.example.com"), playerSink.messages.toString());

        // Conversation continuity: exchange recorded.
        assertEquals(1, conversations.history(playerId).size());
    }

    @Test
    void rateLimitBlocksSecondQuestion() {
        rateLimiter = new RateLimiter(1);
        executor.reload(AiPluginConfig.builder().rateLimitPerMinute(1).build(),
                gateway, rateLimiter);

        executor.onCommand(player, command, "ai", new String[] {"one"});
        executor.onCommand(player, command, "ai", new String[] {"two"});

        assertEquals(1, gateway.chatCalls);
        assertTrue(playerSink.contains("Slow down"), playerSink.messages.toString());
    }

    @Test
    void gatewayFailureShowsPlayerSafeError() {
        gateway.failure = new GatewayException.UnavailableException("conn refused: 10.0.0.9:8080");

        executor.onCommand(player, command, "ai", new String[] {"hello?"});

        assertTrue(playerSink.contains("currently unavailable"), playerSink.messages.toString());
        assertTrue(playerSink.messages.stream().noneMatch(m -> m.contains("10.0.0.9")),
                "internal detail must not leak to chat: " + playerSink.messages);
    }

    @Test
    void gatewayTimeoutShowsPlayerSafeError() {
        gateway.failure = new GatewayException.TimeoutException(30_000);
        executor.onCommand(player, command, "ai", new String[] {"hello?"});
        assertTrue(playerSink.contains("took too long"), playerSink.messages.toString());
    }

    @Test
    void staffAskRequiresStaffPermission() {
        executor.onCommand(player, command, "ai", new String[] {"staff", "ask", "why", "lag?"});
        assertTrue(playerSink.contains("don't have permission"));
        assertEquals(0, gateway.chatCalls);
    }

    @Test
    void staffAskUsesStaffCeiling() {
        playerPermissions.add(AiCommandExecutor.PERM_STAFF);

        executor.onCommand(player, command, "ai", new String[] {"staff", "ask", "why", "lag?"});

        assertEquals(1, gateway.chatCalls);
        Map<String, Object> root = lastRequest();
        assertEquals("STAFF", root.get("visibilityCeiling"));
        assertEquals("staff", Json.asObject(root.get("actor")).get("type"));
    }

    @Test
    void consoleAskBypassesRateLimit() {
        MessageSink consoleSink = new MessageSink();
        ConsoleCommandSender console = fakeConsole(consoleSink);

        executor.onCommand(console, command, "ai", new String[] {"restart", "when?"});

        assertEquals(1, gateway.chatCalls);
        Map<String, Object> root = lastRequest();
        assertEquals("system", Json.asObject(root.get("actor")).get("type"));
        assertTrue(consoleSink.contains("default answer"), consoleSink.messages.toString());
    }

    @Test
    void staffStatusShowsHealth() {
        playerPermissions.add(AiCommandExecutor.PERM_STAFF);
        gateway.healthStatus = new GatewayClient.HealthStatus(
                "ok", "0.1.0", "ok",
                List.of(new GatewayClient.Dependency("agent", "ok", null)));

        executor.onCommand(player, command, "ai", new String[] {"staff", "status"});

        assertTrue(playerSink.contains("Gateway status"), playerSink.messages.toString());
        assertTrue(playerSink.contains("agent"), playerSink.messages.toString());
    }

    @Test
    void staffStatusFailureShowsPlayerSafeError() {
        playerPermissions.add(AiCommandExecutor.PERM_STAFF);
        gateway.failure = new GatewayException.UnavailableException("down");

        executor.onCommand(player, command, "ai", new String[] {"staff", "status"});

        assertTrue(playerSink.contains("currently unavailable"), playerSink.messages.toString());
    }

    @Test
    void staffReloadCallsReloader() {
        playerPermissions.add(AiCommandExecutor.PERM_ADMIN);
        executor.onCommand(player, command, "ai", new String[] {"staff", "reload"});
        assertTrue(playerSink.contains("reloaded"), playerSink.messages.toString());
    }

    @Test
    void staffRatelimitClearUnknownPlayer() {
        playerPermissions.add(AiCommandExecutor.PERM_ADMIN);
        executor.onCommand(player, command, "ai",
                new String[] {"staff", "ratelimit", "clear", "Nobody"});
        assertTrue(playerSink.contains("not online"), playerSink.messages.toString());
    }

    @Test
    void clearRotatesConversation() {
        executor.onCommand(player, command, "ai", new String[] {"first"});
        String firstConv = conversations.conversationId(playerId);

        executor.onCommand(player, command, "ai", new String[] {"clear"});
        assertTrue(playerSink.contains("cleared"), playerSink.messages.toString());

        assertNotEquals(firstConv, conversations.conversationId(playerId));
        assertTrue(conversations.history(playerId).isEmpty());
    }

    @Test
    void historyShowsPastQuestions() {
        executor.onCommand(player, command, "ai", new String[] {"history"});
        assertTrue(playerSink.contains("haven't asked"), playerSink.messages.toString());

        executor.onCommand(player, command, "ai", new String[] {"what", "is", "the", "ip?"});
        executor.onCommand(player, command, "ai", new String[] {"history"});
        assertTrue(playerSink.contains("what is the ip?"), playerSink.messages.toString());
    }

    @Test
    void helpListsSubcommands() {
        playerPermissions.add(AiCommandExecutor.PERM_STAFF);
        playerPermissions.add(AiCommandExecutor.PERM_ADMIN);
        executor.onCommand(player, command, "ai", new String[] {"help"});
        assertTrue(playerSink.contains("staff ask"), playerSink.messages.toString());
        assertTrue(playerSink.contains("staff status"), playerSink.messages.toString());
    }

    @Test
    void tabCompleteSuggestsSubcommands() {
        playerPermissions.add(AiCommandExecutor.PERM_STAFF);
        List<String> completions = executor.onTabComplete(player, command, "ai", new String[] {"st"});
        assertEquals(List.of("staff"), completions);
    }

    @Test
    void tabCompleteStaffSubcommands() {
        playerPermissions.add(AiCommandExecutor.PERM_STAFF);
        playerPermissions.add(AiCommandExecutor.PERM_ADMIN);
        List<String> completions =
                executor.onTabComplete(player, command, "ai", new String[] {"staff", ""});
        assertTrue(completions.contains("ask"));
        assertTrue(completions.contains("status"));
        assertTrue(completions.contains("reload"));
        assertTrue(completions.contains("ratelimit"));
    }

    @Test
    void tabCompleteRatelimitClear() {
        playerPermissions.add(AiCommandExecutor.PERM_ADMIN);
        List<String> completions = executor.onTabComplete(player, command, "ai",
                new String[] {"staff", "ratelimit", ""});
        assertEquals(List.of("clear"), completions);
    }
}
