import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { usePlane, type Plane } from './plane';

describe('usePlane', () => {
  afterEach(() => {
    localStorage.removeItem('mch.plane');
  });

  it('defaults to the MCP plane', () => {
    const { result } = renderHook(() => usePlane());
    expect(result.current.plane).toBe('mcp');
  });

  it('persists a switch and notifies every subscriber', () => {
    localStorage.setItem('mch.plane', 'cli');
    const first = renderHook(() => usePlane());
    const second = renderHook(() => usePlane());
    expect(first.result.current.plane).toBe('cli');

    act(() => first.result.current.setPlane('mcp'));
    expect(first.result.current.plane).toBe('mcp');
    expect(second.result.current.plane).toBe('mcp');
    expect(localStorage.getItem('mch.plane')).toBe('mcp');
  });

  it('keeps only valid plane values', () => {
    localStorage.setItem('mch.plane', 'bogus');
    const { result } = renderHook(() => usePlane());
    expect(result.current.plane).toBe<Plane>('mcp');
  });
});
