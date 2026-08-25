import { describe, expect, it } from 'vitest';
import { isInstallPending, isInstallSuccessful } from '../src/features/market/install-job';

describe('isInstallPending', () => {
  it('keeps polling while a secure action is awaiting its secret', () => {
    expect(isInstallPending('awaiting_secret')).toBe(true);
    expect(isInstallPending('installing')).toBe(true);
  });

  it('stops polling after a terminal install state', () => {
    expect(isInstallPending('completed')).toBe(false);
    expect(isInstallPending('failed')).toBe(false);
    expect(isInstallPending('interrupted')).toBe(false);
  });
});

describe('isInstallSuccessful', () => {
  it('only treats completed jobs as successful', () => {
    expect(isInstallSuccessful('completed')).toBe(true);
    expect(isInstallSuccessful('failed')).toBe(false);
    expect(isInstallSuccessful('interrupted')).toBe(false);
  });
});
