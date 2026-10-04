import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/server';
import { CompactState, compactContractFingerprint } from '../../src/data-plane/compact-state.js';

const tool: Tool = { name: 'echo', inputSchema: { type: 'object' } };

describe('compact process-local state', () => {
  it('isolates observations by principal/profile and invalidates revisions', () => {
    const state = new CompactState();
    expect(state.observe('alice/profile/tool', 'server', 'revision1', tool)).toBe(true);
    expect(state.observed('bob/profile/tool', 'revision1')).toBeUndefined();
    expect(state.observed('alice/profile/tool', 'revision1')).toEqual(tool);
    expect(state.observed('alice/profile/tool', 'revision2')).toBeUndefined();
    expect(state.observed('alice/profile/tool', 'revision1')).toBeUndefined();
    expect(
      state.observe('large', 'server', 'revision', { ...tool, description: 'x'.repeat(300_000) }),
    ).toBe(false);
  });

  it('expires retained invocations and terminates pending work once', async () => {
    vi.useFakeTimers();
    try {
      const state = new CompactState();
      const terminate = vi.fn(async () => {});
      const pending = state.retain(
        {
          key: 'principal/profile',
          serverId: 'server',
          exposedTool: 'server_echo',
          tool,
          arguments: { value: 42 },
          definition: compactContractFingerprint(tool),
          revision: 'rev',
          upstreamRequestState: 'original',
        },
        100,
        terminate,
      );
      expect(pending).not.toBeNull();
      expect(state.invocation(pending!.id)?.arguments).toEqual({ value: 42 });
      await vi.advanceTimersByTimeAsync(101);
      expect(state.invocation(pending!.id)).toBeUndefined();
      expect(terminate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(terminate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases completed invocations without termination and fingerprints instructions', async () => {
    vi.useFakeTimers();
    try {
      const state = new CompactState();
      const terminate = vi.fn(async () => {});
      const pending = state.retain(
        {
          key: 'p',
          serverId: 's',
          exposedTool: 's_echo',
          tool,
          arguments: {},
          definition: compactContractFingerprint(tool),
          revision: 'r',
        },
        100,
        terminate,
      )!;
      state.release(pending.id);
      await vi.advanceTimersByTimeAsync(200);
      expect(terminate).not.toHaveBeenCalled();
      expect(compactContractFingerprint(tool, 'instructions')).not.toBe(
        compactContractFingerprint(tool),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
