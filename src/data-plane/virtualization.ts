import { createHash } from 'node:crypto';
import { UriTemplate, type Tool, type Variables } from '@modelcontextprotocol/server';

const maxNameLength = 128;

export function aggregateName(slug: string, original: string): string {
  const candidate = `${slug}.${original}`;
  if (candidate.length <= maxNameLength) return candidate;
  const suffix = createHash('sha256').update(candidate).digest('hex').slice(0, 12);
  return `${candidate.slice(0, maxNameLength - suffix.length - 1)}_${suffix}`;
}

export function splitAggregateName(value: string): { slug: string; original: string } | null {
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  return { slug: value.slice(0, dot), original: value.slice(dot + 1) };
}

export function virtualResourceUri(slug: string, upstreamUri: string): string {
  if (upstreamUri.startsWith('ui://')) {
    const encoded = Buffer.from(upstreamUri, 'utf8').toString('base64url');
    return `ui://toolhome/${slug}/resource/${encoded}`;
  }
  return `toolhome://${slug}/resource/${encodeURIComponent(upstreamUri)}`;
}

export function virtualResourceTemplate(slug: string, upstreamTemplate: string): string {
  const template = new UriTemplate(upstreamTemplate);
  const encoded = Buffer.from(upstreamTemplate, 'utf8').toString('base64url');
  const variables = [...new Set(template.variableNames)];
  const suffix = `${slug}/template/${encoded}${variables.length === 0 ? '' : `{?${variables.join(',')}}`}`;
  return upstreamTemplate.startsWith('ui://') ? `ui://toolhome/${suffix}` : `toolhome://${suffix}`;
}

export function parseVirtualResourceUri(uri: string): { slug: string; upstreamUri: string } | null {
  const uiMatch = /^ui:\/\/toolhome\/([a-z0-9]+(?:-[a-z0-9]+)*)\/resource\/([A-Za-z0-9_-]+)$/.exec(
    uri,
  );
  if (uiMatch) {
    const slug = uiMatch[1];
    const encoded = uiMatch[2];
    if (slug === undefined || encoded === undefined) return null;
    try {
      const upstreamUri = Buffer.from(encoded, 'base64url').toString('utf8');
      return upstreamUri.startsWith('ui://') ? { slug, upstreamUri } : null;
    } catch {
      return null;
    }
  }
  const prefix = 'toolhome://';
  if (!uri.startsWith(prefix)) return null;
  const remainder = uri.slice(prefix.length);
  const marker = '/resource/';
  const markerIndex = remainder.indexOf(marker);
  if (markerIndex <= 0) return null;
  try {
    return {
      slug: remainder.slice(0, markerIndex),
      upstreamUri: decodeURIComponent(remainder.slice(markerIndex + marker.length)),
    };
  } catch {
    return null;
  }
}

export function parseVirtualResourceTemplate(
  uriTemplate: string,
): { slug: string; upstreamTemplate: string } | null {
  const match =
    /^(?:toolhome:\/\/|ui:\/\/toolhome\/)([a-z0-9]+(?:-[a-z0-9]+)*)\/template\/([A-Za-z0-9_-]+)(?:\{\?[^}]+\})?$/.exec(
      uriTemplate,
    );
  if (!match) return null;
  const slug = match[1];
  const encoded = match[2];
  if (slug === undefined || encoded === undefined) return null;
  try {
    const upstreamTemplate = Buffer.from(encoded, 'base64url').toString('utf8');
    return upstreamTemplate.length === 0 ? null : { slug, upstreamTemplate };
  } catch {
    return null;
  }
}

export function expandVirtualResourceTemplate(
  uri: string,
): { slug: string; upstreamUri: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  const isHome = parsed.protocol === 'toolhome:';
  const isUi = parsed.protocol === 'ui:' && parsed.hostname === 'toolhome';
  if (!isHome && !isUi) return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  const slug = isHome ? parsed.hostname : segments[0];
  const marker = isHome ? segments[0] : segments[1];
  const encoded = isHome ? segments[1] : segments[2];
  if (slug === undefined || marker !== 'template' || encoded === undefined) return null;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return null;
  }
  try {
    const upstreamTemplate = Buffer.from(encoded, 'base64url').toString('utf8');
    const template = new UriTemplate(upstreamTemplate);
    const variables: Variables = {};
    for (const name of template.variableNames) {
      const values = parsed.searchParams.getAll(name);
      if (values.length === 1 && values[0] !== undefined) variables[name] = values[0];
      else if (values.length > 1) variables[name] = values;
    }
    return { slug, upstreamUri: template.expand(variables) };
  } catch {
    return null;
  }
}

export function aggregateExtensionMethod(slug: string, method: string): string {
  return `toolhome/${slug}/${method}`;
}

export function splitAggregateExtensionMethod(
  method: string,
): { slug: string; upstreamMethod: string } | null {
  const prefix = 'toolhome/';
  if (!method.startsWith(prefix)) return null;
  const rest = method.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { slug: rest.slice(0, slash), upstreamMethod: rest.slice(slash + 1) };
}

export function virtualTaskId(slug: string, upstreamTaskId: string): string {
  return `toolhome-task:${slug}:${Buffer.from(upstreamTaskId, 'utf8').toString('base64url')}`;
}

export function parseVirtualTaskId(
  taskId: string,
): { slug: string; upstreamTaskId: string } | null {
  const match = /^toolhome-task:([a-z0-9]+(?:-[a-z0-9]+)*):([A-Za-z0-9_-]+)$/.exec(taskId);
  if (!match) return null;
  const slug = match[1];
  const encoded = match[2];
  if (slug === undefined || encoded === undefined) return null;
  try {
    const upstreamTaskId = Buffer.from(encoded, 'base64url').toString('utf8');
    if (upstreamTaskId.length === 0) return null;
    return { slug, upstreamTaskId };
  } catch {
    return null;
  }
}

export function rewriteAggregateTool(tool: Tool, slug: string): Tool {
  const metadata = rewriteUiMetadata(tool._meta, slug);
  return {
    ...tool,
    ...(metadata === undefined ? {} : { _meta: metadata }),
  };
}

export function rewriteAggregateTask(value: unknown, slug: string): unknown {
  const rewritten = rewriteAggregateContent(value, slug);
  if (rewritten === null || typeof rewritten !== 'object' || Array.isArray(rewritten)) {
    return rewritten;
  }
  const record = Object.fromEntries(Object.entries(rewritten));
  if (typeof record.taskId === 'string') record.taskId = virtualTaskId(slug, record.taskId);
  if (record.task !== null && typeof record.task === 'object' && !Array.isArray(record.task)) {
    const task = Object.fromEntries(Object.entries(record.task));
    if (typeof task.taskId === 'string') task.taskId = virtualTaskId(slug, task.taskId);
    record.task = task;
  }
  return record;
}

export function rewriteAggregateContent(value: unknown, slug: string): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteAggregateContent(item, slug));
  if (value === null || typeof value !== 'object') return value;
  const record = Object.fromEntries(Object.entries(value));
  if (record.type === 'resource_link' && typeof record.uri === 'string') {
    record.uri = virtualResourceUri(slug, record.uri);
  }
  if (
    typeof record.uri === 'string' &&
    (typeof record.text === 'string' || typeof record.blob === 'string')
  ) {
    record.uri = virtualResourceUri(slug, record.uri);
  }
  if (record.type === 'resource' && record.resource && typeof record.resource === 'object') {
    const resource = Object.fromEntries(Object.entries(record.resource));
    if (typeof resource.uri === 'string') resource.uri = virtualResourceUri(slug, resource.uri);
    record.resource = resource;
  }
  for (const [key, item] of Object.entries(record)) {
    if (key !== 'uri' && key !== 'resource') {
      record[key] = rewriteAggregateContent(item, slug);
    }
  }
  return record;
}

export function restoreAggregateContent(value: unknown, slug: string): unknown {
  if (typeof value === 'string') {
    const route = parseVirtualResourceUri(value) ?? expandVirtualResourceTemplate(value);
    return route?.slug === slug ? route.upstreamUri : value;
  }
  if (Array.isArray(value)) return value.map((item) => restoreAggregateContent(item, slug));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, restoreAggregateContent(item, slug)]),
  );
}

function rewriteUiMetadata(
  metadata: Record<string, unknown> | undefined,
  slug: string,
): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  const rewritten = { ...metadata };
  if (typeof rewritten['ui/resourceUri'] === 'string') {
    rewritten['ui/resourceUri'] = virtualResourceUri(slug, rewritten['ui/resourceUri']);
  }
  if (rewritten.ui !== null && typeof rewritten.ui === 'object' && !Array.isArray(rewritten.ui)) {
    const ui = Object.fromEntries(Object.entries(rewritten.ui));
    if (typeof ui.resourceUri === 'string') {
      ui.resourceUri = virtualResourceUri(slug, ui.resourceUri);
    }
    rewritten.ui = ui;
  }
  return rewritten;
}
