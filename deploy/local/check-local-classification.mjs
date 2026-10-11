/**
 * LOCAL TEST ONLY. One synthetic question with no private context.
 * Prints only the model's answer to the public, fixed test question.
 */
import { InferenceClient, loadInferenceConfig } from '@enthusia/inference-adapter';
import { InferenceReasoner } from '../../apps/agent-service/dist/reasoner.js';
import { Visibility } from '@enthusia/contracts';

const env = {
  NODE_ENV: 'development',
  'ENTHUSIA_SERVICE_NAME': 'enthusia-test-shape',
  ENTHUSIA_LOG_LEVEL: 'error',
  ENTHUSIA_INFERENCE_BASE_URL: 'http://127.0.0.1:11434',
  ENTHUSIA_INFERENCE_MODEL: 'qwen3:8b',
  ENTHUSIA_INFERENCE_THINKING_MODE: 'disabled',
  ENTHUSIA_INFERENCE_MAX_CONTEXT_TOKENS: '8192',
  ENTHUSIA_INFERENCE_MAX_OUTPUT_TOKENS: '1400',
};
const config = loadInferenceConfig(env);
const inference = new InferenceClient({ config });
const recordingClient = {
  complete: async (prompt, options) => {
    const result = await inference.complete(prompt, options);
    console.log('[shape] Synthetic classification model output:', String(result.content).slice(0, 6000));
    return result;
  },
};
const reasoner = new InferenceReasoner(recordingClient);
const request = {
  surface: 'discord',
  actor: { id: '100000000000000000', type: 'player', displayName: 'Synthetic test' },
  conversationId: 'discord:local-test:ai-testing',
  message: 'What can you do?',
  visibilityCeiling: Visibility.PUBLIC,
  context: { trigger: 'slash', isStaff: false },
};
try {
  const answer = await reasoner.classifyIntent(request);
  console.log('[shape] Classification accepted: ' + JSON.stringify(answer));
  const plan = await reasoner.planEvidence(request, answer, []);
  console.log('[shape] Evidence plan accepted: ' + JSON.stringify(plan));
} catch (error) {
  console.log('[shape] Classification rejected: ' + (error?.message ?? String(error)));
  process.exitCode = 1;
}
