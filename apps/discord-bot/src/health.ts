/**
 * @enthusia/discord-bot — health reporting (W06).
 *
 * Master Specification §36: every service requires liveness/readiness
 * signals, structured logs, and dependency status. This module builds the
 * bot's health report; exposing it over HTTP (`/health/live`,
 * `/health/ready`) is deployment wiring owned by W21.
 */
import type { DiscordBotOptions } from './config.js';

/** Dependency status inside the health report. */
export interface HealthDependency {
  name: string;
  status: 'ok' | 'degraded' | 'down' | 'mock';
  detail?: string;
}

/** Health report for the Discord bot surface. */
export interface DiscordBotHealth {
  status: 'ok' | 'degraded';
  service: 'discord-bot';
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  botUserId: string | null;
  dependencies: HealthDependency[];
}

/**
 * Build a health report. `gatewayReachable` comes from a cheap gateway
 * probe. When no probe result is available yet, readiness is degraded rather
 * than claiming the dependency is healthy without evidence.
 */
export function buildHealthReport(params: {
  options: DiscordBotOptions;
  botUserId: string | null;
  version: string;
  uptimeSeconds: number;
  gatewayReachable?: boolean;
}): DiscordBotHealth {
  const gatewayDependency: HealthDependency = params.options.useMockGateway
    ? { name: 'ai-gateway', status: 'mock', detail: 'MockAiGatewayClient — W02 not connected' }
    : {
        name: 'ai-gateway',
        status:
          params.gatewayReachable === true
            ? 'ok'
            : params.gatewayReachable === false
              ? 'down'
              : 'degraded',
        detail:
          params.gatewayReachable === undefined
            ? `${params.options.gatewayBaseUrl} (not yet probed)`
            : params.options.gatewayBaseUrl,
      };
  const degraded =
    params.botUserId === null ||
    gatewayDependency.status === 'down' ||
    gatewayDependency.status === 'degraded';
  return {
    status: degraded ? 'degraded' : 'ok',
    service: 'discord-bot',
    version: params.version,
    uptimeSeconds: Math.max(0, Math.floor(params.uptimeSeconds)),
    timestamp: new Date().toISOString(),
    botUserId: params.botUserId,
    dependencies: [
      { name: 'discord-gateway', status: params.botUserId === null ? 'down' : 'ok' },
      gatewayDependency,
    ],
  };
}
