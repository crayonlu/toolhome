import { describe, expect, it } from 'vitest'
import { probeState, probeTone } from './probe'
import type { CliStatus } from '../../api/types'

const status = (input: Partial<CliStatus>): CliStatus => ({
  installed: true,
  version: 'gh 2.97.0',
  loggedIn: false,
  lastCheckedAt: '2026-10-16T00:00:00.000Z',
  ...input,
})

describe('hosted CLI probe state', () => {
  it('separates "not checked" from "the probe says it is missing"', () => {
    expect(probeState(undefined)).toBe('unchecked')
    expect(probeState(status({ installed: false }))).toBe('missing')
    expect(probeTone('missing')).toBe('danger')
  })

  it('reports a record without a probe as such instead of as broken', () => {
    expect(probeState(status({ installed: null, version: null }))).toBe('no-probe')
    expect(probeTone('no-probe')).toBe('neutral')
  })

  it('calls a signed-in CLI ready', () => {
    expect(probeState(status({ loggedIn: true }))).toBe('ready')
    expect(probeTone('ready')).toBe('success')
  })

  it('distinguishes a failed login from a probe that cannot report one', () => {
    // `gh --version` style probes print no markers: inconclusive, not broken.
    expect(probeState(status({ version: null }))).toBe('unreported')
    expect(probeTone('unreported')).toBe('neutral')
    // A probe that reported a version but no login did answer.
    expect(probeState(status({ version: 'az 2.x' }))).toBe('unauthenticated')
    expect(probeTone('unauthenticated')).toBe('warning')
  })
})
