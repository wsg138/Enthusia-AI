/**
 * Offline, credential-free resolution smoke check for the local Node 24 test
 * runtime. Imports do not launch the agent, gateway, or Discord client.
 * Invoke with:
 * node --import deploy/local/workspace-source-resolver.mjs deploy/local/check-workspace-imports.mjs
 */
const modules = [
  '@enthusia/player-identity',
  '@enthusia/agent-core',
  '@enthusia/integration-ticket-bot',
  '@enthusia/integration-sftp',
  '@enthusia/integration-staff-moderation',
  '@enthusia/moderation-adapter',
  '@enthusia/ticket-evidence-review',
];
for (const name of modules) {
  await import(name);
  console.log('[test] imported ' + name);
}
console.log('[test] Workspace imports resolved without launching live services.');
