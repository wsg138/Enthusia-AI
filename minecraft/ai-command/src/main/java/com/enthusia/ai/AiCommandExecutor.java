package com.enthusia.ai;

import com.enthusia.ai.command.CommandParser;
import com.enthusia.ai.command.ParsedCommand;
import com.enthusia.ai.config.AiPluginConfig;
import com.enthusia.ai.core.AgentResponse;
import com.enthusia.ai.core.ChatRequestBuilder;
import com.enthusia.ai.core.ConversationManager;
import com.enthusia.ai.core.GatewayClient;
import com.enthusia.ai.core.GatewayException;
import com.enthusia.ai.core.MessageFormatter;
import com.enthusia.ai.core.RateLimiter;
import com.enthusia.ai.core.TaskRunner;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.logging.Logger;
import net.kyori.adventure.text.serializer.legacy.LegacyComponentSerializer;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.ConsoleCommandSender;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.Player;

/**
 * Handles {@code /ai} — the in-game surface for the Enthusia AI platform.
 *
 * <p>The plugin is intentionally thin (spec section 6.3): it authenticates the
 * sender, attaches player/server context, enforces per-player rate limits,
 * calls the AI Gateway asynchronously (never blocking the main thread), and
 * renders the answer as safe chat text. It performs no reasoning of its own.
 */
public class AiCommandExecutor implements CommandExecutor, TabCompleter {

    public static final String PERM_USE = "enthusia.ai.use";
    public static final String PERM_STAFF = "enthusia.ai.staff";
    public static final String PERM_ADMIN = "enthusia.ai.admin";

    /** Client-side cap on question length (well under the gateway byte limit). */
    static final int MAX_QUESTION_CHARS = 2000;

    private static final UUID CONSOLE_CONVERSATION_KEY =
            UUID.nameUUIDFromBytes("enthusia-ai:console".getBytes(java.nio.charset.StandardCharsets.UTF_8));

    private final Logger logger;
    private final ConversationManager conversations;
    private final TaskRunner tasks;
    private final PlayerLookup playerLookup;
    private final ConfigReloader configReloader;

    private volatile AiPluginConfig config;
    private volatile GatewayClient gateway;
    private volatile RateLimiter rateLimiter;

    /** Find an online player by exact name (null when absent). */
    @FunctionalInterface
    public interface PlayerLookup {
        Player findExact(String name);
    }

    /**
     * Reloads plugin configuration. Called for {@code /ai staff reload};
     * implemented by the plugin class (it owns the config lifecycle).
     */
    @FunctionalInterface
    public interface ConfigReloader {
        /** Reload and return a human-readable summary line. */
        String reload() throws Exception;
    }

    public AiCommandExecutor(Logger logger, AiPluginConfig config, GatewayClient gateway,
            RateLimiter rateLimiter, ConversationManager conversations,
            TaskRunner tasks, PlayerLookup playerLookup, ConfigReloader configReloader) {
        this.logger = logger;
        this.config = config;
        this.gateway = gateway;
        this.rateLimiter = rateLimiter;
        this.conversations = conversations;
        this.tasks = tasks;
        this.playerLookup = playerLookup;
        this.configReloader = configReloader;
    }

    /** Hot-swap config/gateway/rate-limiter after {@code /ai staff reload}. */
    public void reload(AiPluginConfig newConfig, GatewayClient newGateway, RateLimiter newRateLimiter) {
        this.config = newConfig;
        this.gateway = newGateway;
        this.rateLimiter = newRateLimiter;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        ParsedCommand parsed = CommandParser.parse(args);

        if (parsed.kind() == ParsedCommand.Kind.UNKNOWN) {
            sendUsage(sender, label);
            return true;
        }
        if (!hasPermission(sender, parsed)) {
            send(sender, "§cYou don't have permission to use that.");
            return true;
        }

        switch (parsed.kind()) {
            case HELP -> sendHelp(sender, label);
            case CLEAR -> handleClear(sender);
            case HISTORY -> handleHistory(sender);
            case STAFF_STATUS -> handleStatus(sender);
            case STAFF_RELOAD -> handleReload(sender);
            case STAFF_RATELIMIT_CLEAR -> handleRatelimitClear(sender, parsed.target());
            case ASK -> handleAsk(sender, parsed.question(), false);
            case STAFF_ASK -> handleAsk(sender, parsed.question(), true);
            default -> sendUsage(sender, label);
        }
        return true;
    }

    // --- ask flow ---

    private void handleAsk(CommandSender sender, String question, boolean staffQuery) {
        if (question == null || question.isBlank()) {
            sendUsage(sender, "ai");
            return;
        }
        if (question.length() > MAX_QUESTION_CHARS) {
            send(sender, "§c[AI] §rYour question is too long (max "
                    + MAX_QUESTION_CHARS + " characters).");
            return;
        }

        boolean isPlayer = sender instanceof Player;
        UUID actorId = isPlayer ? ((Player) sender).getUniqueId() : CONSOLE_CONVERSATION_KEY;

        // Per-player rate limit (spec section 19). Console bypasses it.
        if (isPlayer) {
            UUID playerId = ((Player) sender).getUniqueId();
            if (!rateLimiter.tryAcquire(playerId)) {
                long waitMs = rateLimiter.retryAfterMillis(playerId);
                long waitSec = Math.max(1, (waitMs + 999) / 1000);
                send(sender, "§e[AI] §rSlow down! You can ask again in " + waitSec + "s.");
                return;
            }
        }

        String conversationId = conversations.conversationId(actorId);
        Map<String, Object> context = buildContext(sender);
        ChatRequestBuilder.Visibility ceiling = staffQuery
                ? ChatRequestBuilder.Visibility.STAFF
                : (isPlayer ? ChatRequestBuilder.Visibility.PLAYER_SELF
                        : ChatRequestBuilder.Visibility.STAFF);

        final String requestJson;
        if (isPlayer) {
            Player player = (Player) sender;
            if (staffQuery) {
                requestJson = ChatRequestBuilder.buildStaffRequest(
                        player.getUniqueId(), player.getName(), conversationId,
                        question, context, ceiling);
            } else {
                requestJson = ChatRequestBuilder.buildPlayerRequest(
                        player.getUniqueId(), player.getName(), conversationId,
                        question, context, ceiling);
            }
        } else {
            requestJson = ChatRequestBuilder.buildConsoleRequest(
                    conversationId, question, context, ceiling);
        }

        send(sender, "§7[AI] Thinking…");
        if (config.isDebug()) {
            logger.info("[EnthusiaAI] /ai request trace for "
                    + sender.getName() + " (staff=" + staffQuery + ")");
        }

        final boolean staffView = staffQuery || sender instanceof ConsoleCommandSender;
        final String askedQuestion = question;
        tasks.runAsync(() -> {
            final AgentResponse response;
            try {
                response = gateway.chat(requestJson);
            } catch (GatewayException ex) {
                logger.warning("[EnthusiaAI] gateway call failed: " + ex.getMessage());
                tasks.runSync(() -> send(sender, MessageFormatter.formatError(ex)));
                return;
            }
            tasks.runSync(() -> {
                if (sender instanceof Player player && !player.isOnline()) {
                    return; // Player left while the AI was thinking.
                }
                List<String> lines = MessageFormatter.formatAnswer(
                        response, staffView, config.getMaxLineChars());
                for (String line : lines) {
                    send(sender, line);
                }
                if (!response.isEscalated()) {
                    conversations.recordExchange(actorId, askedQuestion, response.getText());
                }
            });
        });
    }

    private Map<String, Object> buildContext(CommandSender sender) {
        Map<String, Object> context = new LinkedHashMap<>();
        context.put("serverName", config.getServerName());
        if (sender instanceof Player player) {
            context.put("worldName", player.getWorld().getName());
            context.put("worldEnvironment", player.getWorld().getEnvironment().name());
            var loc = player.getLocation();
            context.put("playerLocation", loc.getBlockX() + "," + loc.getBlockY() + "," + loc.getBlockZ());
        } else {
            context.put("senderType", "console");
        }
        return context;
    }

    // --- staff subcommands ---

    private void handleStatus(CommandSender sender) {
        send(sender, "§7[AI] Checking gateway health…");
        tasks.runAsync(() -> {
            final GatewayClient.HealthStatus status;
            try {
                status = gateway.health();
            } catch (GatewayException ex) {
                logger.warning("[EnthusiaAI] health probe failed: " + ex.getMessage());
                tasks.runSync(() -> send(sender, MessageFormatter.formatError(ex)));
                return;
            }
            tasks.runSync(() -> {
                send(sender, "§b[AI] §rGateway status:");
                send(sender, "§7  Live: " + status.liveStatus()
                        + " §8(v" + status.version() + ")");
                send(sender, "§7  Ready: " + status.readyStatus());
                if (status.dependencies().isEmpty()) {
                    send(sender, "§7  Dependencies: none reported");
                } else {
                    send(sender, "§7  Dependencies:");
                    for (GatewayClient.Dependency dep : status.dependencies()) {
                        String line = "§7    • " + dep.name() + ": " + dep.status();
                        if (dep.detail() != null && !dep.detail().isBlank()) {
                            line += " §8(" + dep.detail() + ")";
                        }
                        send(sender, line);
                    }
                }
            });
        });
    }

    private void handleReload(CommandSender sender) {
        try {
            String summary = configReloader.reload();
            send(sender, "§b[AI] §r" + MessageFormatter.sanitize(summary));
        } catch (Exception ex) {
            logger.warning("[EnthusiaAI] config reload failed: " + ex.getMessage());
            send(sender, "§c[AI] §rReload failed: "
                    + MessageFormatter.sanitize(ex.getMessage()));
        }
    }

    private void handleRatelimitClear(CommandSender sender, String target) {
        Player targetPlayer = target == null ? null : playerLookup.findExact(target);
        if (targetPlayer == null) {
            send(sender, "§c[AI] §rPlayer '" + target + "' is not online.");
            return;
        }
        rateLimiter.clear(targetPlayer.getUniqueId());
        send(sender, "§b[AI] §rRate limit cleared for " + targetPlayer.getName() + ".");
        logger.info("[EnthusiaAI] rate limit cleared for "
                + targetPlayer.getName() + " by " + sender.getName());
    }

    private void handleClear(CommandSender sender) {
        UUID key = sender instanceof Player player
                ? player.getUniqueId()
                : CONSOLE_CONVERSATION_KEY;
        conversations.clear(key);
        send(sender, "§b[AI] §rConversation cleared — starting fresh.");
    }

    private void handleHistory(CommandSender sender) {
        UUID key = sender instanceof Player player
                ? player.getUniqueId()
                : CONSOLE_CONVERSATION_KEY;
        List<ConversationManager.Exchange> history = conversations.history(key);
        if (history.isEmpty()) {
            send(sender, "§7[AI] You haven't asked anything yet.");
            return;
        }
        send(sender, "§b[AI] §rYour recent questions:");
        int n = 1;
        for (ConversationManager.Exchange exchange : history) {
            send(sender, "§7" + n + ". " + MessageFormatter.sanitize(exchange.question()));
            if (!exchange.answerExcerpt().isBlank()) {
                for (String chunk : MessageFormatter.wrap(
                        "→ " + exchange.answerExcerpt(), config.getMaxLineChars())) {
                    send(sender, "§8   " + chunk);
                }
            }
            n++;
        }
    }

    // --- help / usage ---

    private void sendHelp(CommandSender sender, String label) {
        send(sender, "§b[AI] §rAsk the Enthusia AI anything about the server.");
        send(sender, "§7/" + label + " <question> §8- ask a question");
        send(sender, "§7/" + label + " history §8- show your recent questions");
        send(sender, "§7/" + label + " clear §8- start a new conversation");
        if (sender.hasPermission(PERM_STAFF) || sender instanceof ConsoleCommandSender) {
            send(sender, "§7/" + label + " staff ask <question> §8- staff-visibility query");
            send(sender, "§7/" + label + " staff status §8- check AI gateway health");
        }
        if (sender.hasPermission(PERM_ADMIN) || sender instanceof ConsoleCommandSender) {
            send(sender, "§7/" + label + " staff reload §8- reload plugin config");
            send(sender, "§7/" + label + " staff ratelimit clear <player> §8- reset rate limit");
        }
    }

    private void sendUsage(CommandSender sender, String label) {
        send(sender, "§cUsage: §7/" + label
                + " <question> §8| §7/" + label + " help");
    }

    private boolean hasPermission(CommandSender sender, ParsedCommand parsed) {
        if (sender instanceof ConsoleCommandSender) {
            return true;
        }
        if (parsed.isAdminCommand()) {
            return sender.hasPermission(PERM_ADMIN);
        }
        if (parsed.isStaffCommand()) {
            return sender.hasPermission(PERM_STAFF);
        }
        return sender.hasPermission(PERM_USE);
    }

    // --- tab completion ---

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String label, String[] args) {
        List<String> options = new ArrayList<>();
        if (args.length == 1) {
            options.add("help");
            options.add("ask");
            options.add("history");
            options.add("clear");
            if (sender.hasPermission(PERM_STAFF) || sender instanceof ConsoleCommandSender) {
                options.add("staff");
            }
        } else if (args.length == 2 && args[0].equalsIgnoreCase("staff")
                && (sender.hasPermission(PERM_STAFF) || sender instanceof ConsoleCommandSender)) {
            options.add("ask");
            options.add("status");
            if (sender.hasPermission(PERM_ADMIN) || sender instanceof ConsoleCommandSender) {
                options.add("reload");
                options.add("ratelimit");
            }
        } else if (args.length == 3 && args[0].equalsIgnoreCase("staff")
                && args[1].equalsIgnoreCase("ratelimit")
                && (sender.hasPermission(PERM_ADMIN) || sender instanceof ConsoleCommandSender)) {
            options.add("clear");
        }
        String prefix = args[args.length - 1].toLowerCase();
        List<String> matches = new ArrayList<>();
        for (String option : options) {
            if (option.startsWith(prefix)) {
                matches.add(option);
            }
        }
        return matches;
    }

    private void send(CommandSender sender, String legacyLine) {
        sender.sendMessage(LegacyComponentSerializer.legacySection().deserialize(legacyLine));
    }
}
