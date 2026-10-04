package com.enthusia.ai;

import com.enthusia.ai.config.AiPluginConfig;
import com.enthusia.ai.core.ConversationManager;
import com.enthusia.ai.core.ExecutorTaskRunner;
import com.enthusia.ai.core.GatewayClient;
import com.enthusia.ai.core.RateLimiter;
import com.enthusia.ai.core.TaskRunner;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import org.bukkit.Bukkit;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * Enthusia AI — in-game {@code /ai} command.
 *
 * <p>Lifecycle: load config, build the thin gateway client stack, register
 * the command. All gateway I/O happens off the main thread; nothing here
 * performs AI reasoning (spec sections 6.3, 19; W22).
 */
public class EnthusiaAiPlugin extends JavaPlugin {

    private AiPluginConfig config;
    private GatewayClient gateway;
    private RateLimiter rateLimiter;
    private ConversationManager conversations;
    private TaskRunner tasks;
    private AiCommandExecutor executor;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        conversations = new ConversationManager();
        applyRuntimeStack(buildRuntimeStack());
        tasks = new ExecutorTaskRunner(
                2, task -> Bukkit.getScheduler().runTask(EnthusiaAiPlugin.this, task));

        executor = new AiCommandExecutor(
                getLogger(),
                config,
                gateway,
                rateLimiter,
                conversations,
                tasks,
                name -> Bukkit.getPlayerExact(name),
                this::reloadPlugin);

        var command = Objects.requireNonNull(getCommand("ai"), "/ai command missing from plugin.yml");
        command.setExecutor(executor);
        command.setTabCompleter(executor);

        getLogger().info("EnthusiaAI enabled — gateway: " + config.getGatewayBaseUrl()
                + ", rate limit: " + config.getRateLimitPerMinute() + "/min");
    }

    @Override
    public void onDisable() {
        if (tasks != null) {
            tasks.close();
        }
        Bukkit.getScheduler().cancelTasks(this);
        if (conversations != null) {
            conversations.clearAll();
        }
        getLogger().info("EnthusiaAI disabled.");
    }

    /** Build a complete replacement runtime stack before mutating live fields. */
    private RuntimeStack buildRuntimeStack() {
        AiPluginConfig nextConfig = AiPluginConfig.fromNestedMap(flatten(getConfig()));
        GatewayClient nextGateway = new GatewayClient(
                nextConfig.getGatewayBaseUrl(),
                nextConfig.getGatewayApiKey(),
                nextConfig.getGatewayTimeout());
        RateLimiter nextRateLimiter = new RateLimiter(nextConfig.getRateLimitPerMinute());
        return new RuntimeStack(nextConfig, nextGateway, nextRateLimiter);
    }

    private void applyRuntimeStack(RuntimeStack next) {
        config = next.config();
        gateway = next.gateway();
        rateLimiter = next.rateLimiter();
    }

    /**
     * Reload triggered by {@code /ai staff reload}. Returns a summary line
     * for chat; throws when the new config is invalid.
     */
    private String reloadPlugin() throws Exception {
        reloadConfig();
        RuntimeStack next = buildRuntimeStack();
        applyRuntimeStack(next);
        executor.reload(next.config(), next.gateway(), next.rateLimiter());
        getLogger().info("EnthusiaAI config reloaded — gateway: " + config.getGatewayBaseUrl()
                + ", rate limit: " + config.getRateLimitPerMinute() + "/min");
        return "Configuration reloaded (gateway " + config.getGatewayBaseUrl()
                + ", " + config.getRateLimitPerMinute() + "/min per player).";
    }

    private record RuntimeStack(
            AiPluginConfig config, GatewayClient gateway, RateLimiter rateLimiter) {
    }

    /** Convert a Bukkit ConfigurationSection tree into nested plain maps. */
    private static Map<String, Object> flatten(ConfigurationSection section) {
        Map<String, Object> map = new HashMap<>();
        for (String key : section.getKeys(false)) {
            Object value = section.get(key);
            if (value instanceof ConfigurationSection child) {
                map.put(key, flatten(child));
            } else if (value instanceof Duration d) {
                map.put(key, d.toMillis());
            } else {
                map.put(key, value);
            }
        }
        return map;
    }
}
