import { describe, expect, it } from 'vitest';
import { evaluateAllowList } from '../../src/cli-plane/allow-list.js';
import { encodeFrame, parseFrames } from '../../src/cli-plane/frames.js';
import { parseProbeOutput } from '../../src/cli-plane/status.js';

describe('evaluateAllowList', () => {
  it('allows argv when both lists are empty (explicitly trusted entry)', () => {
    expect(evaluateAllowList(['vm', 'list'], { allow: [], deny: [] })).toEqual({
      verdict: 'allow',
    });
  });

  it('denies when a deny rule matches, even if an allow rule also matches', () => {
    const rules = { allow: [['login']], deny: [['login']] };
    expect(evaluateAllowList(['login'], rules)).toMatchObject({ verdict: 'deny' });
  });

  it('matches allow rules as argv prefixes with * as a single-token wildcard', () => {
    const rules = { allow: [['vm', '*']], deny: [] };
    expect(evaluateAllowList(['vm', 'list', '-o', 'table'], rules)).toEqual({ verdict: 'allow' });
    expect(evaluateAllowList(['vm', 'list'], rules)).toEqual({ verdict: 'allow' });
    expect(evaluateAllowList(['account', 'show'], rules)).toMatchObject({ verdict: 'deny' });
  });

  it('denies when no allow rule matches a non-empty allow list', () => {
    const rules = { allow: [['account', 'show']], deny: [] };
    const verdict = evaluateAllowList(['account', 'list'], rules);
    expect(verdict.verdict).toBe('deny');
    if (verdict.verdict === 'deny') expect(verdict.reason).toContain('allow rule');
  });

  it('does not match a rule longer than argv', () => {
    const rules = { allow: [['webapp', 'log', 'tail', '*']], deny: [] };
    expect(evaluateAllowList(['webapp', 'log'], rules)).toMatchObject({ verdict: 'deny' });
  });
});

describe('probe output parsing', () => {
  it('extracts version and loggedIn from key=value lines', () => {
    expect(parseProbeOutput('version=azure-cli 2.61.0\nloggedIn=true\n')).toEqual({
      version: 'azure-cli 2.61.0',
      loggedIn: true,
    });
  });

  it('accepts logged_in and false values', () => {
    expect(parseProbeOutput('logged_in=false\n')).toEqual({ version: null, loggedIn: false });
  });

  it('defaults when keys are absent', () => {
    expect(parseProbeOutput('some noise\n')).toEqual({ version: null, loggedIn: false });
  });
});

describe('NDJSON frames', () => {
  it('round-trips frames through encode + parse', () => {
    const frames = [
      { type: 'stdout' as const, data: 'a\nb' },
      { type: 'stderr' as const, data: 'err' },
      { type: 'exit' as const, code: 0, durationMs: 123, result: 'ok' as const },
    ];
    const body = frames.map(encodeFrame).join('');
    expect(parseFrames(body)).toEqual(frames);
  });

  it('serializes the timeout exit frame with a null code', () => {
    const body = encodeFrame({ type: 'exit', code: null, durationMs: 99, result: 'timeout' });
    expect(parseFrames(body)).toEqual([
      { type: 'exit', code: null, durationMs: 99, result: 'timeout' },
    ]);
  });
});
