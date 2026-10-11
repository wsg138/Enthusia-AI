export const APPROVED_REPOS: readonly string[];
export function knowledgeConfig(env?: Record<string, string | undefined>): {
  dir: string; port: number; token: string; apiKey: string;
};
export interface KnowledgeSidecar {
  start(port: number): Promise<void>;
  listen(port: number): Promise<number>;
  refresh(): Promise<boolean>;
  search(question: string): Promise<Array<{
    text: string; sourceLocator: string; version: string; artifactId: string;
    status: string; score: number; deploymentVerified: false;
  }> | null>;
  close(): Promise<void>;
  fresh(): boolean;
  registry: {
    getCurrent(locator: string): { version: string; visibility: string } | undefined;
  };
  retrieval: { indexedCount(): number };
}
export function createKnowledgeStaging(options: {
  dir: string; apiKey: string;
  client: import('../../integrations/github/src/github-client.js').GitHubApi;
}): Promise<KnowledgeSidecar>;
