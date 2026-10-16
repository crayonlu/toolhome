import { formatDistanceToNow } from 'date-fns'
import { enUS, zhCN } from 'date-fns/locale'
import type { Locale } from '../../i18n/types'
import type { RuntimeStatus, ServerWithRuntime } from '../../api/types'

/**
 * What a node server's state means in the console.
 *
 * The host never runs a node server, so `runtime` is always unknown for one;
 * the machine that does run it reports status, whether the launch command is
 * present, and how many tools the server exposed. A report older than the TTL is
 * shown with its age rather than as current.
 */
export function displayStatus(server: ServerWithRuntime): RuntimeStatus {
  if (server.kind !== 'node') return server.runtime?.status ?? 'unknown'
  return server.nodeReport?.status ?? 'unknown'
}

function ago(reportedAt: string, locale: Locale): string {
  return formatDistanceToNow(new Date(reportedAt), {
    addSuffix: true,
    locale: locale === 'zh' ? zhCN : enUS,
  })
}

/** One line saying where a node server's state came from, or null for other kinds. */
export function nodeReportLine(
  server: ServerWithRuntime,
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: Locale,
): string | null {
  if (server.kind !== 'node') return null
  const node = server.nodeId ?? t('servers.placement.node')
  const report = server.nodeReport
  if (report === null || report === undefined) {
    return t('servers.nodeReport.missing', { node })
  }
  const parts = [
    report.stale
      ? t('servers.nodeReport.stale', { node, age: ago(report.reportedAt, locale) })
      : t('servers.nodeReport.by', { node, age: ago(report.reportedAt, locale) }),
  ]
  if (report.probeOk === false) parts.push(t('servers.nodeReport.probeMissing'))
  if (report.tools !== null) parts.push(t('servers.nodeReport.tools', { count: report.tools }))
  return parts.join(' · ')
}
