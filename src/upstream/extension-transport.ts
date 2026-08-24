import { JSONRPCRequestSchema } from '@modelcontextprotocol/core';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  isJSONRPCErrorResponse,
  isJSONRPCResponse,
  isJSONRPCResultResponse,
  type ClientCapabilities,
  type FetchLike,
  type JSONRPCMessage,
  type RequestId,
  type RequestOptions,
  type Transport,
} from '@modelcontextprotocol/client';
import { randomUUID } from 'node:crypto';
import { AppError } from '../domain/errors.js';

const originalTaskResultKey = 'toolhome.dev/originalTaskResult';
const taskMethods = new Set(['tasks/get', 'tasks/update', 'tasks/cancel']);

interface ExtensionRequest {
  method: string;
  params?: Record<string, unknown> | undefined;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

export class ExtensionTransportBridge {
  readonly #pending = new Map<RequestId, PendingRequest>();
  readonly #handler: NonNullable<Transport['onmessage']>;
  readonly #transport: Transport;
  readonly #protocolVersion: string;
  readonly #clientCapabilities: ClientCapabilities;
  #closed = false;

  constructor(
    transport: Transport,
    protocolVersion: string,
    clientCapabilities: ClientCapabilities,
  ) {
    this.#transport = transport;
    this.#protocolVersion = protocolVersion;
    this.#clientCapabilities = clientCapabilities;
    const handler = this.#transport.onmessage;
    if (!handler) throw new Error('MCP transport message handler is unavailable');
    this.#handler = handler;
    this.#transport.onmessage = (message, extra) => {
      if (isJSONRPCResponse(message) && message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (pending) {
          this.#pending.delete(message.id);
          pending.cleanup();
          if (isJSONRPCErrorResponse(message)) {
            pending.reject(
              new AppError('upstream_jsonrpc_error', message.error.message, 502, {
                code: message.error.code,
                ...(message.error.data === undefined ? {} : { data: message.error.data }),
              }),
            );
          } else {
            pending.resolve(message.result);
          }
          return;
        }
      }
      this.#handler(maskTaskResult(message), extra);
    };
  }

  async request(request: ExtensionRequest, options: RequestOptions): Promise<unknown> {
    if (this.#closed) throw new AppError('upstream_closed', 'Upstream transport is closed', 503);
    const id = `toolhome-extension-${randomUUID()}`;
    const metadata = isRecord(request.params?._meta) ? request.params._meta : {};
    const message = JSONRPCRequestSchema.parse({
      jsonrpc: '2.0',
      id,
      method: request.method,
      params: {
        ...request.params,
        _meta: {
          ...metadata,
          [PROTOCOL_VERSION_META_KEY]: this.#protocolVersion,
          [CLIENT_INFO_META_KEY]: { name: 'toolhome', version: '0.1.0' },
          [CLIENT_CAPABILITIES_META_KEY]: this.#clientCapabilities,
        },
      },
    });
    const controller = new AbortController();
    const timeout = Math.min(
      options.timeout ?? 60_000,
      options.maxTotalTimeout ?? Number.POSITIVE_INFINITY,
    );
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        action();
      };
      const onAbort = (): void => {
        controller.abort(options.signal?.reason);
        this.#pending.delete(id);
        cleanup();
        settle(() => reject(new AppError('request_cancelled', 'MCP request was cancelled', 499)));
        if (!this.#transport.hasPerRequestStream) {
          void this.#transport.send({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: id, reason: 'Downstream request cancelled' },
          });
        }
      };
      const timer = setTimeout(() => {
        controller.abort('timeout');
        this.#pending.delete(id);
        cleanup();
        settle(() => reject(new AppError('upstream_timeout', 'Upstream request timed out', 504)));
      }, timeout);
      const cleanup = (): void => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      this.#pending.set(id, {
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(error)),
        cleanup,
      });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      void this.#transport
        .send(message, {
          requestSignal: controller.signal,
          onRequestStreamEnd: () => {
            const pending = this.#pending.get(id);
            if (!pending) return;
            this.#pending.delete(id);
            pending.cleanup();
            pending.reject(
              new AppError('upstream_stream_ended', 'Upstream response stream ended early', 502),
            );
          },
        })
        .catch((error) => {
          const pending = this.#pending.get(id);
          if (!pending) return;
          this.#pending.delete(id);
          pending.cleanup();
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  close(): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(new AppError('upstream_closed', 'Upstream transport closed', 503));
    }
    this.#pending.clear();
  }
}

export function isTaskExtensionMethod(method: string): boolean {
  return taskMethods.has(method);
}

export function withTaskHeaderFetch(fetchFn: FetchLike): FetchLike {
  return async (input, init) => {
    const taskId = taskIdFromBody(init?.body);
    if (taskId === null) return fetchFn(input, init);
    const headers = new Headers(init?.headers);
    headers.set('mcp-name', encodeHeaderValue(taskId));
    return fetchFn(input, { ...init, headers });
  };
}

export const extensionFetch: FetchLike = withTaskHeaderFetch(globalThis.fetch);

export function restoreTaskResult(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value._meta)) return value;
  const original = value._meta[originalTaskResultKey];
  return isRecord(original) ? original : value;
}

function maskTaskResult(message: JSONRPCMessage): JSONRPCMessage {
  if (!isJSONRPCResultResponse(message) || message.result.resultType !== 'task') return message;
  const metadata = isRecord(message.result._meta) ? message.result._meta : {};
  return {
    ...message,
    result: {
      resultType: 'complete',
      content: [],
      _meta: { ...metadata, [originalTaskResultKey]: message.result },
    },
  };
}

function taskIdFromBody(body: BodyInit | null | undefined): string | null {
  if (typeof body !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.method !== 'string') return null;
  if (!taskMethods.has(value.method)) return null;
  if (!isRecord(value.params) || typeof value.params.taskId !== 'string') return null;
  return value.params.taskId;
}

function encodeHeaderValue(value: string): string {
  if (isSafeHeaderValue(value)) return value;
  return `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function isSafeHeaderValue(value: string): boolean {
  if (value.length === 0 || value !== value.trim()) return false;
  if (value.startsWith('=?base64?') && value.endsWith('?=')) return false;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || (code !== 9 && (code < 32 || code > 126))) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
