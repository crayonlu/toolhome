import { Plus, Server as ServerIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import {
  useCreateServer,
  useDeleteServer,
  useDiagnostics,
  useServerAction,
  useServers,
  useUpdateServer,
} from '../../app/queries'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ui/Toast'
import { useConfirm } from '../../components/ui/ConfirmDialog'
import { Button, Spinner } from '../../components/ui/Button'
import { Badge, EmptyState, StatusDot } from '../../components/ui/Badge'
import { Toggle } from '../../components/ui/Toggle'
import { ActionsMenu } from '../../components/ui/Menu'
import { runtimeStatusLabel, runtimeStatusMeta } from '../../app/status'
import { ServerFormSheet, type ServerFormValue } from './ServerForm'
import { PlacementMenu } from './PlacementMenu'
import { displayStatus, nodeReportLine } from './nodeReport'
import { ALL_PLACEMENT, matchesPlacement, placementGroups, resolvePlacement } from './placement'
import type { ServerRecord } from '../../api/types'

export function ServersPage() {
  const { t, locale } = useI18n()
  const { toast } = useToast()
  const confirm = useConfirm()
  const { data: servers, isLoading } = useServers()
  const { data: diagnostics } = useDiagnostics()
  const createServer = useCreateServer()
  const updateServer = useUpdateServer()
  const deleteServer = useDeleteServer()
  const serverAction = useServerAction()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ServerRecord | undefined>(undefined)
  const [placement, setPlacement] = useState(ALL_PLACEMENT)

  // Node servers are grouped by the machine that runs them so they never read as
  // remote endpoints; a machine that disappears falls back to showing everything.
  const groups = useMemo(() => placementGroups(servers ?? []), [servers])
  const selected = resolvePlacement(groups, placement)
  const visible = useMemo(
    () => (servers ?? []).filter((server) => matchesPlacement(server, selected)),
    [servers, selected],
  )

  // Capability-snapshot availability comes from the diagnostics feed; the rest
  // of what that page showed (status, errors) is already on this list.
  const snapshotBySlug = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const item of diagnostics?.servers ?? []) map.set(item.slug, item.hasSnapshot)
    return map
  }, [diagnostics])

  const actionPending = (id: string) =>
    serverAction.isPending && serverAction.variables?.id === id
  const updatePending = (id: string) =>
    updateServer.isPending && updateServer.variables?.id === id
  const deletePending = (id: string) =>
    deleteServer.isPending && deleteServer.variables?.id === id

  const openCreate = () => {
    setEditing(undefined)
    setFormOpen(true)
  }

  const openEdit = (server: ServerRecord) => {
    setEditing(server)
    setFormOpen(true)
  }

  const handleSubmit = (value: ServerFormValue) => {
    const done = () => {
      setFormOpen(false)
      toast(editing ? t('common.save') : t('common.create'), 'success')
    }
    if (editing) {
      updateServer.mutate(
        { id: editing.id, input: value },
        { onSuccess: done, onError: (error) => toast(error.message, 'error') },
      )
    } else {
      createServer.mutate(value, { onSuccess: done, onError: (error) => toast(error.message, 'error') })
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">{t('nav.servers')}</h1>
        <Button variant="primary" onClick={openCreate}>
          <Plus className="size-4" />
          {t('common.add')}
        </Button>
      </div>

      {!isLoading && groups.length > 2 && (
        <PlacementMenu groups={groups} value={selected} onChange={setPlacement} />
      )}

      {isLoading ? (
        <div className="text-sm text-ink-3">{t('common.loading')}</div>
      ) : visible.length > 0 ? (
        <div className="flex flex-col divide-y divide-ink-3/10">
          {visible.map((server) => {
            const status = displayStatus(server)
            const reportLine = nodeReportLine(server, t, locale)
            const meta = runtimeStatusMeta(status)
            const busy = actionPending(server.id)
            const toggling = updatePending(server.id)
            const removing = deletePending(server.id)
            return (
              <div
                key={server.id}
                className={`flex min-h-[52px] items-center gap-3 px-1 py-2 transition-opacity ${
                  removing ? 'opacity-50' : ''
                }`}
              >
                <StatusDot tone={busy ? 'accent' : meta.tone} pulse={busy || meta.pulse} />
                <Link to={`/servers/${server.id}`} className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-ink">{server.name}</span>
                  <span className="truncate font-mono text-xs text-ink-3">{server.slug}</span>
                  {(server.runtime?.lastError ?? server.nodeReport?.lastError) && (
                    <span
                      className="truncate text-xs text-danger"
                      title={server.runtime?.lastError ?? server.nodeReport?.lastError ?? ''}
                    >
                      {server.runtime?.lastError ?? server.nodeReport?.lastError}
                    </span>
                  )}
                  {reportLine !== null && (
                    <span
                      className={`truncate text-xs ${
                        server.nodeReport?.stale === true || server.nodeReport?.probeOk === false
                          ? 'text-warning'
                          : 'text-ink-3'
                      }`}
                      title={server.nodeReport?.probeDetail ?? undefined}
                    >
                      {reportLine}
                    </span>
                  )}
                </Link>
                {server.kind === 'node' && server.nodeId !== null ? (
                  <Badge tone="neutral">
                    {t('servers.placement.nodeBadge', { node: server.nodeId })}
                  </Badge>
                ) : (
                  <Badge tone={server.kind === 'remote' ? 'accent' : 'neutral'}>{server.kind}</Badge>
                )}
                {snapshotBySlug.get(server.slug) === true && (
                  <span className="hidden shrink-0 text-xs text-ink-3 lg:block">
                    {t('diagnostics.snapshot')}
                  </span>
                )}
                <span className="hidden w-24 text-right text-xs text-ink-2 sm:block">
                  {busy ? (
                    <span className="inline-flex items-center justify-end gap-1.5">
                      <Spinner className="size-3" />
                      {removing
                        ? t('server.deleting')
                        : actionPending(server.id) && serverAction.variables?.action === 'restart'
                          ? t('server.restarting')
                          : t('server.refreshing')}
                    </span>
                  ) : (
                    runtimeStatusLabel(status, locale)
                  )}
                </span>
                <Toggle
                  checked={server.enabled}
                  disabled={toggling}
                  onChange={(enabled) =>
                    updateServer.mutate(
                      { id: server.id, input: { enabled } },
                      { onError: (error) => toast(error.message, 'error') },
                    )
                  }
                />
                <ActionsMenu
                  actions={[
                    {
                      label: t('common.refresh'),
                      disabled: busy,
                      onSelect: () => serverAction.mutate({ id: server.id, action: 'refresh' }),
                    },
                    {
                      label: t('server.restart'),
                      disabled: busy,
                      onSelect: () => serverAction.mutate({ id: server.id, action: 'restart' }),
                    },
                    { label: t('common.edit'), disabled: busy, onSelect: () => openEdit(server) },
                    {
                      label: t('common.delete'),
                      danger: true,
                      disabled: busy || removing,
                      onSelect: async () => {
                        const ok = await confirm({
                          title: t('common.delete'),
                          description: `${t('common.delete')} ${server.name}?`,
                          confirmLabel: t('common.delete'),
                          danger: true,
                        })
                        if (!ok) return
                        deleteServer.mutate(
                          { id: server.id },
                          { onError: (error) => toast(error.message, 'error') },
                        )
                      },
                    },
                  ]}
                />
              </div>
            )
          })}
        </div>
      ) : (
        <EmptyState
          icon={<ServerIcon className="size-8" />}
          title={t('common.empty')}
          action={
            <Button variant="primary" onClick={openCreate}>
              <Plus className="size-4" />
              {t('common.add')}
            </Button>
          }
        />
      )}

      <ServerFormSheet
        open={formOpen}
        onOpenChange={setFormOpen}
        initial={editing}
        onSubmit={handleSubmit}
        submitting={createServer.isPending || updateServer.isPending}
        title={editing ? t('common.edit') : t('common.add')}
      />
    </div>
  )
}
