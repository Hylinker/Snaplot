import { useCallback, useEffect, useRef, useState } from 'react'
import { WorkspacePanel } from './WorkspacePanel'
import { ChatPanel } from './ChatPanel'
import { useProjectsStore } from '../stores/projects'

/**
 * Full-viewport shell: left workspace / right chat with a draggable split.
 * Defaults to 70/30; collapses to a stacked layout under 768px.
 */
export function AppShell() {
  const [splitPct, setSplitPct] = useState(70)
  const [narrow, setNarrow] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  // Load (or migrate into) IndexedDB projects once per app lifetime.
  useEffect(() => {
    void useProjectsStore.getState().init()
  }, [])

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const update = () => setNarrow(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!draggingRef.current || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const pct = ((e.clientX - rect.left) / rect.width) * 100
    setSplitPct(Math.min(85, Math.max(30, pct)))
  }, [])

  const stopDrag = useCallback(() => {
    draggingRef.current = false
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }, [])

  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stopDrag)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', stopDrag)
    }
  }, [onPointerMove, stopDrag])

  const startDrag = () => {
    draggingRef.current = true
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }

  return (
    <div className="flex h-full flex-col bg-muted text-foreground">
      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col md:flex-row">
        <main className="relative min-h-0 flex-1 md:flex-none" style={narrow ? undefined : { width: `${splitPct}%` }}>
          <WorkspacePanel />
        </main>
        {!narrow && (
          <div
            className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary"
            onPointerDown={startDrag}
            role="separator"
            aria-orientation="vertical"
          />
        )}
        <aside className="min-h-0 flex-1 border-t md:border-l-0 md:border-t-0">
          <ChatPanel />
        </aside>
      </div>
    </div>
  )
}
