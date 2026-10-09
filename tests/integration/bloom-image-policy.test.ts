import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Policy checks only. These do not claim the image compiles or can be
 * provisioned in Bloom; an actual Docker build remains a deployment gate.
 */
const dockerfile = readFileSync(resolve('deploy/bloom/Dockerfile.single-staging'), 'utf8');
const ignores = readFileSync(resolve(
  'deploy/bloom/Dockerfile.single-staging.dockerignore'), 'utf8');

describe('single-container Bloom staging image policy (static only)', () => {
  it('requires an operator-selected pinned llama.cpp source commit', () => {
    expect(dockerfile).toContain('ARG LLAMA_CPP_COMMIT');
    expect(dockerfile).toContain("grep -Eq '^[0-9a-fA-F]{40}$'");
    expect(dockerfile).toContain('git checkout --detach FETCH_HEAD');
    expect(dockerfile).toContain('LLAMA_BUILD_SERVER=ON');
  });

  it('keeps Node 24 and a local non-WebUI llama-server in one runtime image', () => {
    expect(dockerfile).toContain('FROM node:24-bookworm-slim AS staging-runtime');
    expect(dockerfile).toContain('COPY --from=inference-build');
    expect(dockerfile).toContain('llama-server /usr/local/bin/llama-server');
    expect(dockerfile).toContain('LLAMA_BUILD_UI=OFF');
    expect(dockerfile).toContain('--managed-inference');
    expect(dockerfile).toContain('--without-discord');
    expect(dockerfile).not.toContain('DISCORD_BOT_TOKEN=');
    expect(dockerfile).not.toContain('SFTP_PASSWORD=');
  });

  it('does not bake models or local secrets into the image', () => {
    for (const pattern of [
      '.git', '**/.env', '**/.env.*', '**/*.pem', '**/*.key',
      '**/*.gguf', '**/*.safetensors', '**/node_modules/**',
    ]) expect(ignores).toContain(pattern);
    expect(dockerfile).not.toContain('COPY models/');
    expect(dockerfile).not.toContain('ARG OPENAI_API_KEY');
    expect(dockerfile).not.toContain('ARG DISCORD_BOT_TOKEN');
  });

  it('reuses the Node image non-root account without conflicting UID 1000', () => {
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('chown -R node:node /home/container');
    expect(dockerfile).not.toContain('groupadd --gid 1000');
    expect(dockerfile).not.toContain('useradd --uid 1000');
    expect(dockerfile).toContain('ENV NODE_ENV=development');
    expect(dockerfile).toContain('ENTHUSIA_BLOOM_STAGING=1');
    expect(dockerfile).toContain('CPU and memory limits MUST be enforced');
  });

  it('uses the upstream llama.cpp UI build flag rather than ignored CMake options', () => {
    expect(dockerfile).toContain('LLAMA_BUILD_SERVER=ON');
    expect(dockerfile).toContain('LLAMA_BUILD_UI=OFF');
    expect(dockerfile).not.toContain('LLAMA_BUILD_WEBUI=');
    expect(dockerfile).not.toContain('LLAMA_USE_PREBUILT_WEBUI=');
  });
});
