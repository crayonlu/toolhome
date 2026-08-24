import type {
  Prompt,
  JSONObject,
  Resource,
  ResourceTemplateType,
  ServerCapabilities,
  Tool,
} from '@modelcontextprotocol/server';
import { AppError } from '../domain/errors.js';
import type { CapabilitySnapshot, ServerRecord } from '../domain/models.js';
import type { Store } from '../storage/store.js';
import {
  aggregateName,
  rewriteAggregateTool,
  virtualResourceTemplate,
  virtualResourceUri,
} from './virtualization.js';

const aggregateAwareExtensions = new Set([
  'io.modelcontextprotocol/tasks',
  'io.modelcontextprotocol/ui',
]);

export interface RegistryEntry {
  server: ServerRecord;
  snapshot: CapabilitySnapshot;
}

export interface AggregateRegistry {
  entries: RegistryEntry[];
  capabilities: ServerCapabilities;
  tools: Tool[];
  resources: Resource[];
  resourceTemplates: ResourceTemplateType[];
  prompts: Prompt[];
}

export class CapabilityRegistry {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  entryBySlug(slug: string, requireEnabled = true): RegistryEntry {
    const server = this.#store.getServerBySlug(slug);
    if (!server) throw new AppError('server_not_found', `Unknown server: ${slug}`, 404);
    if (requireEnabled && !server.enabled) {
      throw new AppError('server_disabled', `Server ${slug} is disabled`, 503);
    }
    const snapshot = this.#store.getSnapshot(server.id);
    if (!snapshot) {
      throw new AppError('snapshot_unavailable', `Server ${slug} has no capability snapshot`, 503);
    }
    return { server, snapshot };
  }

  entries(): RegistryEntry[] {
    return this.#store
      .listServers()
      .filter((server) => server.enabled)
      .flatMap((server) => {
        const snapshot = this.#store.getSnapshot(server.id);
        return snapshot ? [{ server, snapshot }] : [];
      });
  }

  aggregate(): AggregateRegistry {
    const entries = this.entries();
    const tools = entries.flatMap(({ server, snapshot }) =>
      snapshot.tools.map((tool) => ({
        ...rewriteAggregateTool(tool, server.slug),
        name: aggregateName(server.slug, tool.name),
      })),
    );
    const prompts = entries.flatMap(({ server, snapshot }) =>
      snapshot.prompts.map((prompt) => ({
        ...prompt,
        name: aggregateName(server.slug, prompt.name),
      })),
    );
    const resources = entries.flatMap(({ server, snapshot }) =>
      snapshot.resources.map((resource) => ({
        ...resource,
        uri: virtualResourceUri(server.slug, resource.uri),
      })),
    );
    const resourceTemplates = entries.flatMap(({ server, snapshot }) =>
      snapshot.resourceTemplates.map((template) => ({
        ...template,
        uriTemplate: virtualResourceTemplate(server.slug, template.uriTemplate),
      })),
    );

    const extensions: NonNullable<ServerCapabilities['extensions']> = {};
    for (const { server, snapshot } of entries) {
      for (const [name, settings] of Object.entries(snapshot.capabilities.extensions ?? {})) {
        const key = aggregateAwareExtensions.has(name) ? name : `toolhome/${server.slug}/${name}`;
        const value = aggregateAwareExtensions.has(name)
          ? settings
          : { ...settings, upstreamExtension: name, upstreamServer: server.slug };
        extensions[key] = mergeExtensionSettings(extensions[key], value);
      }
    }
    const experimental = Object.fromEntries(
      entries.flatMap(({ server, snapshot }) =>
        Object.entries(snapshot.capabilities.experimental ?? {}).map(([name, settings]) => [
          `${server.slug}/${name}`,
          settings,
        ]),
      ),
    );
    const capabilities: ServerCapabilities = {
      ...(entries.some(({ snapshot }) => snapshot.capabilities.tools)
        ? { tools: { listChanged: true } }
        : {}),
      ...(entries.some(({ snapshot }) => snapshot.capabilities.prompts)
        ? { prompts: { listChanged: true } }
        : {}),
      ...(entries.some(({ snapshot }) => snapshot.capabilities.resources)
        ? {
            resources: {
              listChanged: true,
              subscribe: entries.some(({ snapshot }) => snapshot.capabilities.resources?.subscribe),
            },
          }
        : {}),
      ...(entries.some(({ snapshot }) => snapshot.capabilities.completions)
        ? { completions: {} }
        : {}),
      ...(entries.some(({ snapshot }) => snapshot.capabilities.logging) ? { logging: {} } : {}),
      ...(Object.keys(extensions).length === 0 ? {} : { extensions }),
      ...(Object.keys(experimental).length === 0 ? {} : { experimental }),
    };
    return {
      entries,
      capabilities,
      tools: tools.sort((left, right) => left.name.localeCompare(right.name)),
      prompts: prompts.sort((left, right) => left.name.localeCompare(right.name)),
      resources: resources.sort((left, right) => left.uri.localeCompare(right.uri)),
      resourceTemplates: resourceTemplates.sort((left, right) =>
        left.uriTemplate.localeCompare(right.uriTemplate),
      ),
    };
  }

  findAggregateTool(name: string): { entry: RegistryEntry; originalName: string } {
    for (const entry of this.entries()) {
      const tool = entry.snapshot.tools.find(
        (candidate) => aggregateName(entry.server.slug, candidate.name) === name,
      );
      if (tool) return { entry, originalName: tool.name };
    }
    throw new AppError('tool_not_found', `Unknown aggregate tool: ${name}`, 404);
  }

  findAggregatePrompt(name: string): { entry: RegistryEntry; originalName: string } {
    for (const entry of this.entries()) {
      const prompt = entry.snapshot.prompts.find(
        (candidate) => aggregateName(entry.server.slug, candidate.name) === name,
      );
      if (prompt) return { entry, originalName: prompt.name };
    }
    throw new AppError('prompt_not_found', `Unknown aggregate prompt: ${name}`, 404);
  }
}

function mergeExtensionSettings(left: JSONObject | undefined, right: JSONObject): JSONObject {
  if (left === undefined) return right;
  const merged: JSONObject = { ...left, ...right };
  for (const [key, value] of Object.entries(right)) {
    const previous = left[key];
    if (!Array.isArray(previous) || !Array.isArray(value)) continue;
    const unique = new Map<string, (typeof value)[number]>();
    for (const item of [...previous, ...value]) unique.set(JSON.stringify(item), item);
    merged[key] = [...unique.values()];
  }
  return merged;
}
