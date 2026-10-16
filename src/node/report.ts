import { z } from 'zod';
import type { NodeStatusReport } from './status.js';

/**
 * Publish this machine's view of its node servers to the host.
 *
 * The host never runs a node server, so it has no state of its own to show:
 * without this report every node server reads as `unknown` in the console. What
 * travels is what only this machine can answer — whether the launch command is
 * present, what the last connection did, and how many tools the server exposes.
 */

export interface NodeReportApi {
  request(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<unknown>;
}

const responseSchema = z
  .object({
    nodeId: z.string(),
    reportedAt: z.string(),
    accepted: z.array(z.object({ slug: z.string(), status: z.string() }).passthrough()),
    rejected: z.array(z.object({ slug: z.string(), reason: z.string() }).passthrough()),
  })
  .passthrough();

export type NodeReportResponse = z.infer<typeof responseSchema>;

/** One report body for every server the mirror knows about. */
export function buildNodeReport(report: NodeStatusReport): { servers: unknown[] } {
  return {
    servers: report.servers.map((server) => ({
      slug: server.slug,
      status: server.status,
      error: server.lastError,
      probeOk: server.probe.ok,
      probeDetail: server.probe.detail,
      tools: server.tools,
    })),
  };
}

export async function reportNodeStatus(
  client: NodeReportApi,
  report: NodeStatusReport,
): Promise<NodeReportResponse> {
  return responseSchema.parse(
    await client.request(
      'POST',
      `/api/v1/nodes/${encodeURIComponent(report.nodeId)}/report`,
      buildNodeReport(report),
      30_000,
    ),
  );
}
