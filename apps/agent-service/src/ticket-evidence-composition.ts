import type { InferenceClient } from '@enthusia/inference-adapter';
import { StaffModerationStateClient } from '@enthusia/integration-staff-moderation';
import type {
  SftpRuntime,
  TicketBotRuntime,
} from './runtime.js';
import type { AgentServiceConfig } from './config.js';
import { TicketEventIngress } from './ticket-event-ingress.js';
import { TicketEvidenceReviewRuntime } from './ticket-evidence-runtime.js';

export interface TicketEvidenceComposition {
  reviewer?: TicketEvidenceReviewRuntime;
  ingress?: TicketEventIngress;
}

export function composeTicketEvidenceRuntime(
  config: AgentServiceConfig,
  inference: Pick<InferenceClient, 'complete'>,
  ticket: TicketBotRuntime,
  sftp: SftpRuntime,
): TicketEvidenceComposition {
  if (!config.ticketEvidenceEnabled) return {};

  const ticketClient = required(ticket.client, 'Ticket Bot client');
  const evidenceClient = required(
    ticket.evidenceClient,
    'Ticket Bot evidence client',
  );
  const gateway = required(sftp.gateway, 'live SFTP source gateway');
  const staffBaseUrl = required(
    config.staffModerationBaseUrl,
    'EnthusiaStaff moderation base URL',
  );
  const staffApiKey = required(
    config.staffModerationApiKey,
    'EnthusiaStaff moderation API key',
  );
  const policyServerId = required(
    config.ticketEvidencePolicyServerId,
    'ticket evidence policy server id',
  );
  const policySourceId = required(
    config.ticketEvidencePolicySourceId,
    'ticket evidence policy source id',
  );
  const webhookSecret = required(
    config.ticketWebhookSecret,
    'ticket event webhook secret',
  );

  const staffClient = new StaffModerationStateClient({
    baseUrl: staffBaseUrl,
    apiKey: staffApiKey,
    timeoutMs: config.staffModerationTimeoutMs,
  });
  const reviewer = new TicketEvidenceReviewRuntime({
    ticketClient,
    evidenceClient,
    staffClient,
    policyGateway: gateway,
    policySource: {
      serverId: policyServerId,
      sourceId: policySourceId,
    },
    inference,
  });
  return {
    reviewer,
    ingress: new TicketEventIngress(webhookSecret, reviewer),
  };
}

function required<T>(
  value: T | undefined,
  label: string,
): T {
  if (value !== undefined) return value;
  throw new Error('Ticket evidence runtime requires ' + label + '.');
}
