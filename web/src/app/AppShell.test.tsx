import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

const overview = {
  servers: { total: 3, enabled: 3, remote: 2, home: 1, ready: 2, unhealthy: 1 },
  clis: { total: 2, enabled: 2 },
  credentials: 5,
  accessKeys: 2,
  controlKeys: 1,
  endpoints: { aggregate: 'https://tool.example.com/mcp', individual: {} },
  ok: true,
};

/** Every read the shell and its pages can issue, served from one stub. */
function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    const body = url.startsWith('/api/v1/overview') ? overview : [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

beforeEach(() => {
  localStorage.setItem('mch.controlKey', 'tch_ctl_test');
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.pushState({}, '', '/');
  vi.restoreAllMocks();
});

describe('console navigation', () => {
  it('exposes exactly the six console destinations in the sidebar', async () => {
    mockFetch();
    const { container } = render(<App />);
    await screen.findByRole('heading', { name: 'Overview' });

    const nav = container.querySelector('aside nav');
    expect(nav).not.toBeNull();
    const labels = within(nav as HTMLElement)
      .getAllByRole('link')
      .map((link) => link.textContent?.trim());

    // Endpoints, Diagnostics, Events and Access Keys are folded into these.
    expect(labels).toEqual(['Overview', 'Servers', 'Calls', 'Market', 'Credentials', 'Settings']);
  });

  it.each([
    ['/events', 'Calls', '/calls'],
    ['/access-keys', 'Settings', '/settings'],
    ['/diagnostics', 'Servers', '/servers'],
    ['/endpoints', 'Overview', '/'],
  ])('redirects the folded route %s to %s', async (path, heading, destination) => {
    mockFetch();
    window.history.pushState({}, '', path);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    });
    expect(window.location.pathname).toBe(destination);
  });
});
