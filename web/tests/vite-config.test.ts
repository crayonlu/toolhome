import { describe, expect, it } from 'vitest';
import config from '../vite.config';

describe('Vite development proxy', () => {
  it('proxies hosted CLI data-plane requests to the backend', () => {
    const proxy = config.server?.proxy as Record<string, unknown> | undefined;

    expect(proxy?.['/cli/']).toBeDefined();
    expect(proxy?.['/clis']).toBeUndefined();
  });
});
