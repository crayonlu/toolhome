import { describe, expect, it } from 'vitest';
import { createTestRuntime } from '../support/runtime.js';

describe('upstream shutdown', () => {
  it('cancels an in-flight stdio refresh before waiting for the refresh promise', async () => {
    const testRuntime = createTestRuntime();
    const server = testRuntime.runtime.store.createServer({
      slug: 'blocked',
      name: 'Blocked upstream',
      kind: 'home',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 2_500)'],
        env: {},
        protocolMode: 'auto',
      },
      credentialId: null,
      enabled: true,
      settings: {
        connectTimeoutMs: 15_000,
        requestTimeoutMs: 60_000,
        maxTotalTimeoutMs: 600_000,
        maxConcurrency: 1,
        restart: 'on-failure',
      },
    });

    const refresh = testRuntime.runtime.upstreams.refresh(server.id);
    await new Promise((resolve) => setTimeout(resolve, 100));

    let closePromise: Promise<void> | undefined;
    try {
      closePromise = testRuntime.runtime.close();
      const result = await Promise.race([
        closePromise.then(() => 'closed' as const),
        new Promise<'slow'>((resolve) => setTimeout(() => resolve('slow'), 2_000)),
      ]);
      expect(result).toBe('closed');
      await expect(refresh).rejects.toBeDefined();
    } finally {
      await closePromise?.catch(() => undefined);
    }
  });
});
