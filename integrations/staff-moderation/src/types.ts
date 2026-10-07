export interface StaffModerationTarget {
  requested: string;
  playerId: string;
  username?: string | null | undefined;
  moderationSubjectId?: string | null | undefined;
}

export interface StaffActiveSanction {
  sanctionId: string;
  caseId: string;
  type: string;
  publicReason: string;
  issuedAt: string;
  expiresAt?: string | null | undefined;
}

export interface StaffModerationCase {
  caseId: string;
  exactReasonId: string;
  sanctionFamily: string;
  state: string;
  publicReason: string;
  issuedAt: string;
  hasActiveSanctions: boolean;
  configurationVersion: string;
}

export interface StaffModerationStateSnapshot {
  service: 'enthusia-staff';
  api: 'ai-moderation-state';
  contractVersion: 'v1' | 'v2';
  target: StaffModerationTarget;
  activeSanctions: StaffActiveSanction[];
  recentCases: StaffModerationCase[];
  fetchedAt: string;
}

export interface StaffModerationClientConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}
