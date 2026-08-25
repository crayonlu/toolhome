import { useEffect, useState } from 'react'

export type Plane = 'mcp' | 'cli'
const STORAGE_KEY = 'mch.plane'
const CHANGE_EVENT = 'mch:plane'

export function readPlane(): Plane {
  return localStorage.getItem(STORAGE_KEY) === 'cli' ? 'cli' : 'mcp'
}

/**
 * Global MCP/CLI plane selection. The value is shared across every hook
 * subscriber via a window event and persisted to localStorage, so the sidebar
 * switch, page filters, and redirects all stay in sync.
 */
export function usePlane() {
  const [plane, setPlaneState] = useState<Plane>(readPlane)

  useEffect(() => {
    const onChange = () => setPlaneState(readPlane())
    window.addEventListener(CHANGE_EVENT, onChange)
    window.addEventListener('storage', onChange)
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange)
      window.removeEventListener('storage', onChange)
    }
  }, [])

  const setPlane = (next: Plane) => {
    localStorage.setItem(STORAGE_KEY, next)
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }

  return { plane, setPlane }
}
