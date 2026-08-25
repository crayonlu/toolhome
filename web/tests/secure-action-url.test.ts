import { describe, expect, it } from 'vitest';
import { toConsoleActionUrl } from '../src/features/market/secure-action-url';

describe('toConsoleActionUrl', () => {
  it('keeps the secure action path and token on the current console origin', () => {
    expect(
      toConsoleActionUrl(
        'http://127.0.0.1:3344/market/actions/action-1?token=secret',
        'http://127.0.0.1:5173',
      ),
    ).toBe('http://127.0.0.1:5173/market/actions/action-1?token=secret');
  });
});
