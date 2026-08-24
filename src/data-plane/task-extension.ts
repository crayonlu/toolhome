import { PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';

const internalPrefix = 'toolhome.internal/tasks/';
const taskMethods = new Set(['tasks/get', 'tasks/update', 'tasks/cancel']);

export interface AdaptedTaskRequest {
  request: Request;
  body: unknown;
}

export function canonicalTaskMethod(method: string): string | null {
  if (taskMethods.has(method)) return method;
  if (!method.startsWith(internalPrefix)) return null;
  const canonical = `tasks/${method.slice(internalPrefix.length)}`;
  return taskMethods.has(canonical) ? canonical : null;
}

export function adaptModernTaskRequest(request: Request, body: unknown): AdaptedTaskRequest {
  if (!isRecord(body) || typeof body.method !== 'string') return { request, body };
  const canonical = canonicalTaskMethod(body.method);
  if (!canonical || body.method.startsWith(internalPrefix)) return { request, body };
  if (!isRecord(body.params) || !isRecord(body.params._meta)) return { request, body };
  if (body.params._meta[PROTOCOL_VERSION_META_KEY] !== '2026-07-28') return { request, body };
  const internalMethod = `${internalPrefix}${canonical.slice('tasks/'.length)}`;
  const headers = new Headers(request.headers);
  headers.set('mcp-method', internalMethod);
  return {
    request: new Request(request, { headers }),
    body: { ...body, method: internalMethod },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
