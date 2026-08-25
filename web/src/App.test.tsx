import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

describe('App routing', () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.pushState({}, '', '/');
    vi.restoreAllMocks();
  });

  it('opens a secure action URL without requiring a control key', async () => {
    window.history.pushState({}, '', '/market/actions/action-123?token=token-123');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          actionId: 'action-123',
          status: 'pending',
          entryId: 'gh-cli',
          entryName: 'GitHub CLI (gh)',
          fields: [{ name: 'GH_TOKEN', description: 'GitHub token' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Secure action' })).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/GH_TOKEN/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/secure-actions/action-123?token=token-123',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
  });
});
