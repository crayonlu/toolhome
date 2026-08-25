const KEY_STORAGE = 'mch.controlKey';

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function getStoredKey(): string | null {
  return localStorage.getItem(KEY_STORAGE);
}

export function storeKey(key: string, remember: boolean) {
  if (remember) localStorage.setItem(KEY_STORAGE, key);
  else sessionStorage.setItem(KEY_STORAGE, key);
}

export function clearKey() {
  localStorage.removeItem(KEY_STORAGE);
  sessionStorage.removeItem(KEY_STORAGE);
}

function readKey(): string | null {
  return localStorage.getItem(KEY_STORAGE) ?? sessionStorage.getItem(KEY_STORAGE);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const key = readKey();
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Authorization'] = `Bearer ${key}`;

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 401) {
    clearKey();
    window.dispatchEvent(new Event('mch:unauthorized'));
    throw new ApiError(401, 'Unauthorized');
  }

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const envelope =
      typeof data === 'object' && data !== null && 'error' in data
        ? (data as { error?: unknown }).error
        : data;
    const message =
      typeof envelope === 'object' && envelope !== null && 'message' in envelope
        ? String((envelope as { message: unknown }).message)
        : `Request failed (${response.status})`;
    const code =
      typeof envelope === 'object' && envelope !== null && 'code' in envelope
        ? String((envelope as { code: unknown }).code)
        : undefined;
    throw new ApiError(response.status, message, code);
  }

  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string) => request<T>('PUT', path),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

/** POST a JSON body and collect an NDJSON response into parsed frames. */
export async function postNdjson<T>(path: string, body?: unknown): Promise<T[]> {
  const key = readKey();
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    const text = await response.text();
    let message = `Request failed (${response.status})`;
    let code: string | undefined;
    try {
      const data = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (data.error?.message) message = data.error.message;
      code = data.error?.code;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(response.status, message, code);
  }
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

export async function streamNdjson<T>(
  path: string,
  body: unknown,
  onFrame: (frame: T) => void,
  signal?: AbortSignal,
): Promise<void> {
  const key = readKey();
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    signal,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    let message = `Request failed (${response.status})`;
    let code: string | undefined;
    try {
      const data = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (data.error?.message) message = data.error.message;
      code = data.error?.code;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(response.status, message, code);
  }
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() !== '') onFrame(JSON.parse(line) as T);
    }
    if (done) break;
  }
  if (buffer.trim() !== '') onFrame(JSON.parse(buffer) as T);
}
