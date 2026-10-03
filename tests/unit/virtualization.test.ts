import { describe, expect, it } from 'vitest';
import {
  aggregateExtensionMethod,
  aggregateName,
  aggregateToolName,
  splitAggregateToolName,
  expandVirtualResourceTemplate,
  parseVirtualResourceTemplate,
  parseVirtualResourceUri,
  parseVirtualTaskId,
  rewriteAggregateContent,
  rewriteAggregateTask,
  restoreAggregateContent,
  splitAggregateExtensionMethod,
  virtualResourceTemplate,
  virtualResourceUri,
  virtualTaskId,
} from '../../src/data-plane/virtualization.js';

describe('aggregate virtualization', () => {
  it('keeps names bounded and extension methods reversible', () => {
    expect(aggregateName('github', 'search')).toBe('github.search');
    expect(aggregateToolName('github', 'search')).toBe('github_search');
    expect(aggregateToolName('chrome-devtools', 'take_screenshot')).toBe(
      'chrome-devtools_take-5fscreenshot',
    );
    expect(aggregateToolName('remote', 'a.b/c-ü')).toBe('remote_a-2eb-2fc-2d-c3-bc');
    expect(splitAggregateToolName('chrome-devtools_take-5fscreenshot')).toBe('chrome-devtools');
    expect(splitAggregateToolName('missing-separator')).toBeNull();
    expect(aggregateToolName('server', 'x'.repeat(200))).toHaveLength(128);
    expect(aggregateToolName('server', 'x'.repeat(199) + 'y')).not.toBe(
      aggregateToolName('server', 'x'.repeat(200)),
    );
    for (const name of [
      'simple',
      'a.b/c-ü',
      'a-2eb',
      'a.b',
      'x'.repeat(200),
      'x'.repeat(199) + 'y',
    ]) {
      expect(aggregateToolName('remote', name)).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
    }
    expect(aggregateToolName('remote', 'a.b')).not.toBe(aggregateToolName('remote', 'a-2eb'));
    const method = aggregateExtensionMethod('remote', 'vendor/deep/action');
    expect(splitAggregateExtensionMethod(method)).toEqual({
      slug: 'remote',
      upstreamMethod: 'vendor/deep/action',
    });
  });

  it('round-trips normal and MCP App resource URIs', () => {
    for (const uri of ['fixture://data?id=1', 'ui://fixture/dashboard']) {
      const virtual = virtualResourceUri('remote', uri);
      expect(parseVirtualResourceUri(virtual)).toEqual({ slug: 'remote', upstreamUri: uri });
    }
  });

  it('round-trips and expands RFC 6570 templates', () => {
    const virtual = virtualResourceTemplate('remote', 'fixture://items/{id}{?view}');
    expect(parseVirtualResourceTemplate(virtual)).toEqual({
      slug: 'remote',
      upstreamTemplate: 'fixture://items/{id}{?view}',
    });
    const expanded = virtual
      .replace('{?id,view}', '?id=42&view=full')
      .replace('{?view,id}', '?id=42&view=full');
    expect(expandVirtualResourceTemplate(expanded)).toEqual({
      slug: 'remote',
      upstreamUri: 'fixture://items/42?view=full',
    });
  });

  it('rewrites nested content and only restores values for the target server', () => {
    const upstreamUri = 'fixture://data';
    const virtual = virtualResourceUri('remote', upstreamUri);
    const rewritten = rewriteAggregateContent(
      {
        content: [
          { type: 'resource_link', uri: upstreamUri, name: 'data' },
          {
            type: 'resource',
            resource: { uri: upstreamUri, mimeType: 'text/plain', text: 'value' },
          },
        ],
        contents: [{ uri: upstreamUri, mimeType: 'text/plain', text: 'value' }],
      },
      'remote',
    );
    expect(rewritten).toMatchObject({
      content: [{ uri: virtual }, { resource: { uri: virtual } }],
      contents: [{ uri: virtual }],
    });
    expect(restoreAggregateContent({ uri: virtual }, 'remote')).toEqual({ uri: upstreamUri });
    expect(restoreAggregateContent({ uri: virtual }, 'other')).toEqual({ uri: virtual });
  });

  it('virtualizes task identifiers and nested task results', () => {
    const taskId = virtualTaskId('remote', 'task/with spaces');
    expect(parseVirtualTaskId(taskId)).toEqual({
      slug: 'remote',
      upstreamTaskId: 'task/with spaces',
    });
    expect(
      rewriteAggregateTask(
        {
          resultType: 'complete',
          taskId: 'task/with spaces',
          result: {
            content: [{ type: 'resource_link', uri: 'fixture://data', name: 'data' }],
          },
        },
        'remote',
      ),
    ).toMatchObject({
      taskId,
      result: {
        content: [{ uri: virtualResourceUri('remote', 'fixture://data') }],
      },
    });
  });
});
