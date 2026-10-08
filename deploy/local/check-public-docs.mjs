/** Credential-free read-only public source check. Never logs source text. */
import { PieCloakPublicDocsPilot } from '../../apps/agent-service/dist/public-docs.js';
import { Visibility } from '@enthusia/contracts';

const pilot = new PieCloakPublicDocsPilot();
const answer = await pilot.resolve({
  surface: 'discord', actor: { id: 'test-only', type: 'player' },
  conversationId: 'discord:isolated:ai-testing',
  message: 'How does the pie cloak system work on the server?',
  visibilityCeiling: Visibility.PUBLIC,
  traceId: '123e4567-e89b-12d3-a456-426614174000',
});
if (!answer || answer.sources.length !== 1 ||
    !answer.text.includes('documented settings') ||
    !answer.text.includes('github.com/wsg138/PieCloak/blob/')) {
  console.error('[docs] Public GitHub source could not be verified; pilot remains fail-closed.');
  process.exitCode = 1;
} else {
  console.log('[docs] Verified public source: ' + answer.sources[0]?.description);
  console.log('[docs] Safe player reply: ' + answer.text);
}
