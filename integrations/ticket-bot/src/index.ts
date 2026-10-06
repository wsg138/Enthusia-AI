/**
 * @enthusia/integration-ticket-bot — Ticket Bot lifecycle integration (W14).
 *
 * Spec: MASTER-SPECIFICATION.md §6.2 (ticket support), §20 (Ticket Bot
 * separation and migration).
 *
 * Enthusia AI owns AI reasoning over tickets; the Ticket Bot owns ticket
 * lifecycle state and permissions. This package is the seam between them:
 *
 *   - `TicketBotClient` — typed HTTP client. Reads ticket state and
 *     submits ACTION REQUESTS. Direct state mutation is impossible by
 *     construction (see TICKET_BOT_REQUEST_ALLOWLIST).
 *   - `parseTicketEvent` / `TicketEventRouter` — consume ticket lifecycle
 *     events published by the Ticket Bot (one-directional: bot → AI).
 *   - `ticketToAgentContext` — pure adapter from ticket data to agent
 *     context (no I/O, no mutation).
 *   - `createTicketTools` — `ticket.capabilities`, `ticket.get_context`,
 *     `ticket.request_close`, `ticket.request_escalation` tools, shaped to W12's Tool interface.
 *
 * Migration strategy: see README.md. Do not implement the migration
 * itself here — this package only provides the integration contract.
 */

// Domain types
export type {
  Ticket,
  TicketCategory,
  TicketContextBundle,
  TicketContextFetchOptions,
  TicketMessage,
  TicketParticipant,
  TicketPriority,
  TicketStatus,
  TicketBotCapabilities,
  TicketEvidenceCapabilities,
  TicketImageEvidence,
  ActionRequestInput,
  ActionRequestKind,
  ActionRequestParameters,
  ActionRequestResult,
  ActionRequestStatus,
  ListMessagesOptions,
  ListTicketsOptions,
  Paginated,
} from './types.js';
export {
  ACTION_REQUEST_KINDS,
  TICKET_CATEGORIES,
  TICKET_STATUSES,
} from './types.js';

// Typed client (no-mutation invariant)
export {
  AI_REQUESTED_BY,
  TICKET_BOT_REQUEST_ALLOWLIST,
  TICKET_BOT_SERVICE,
  TicketBotClient,
  assertAllowedRequest,
} from './client.js';
export type { TicketBotClientConfig } from './client.js';

// Event consumption
export {
  TICKET_EVENT_TYPES,
  TICKET_STATE_EVENT_TYPES,
  TicketEventRouter,
  baseEventSchema,
  isTicketStateEvent,
  parseTicketEvent,
  verifyWebhookSignature,
} from './events.js';
export type { TicketEvent, TicketEventHandler, TicketEventType } from './events.js';

// Context adapter
export { ticketToAgentContext } from './context.js';
export type {
  AgentTicketContext,
  TicketContextAdapterOptions,
  TranscriptAttachment,
  TranscriptLine,
} from './context.js';

// Agent tools (W12 Tool-interface shape)
export {
  TicketCapabilitiesTool,
  GetTicketContextTool,
  RequestTicketCloseTool,
  RequestTicketEscalationTool,
  createTicketTools,
} from './tools.js';
export type {
  TicketTool,
  TicketToolCallContext,
  TicketToolMetadata,
  TicketToolParameterProperty,
  TicketToolParametersSchema,
} from './tools.js';
