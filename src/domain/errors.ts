export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function errorMessage(value: unknown): string {
  return toError(value).message;
}

/**
 * Error message including the `cause` chain. Node's undici reports transport
 * failures as a bare `fetch failed`, which hides the reason (for example
 * `connect ETIMEDOUT 104.18.6.5:443` or `getaddrinfo ENOTFOUND`) that the
 * nested cause carries. Falls back to `errorMessage` when there is no cause.
 */
export function errorMessageWithCause(value: unknown): string {
  const parts: string[] = [];
  let current: unknown = toError(value);
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const { message } = current;
    // Skip a message the accumulated text already carries, so a wrapper that
    // repeats its cause does not produce `fetch failed: fetch failed: ...`.
    if (message !== '' && !parts.some((part) => part.includes(message))) parts.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(': ');
}
