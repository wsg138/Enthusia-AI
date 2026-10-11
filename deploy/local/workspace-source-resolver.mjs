/**
 * LOCAL TEST ONLY: load existing workspace packages whose package.json still
 * exports src/index.ts but whose TypeScript source uses NodeNext-style .js
 * relative specifiers. Node 24 can strip TS types, but it does not rewrite
 * './types.js' to './types.ts' automatically.
 *
 * Only fall back when Node reports ERR_MODULE_NOT_FOUND for a RELATIVE .js
 * specifier originating in a TypeScript source file under this repository's
 * own workspace source directories. Do not modify package/bare imports,
 * existing .js files, files outside repo, or production launch paths.
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const workspaceDirs = new Set(['packages', 'services', 'integrations', 'apps', 'training']);

function inWorkspaceSource(file) {
  const parts = relative(projectRoot, file).split(sep);
  return parts.length >= 4 && workspaceDirs.has(parts[0]) &&
    parts.includes('src') && parts[0] !== '..';
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' ||
          !context.parentURL?.startsWith('file:') ||
          !(specifier.startsWith('./') || specifier.startsWith('../')) ||
          !specifier.endsWith('.js')) {
        throw error;
      }
      const parent = fileURLToPath(context.parentURL);
      if (!parent.endsWith('.ts') || !inWorkspaceSource(parent)) throw error;

      const candidate = resolve(dirname(parent), specifier.slice(0, -3) + '.ts');
      if (!inWorkspaceSource(candidate) || !existsSync(candidate)) throw error;
      return nextResolve(pathToFileURL(candidate).href, context);
    }
  },
});
