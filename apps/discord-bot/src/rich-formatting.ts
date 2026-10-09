/** Safe, compact Discord embeds for already-verified Agent responses. */
import type { AgentResponse } from '@enthusia/contracts';
import type { DiscordRichResponse } from './types.js';
import { neutralizeMassMentions } from './formatting.js';

const OFFICIAL_WIKI = 'https://enthusia.miraheze.org/wiki/Main_Page';
const MAX_DESCRIPTION = 3300;
const HEX_ORANGE = 0xf47c24;
const HEX_BLUE = 0x3989c9;
const PIECLOAK_SOURCE = /^github:wsg138\/PieCloak@([a-f0-9]{40}):README\.md$/;
const WARZONE_SOURCE = /^github:wsg138\/MaceGuard@([a-f0-9]{40}):README\.md$/;

/**
 * Only link a verified public, explicitly enumerated source. The public wiki
 * entry is the official landing page; do not invent a feature article slug.
 * The pinned README remains the proof for each documented PieCloak rule.
 */
export function formatRichAgentResponse(response: AgentResponse): DiscordRichResponse | null {
  const source = response.sources.find((s) => typeof s.artifactId === 'string' && PIECLOAK_SOURCE.test(s.artifactId));
  const match = source?.artifactId ? PIECLOAK_SOURCE.exec(source.artifactId) : null;
  const isPieCloak = match !== null && match !== undefined;
  const wzSource = response.sources.find((s) => typeof s.artifactId === 'string' && WARZONE_SOURCE.test(s.artifactId));
  const wzMatch = wzSource?.artifactId ? WARZONE_SOURCE.exec(wzSource.artifactId) : null;
  const isWarzone = wzMatch !== null;
  let description = response.text.trim();
  if (!description || description.length > 6000 || description.includes(String.fromCharCode(96).repeat(3))) return null;
  const fields: NonNullable<DiscordRichResponse['embed']['fields']> = [];
  if (isPieCloak || isWarzone) {
    // Provenance is carried by response.sources, not by an untrusted literal
    // URL appearing in model-produced prose.
    description = description
      .replace(/\nSource:\s*https:\/\/github\.com\/wsg138\/PieCloak\/blob\/[a-f0-9]{40}\/README\.md/gi, '')
      .replace(/\nDocumentation revision:\s*[a-f0-9]{12}\./gi, '')
      .trim();
    description = description
      .replace(/\nSource:\s*https:\/\/github\.com\/wsg138\/MaceGuard\/blob\/[a-f0-9]{40}\/README\.md/gi, '')
      .replace(/\nDocumentation revision:\s*[a-f0-9]{12}\./gi, '')
      .trim();
    const technicalUrl = isPieCloak && match
      ? 'https://github.com/wsg138/PieCloak/blob/' + match[1] + '/README.md'
      : 'https://github.com/wsg138/MaceGuard/blob/' + wzMatch![1] + '/README.md';
    fields.push({
      name: 'More information',
      value: '[Enthusia Wiki](' + OFFICIAL_WIKI + ')  •  [Technical source](' + technicalUrl + ')',
    });
  }
  if (description.length > MAX_DESCRIPTION) return null;
  return {
    embed: {
      title: isPieCloak ? '🛡️ PieCloak • Base protection' :
        isWarzone ? '⚔️ Warzones • Combat rotation' : 'Enthusia AI',
      description: neutralizeMassMentions(description),
      color: isPieCloak || isWarzone ? HEX_ORANGE : HEX_BLUE,
      ...(fields.length ? { fields } : {}),
      footer: {
        text: isPieCloak || isWarzone
          ? 'Based on public documentation • Live server version not verified'
          : 'Enthusia AI • Answers may be limited by available sources',
      },
    },
  };
}
