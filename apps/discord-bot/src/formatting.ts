/**
 * @enthusia/discord-bot — response formatting (W06).
 *
 * Owns:
 * - Discord-safe markdown (neutralize @everyone / @here so the bot can never
 *   be tricked into pinging a whole server — prompt-injection resistance,
 *   Master Specification §33);
 * - length limits: Discord caps messages at 2000 characters, so long
 *   responses are split into ordered chunks, preferring paragraph breaks and
 *   never breaking inside a code fence without closing/reopening it.
 */
import type { AgentResponse } from '@enthusia/contracts';

/** Discord's hard per-message character limit. */
export const DISCORD_MAX_MESSAGE_CHARS = 2000;

/** Zero-width space: breaks @everyone/@here without changing readability. */
const ZWSP = '​';

/** Neutralize mass mentions so the bot can never ping @everyone/@here. */
export function neutralizeMassMentions(text: string): string {
  return text.replace(/@(everyone|here)/g, `@${ZWSP}$1`);
}

/** Split points, most preferred first. */
const SPLIT_PATTERNS: RegExp[] = [/\n\n/, /\n/, /(?<=\s)/];

interface FenceState {
  inside: boolean;
  language: string;
}

/** Update code-fence tracking for one line (``` or ```lang toggles). */
function trackFence(line: string, state: FenceState): void {
  const match = /^```(\w*)\s*$/.exec(line.trim());
  if (match !== null) {
    if (!state.inside) {
      state.inside = true;
      state.language = match[1] ?? '';
    } else {
      state.inside = false;
      state.language = '';
    }
  }
}

/**
 * Split text into Discord-safe chunks of at most `maxChars` characters.
 *
 * Guarantees:
 * - no chunk exceeds `maxChars` (hard-splits overlong words when needed);
 * - splits prefer blank lines, then newlines, then spaces;
 * - a chunk never ends inside a code fence: the fence is closed at the end
 *   of the chunk and reopened (with its language) at the start of the next;
 * - mass mentions are neutralized in every chunk;
 * - at most `maxChunks` chunks; when the text does not fit, the final chunk
 *   is a truncation notice so the user knows the response was cut.
 */
export function splitIntoDiscordMessages(
  text: string,
  maxChars: number = DISCORD_MAX_MESSAGE_CHARS,
  maxChunks: number = 10,
): string[] {
  const cleaned = text.replace(/\s+$/u, '');
  if (cleaned.trim() === '') {
    return [];
  }
  const chunks: string[] = [];
  // Non-null while the split point is logically inside a code fence; the
  // next chunk must reopen it with this language.
  let fenceLanguage: string | null = null;
  let rest = cleaned;

  while (rest.length > 0 && chunks.length < maxChunks) {
    // Reserve room for a possible reopened fence and a closing fence so the
    // hard maxChars guarantee holds even in the worst case.
    const opener = fenceLanguage !== null ? `\`\`\`${fenceLanguage}\n` : '';
    const budget = Math.max(1, maxChars - opener.length - 4);
    const piece = rest.length <= budget ? rest : takeChunk(rest, budget);
    const moreAfter = rest.length > piece.length;

    // Fence state at the end of this piece.
    const fence: FenceState = { inside: fenceLanguage !== null, language: fenceLanguage ?? '' };
    for (const line of piece.split('\n')) {
      trackFence(line, fence);
    }

    let out = `${opener}${piece}`;
    if (fence.inside && moreAfter) {
      // Split inside a fence: close it here, reopen on the next chunk.
      out += '\n```';
      fenceLanguage = fence.language;
    } else {
      fenceLanguage = fence.inside ? fence.language : null;
    }

    chunks.push(neutralizeMassMentions(out.trim()));
    rest = rest.slice(piece.length).replace(/^\s+/, '');
  }

  if (rest.length > 0 && chunks.length > 0) {
    // The text did not fit: replace the final chunk with a truncation notice
    // so the total never exceeds maxChunks.
    chunks[chunks.length - 1] = '_Response truncated: the full answer was too long for Discord._';
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * Take a chunk of at most `maxChars` from the front of `text`, preferring
 * the latest split point (blank line > newline > space) within the budget.
 */
function takeChunk(text: string, maxChars: number): string {
  const window = text.slice(0, maxChars + 1);
  for (const pattern of SPLIT_PATTERNS) {
    // Find the last split point strictly inside the budget.
    let best = -1;
    let match: RegExpExecArray | null;
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    while ((match = re.exec(window)) !== null) {
      const end = match.index + match[0].length;
      if (end <= maxChars && end > best) {
        best = end;
      }
      if (match[0].length === 0) {
        re.lastIndex += 1;
      }
    }
    if (best > 0) {
      return text.slice(0, best);
    }
  }
  // No clean split point: hard-split (overlong word / URL / code line).
  return text.slice(0, maxChars);
}

/**
 * Format an AgentResponse for Discord: returns ordered message chunks.
 * Currently renders `response.text`; sources/escalation rendering stays
 * minimal until the agent (W12) defines richer surface contracts.
 */
export function formatAgentResponse(
  response: AgentResponse,
  maxChars: number = DISCORD_MAX_MESSAGE_CHARS,
  maxChunks: number = 10,
): string[] {
  const chunks = splitIntoDiscordMessages(response.text, maxChars, maxChunks);
  if (chunks.length === 0) {
    return ['_I received an empty response from the AI. Please try again._'];
  }
  return chunks;
}
