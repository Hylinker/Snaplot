import { useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ClipboardCopy,
  Download,
  Files,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import { EditorWrapper } from '@/editor/EditorWrapper'
import { useEditorStore } from '@/stores/editor'
import { useProjectsStore } from '@/stores/projects'
import { useChatStore } from '@/stores/chat'
import { copyPngToClipboard, intrinsicDimensions } from '@/services/export'
import { ExportDialog } from '@/components/ExportDialog'
import { ConfirmDialog, type ConfirmRequest } from '@/components/ConfirmDialog'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * Hosts the SVG-Edit canvas. One long-lived EditorWrapper per mount; the
 * deferred-mount guard inside the wrapper absorbs StrictMode remounts.
 */
export function WorkspacePanel() {
  const containerRef = useRef<HTMLDivElement>(null)
  const wrapperRef = useRef<EditorWrapper | null>(null)
  const revision = useEditorStore((s) => s.revision)
  const currentSvg = useEditorStore((s) => s.currentSvg)
  const lastEditError = useEditorStore((s) => s.lastEditError)
  const setSelection = useEditorStore((s) => s.setSelection)
  const markChanged = useEditorStore((s) => s.markChanged)
  const syncCanvasSvg = useEditorStore((s) => s.syncCanvasSvg)
  // Project-level state for the sub-bar (moved from the former ProjectBar).
  const projects = useProjectsStore((s) => s.projects)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const projectStatus = useProjectsStore((s) => s.status)
  const projectError = useProjectsStore((s) => s.error)
  const chatStatus = useChatStore((s) => s.status)
  const activeProject = projects.find((p) => p.id === activeProjectId)

  // Load store SVG into the editor whenever the revision moves ahead of the
  // last loaded revision (AI edits, undo, restore).
  const loadedRevisionRef = useRef(-1)
  // Debounces write-back of live canvas state into the store.
  const writeBackTimerRef = useRef<number | null>(null)
  // Suppresses write-back while a programmatic load is in flight: loading a
  // document fires canvas change events that must not count as manual edits.
  const loadingRef = useRef(false)

  useEffect(() => {
    if (!containerRef.current) return
    // A fresh wrapper instance starts with an empty canvas: forget any
    // revision recorded by a previous (e.g. StrictMode throwaway) wrapper.
    loadedRevisionRef.current = -1
    /** Serialize the live canvas into the store (stable ids + selection). */
    const runWriteBack = (wrapper: EditorWrapper) => {
      const assigned = wrapper.assignStableIds()
      if (!assigned) return
      syncCanvasSvg(assigned.svg)
      // Refresh the selection so its id reflects any newly assigned stable
      // id and stays consistent with the stored artwork.
      const sel = wrapper.getSelection()
      setSelection(sel ? { id: sel.id, tagName: sel.tagName, attributes: sel.attributes } : null)
    }
    const clearWriteBackTimer = () => {
      if (writeBackTimerRef.current !== null) {
        window.clearTimeout(writeBackTimerRef.current)
        writeBackTimerRef.current = null
      }
    }
    /**
     * Synchronously flush a pending debounced write-back. Turn dispatch and
     * persistence call this through the editor store before snapshotting, so
     * manual edits made inside the debounce window are never lost.
     */
    const flushPendingWriteBack = () => {
      if (writeBackTimerRef.current === null) return
      clearWriteBackTimer()
      if (loadingRef.current) return // the canvas is being replaced by a load
      const wrapper = wrapperRef.current
      if (!wrapper) return
      if (wrapper.isReady) runWriteBack(wrapper)
      else void wrapper.ready.then(() => {
        if (!loadingRef.current && writeBackTimerRef.current === null) runWriteBack(wrapper)
      })
    }
    const wrapper = new EditorWrapper({
      onSelectionChange: (sel) =>
        setSelection(sel ? { id: sel.id, tagName: sel.tagName, attributes: sel.attributes } : null),
      onCanvasChange: () => {
        if (loadingRef.current) return
        markChanged()
        // Refinements must use live canvas state, not the last AI string.
        clearWriteBackTimer()
        writeBackTimerRef.current = window.setTimeout(() => {
          writeBackTimerRef.current = null
          void wrapper.ready.then(() => {
            // Stable ids are assigned here so manually added elements are
            // addressable by edit operations in the next agent turn.
            runWriteBack(wrapper)
          })
        }, 400)
      },
    })
    wrapperRef.current = wrapper
    useEditorStore.getState().registerFlushLiveCanvas(flushPendingWriteBack)
    wrapper.mount(containerRef.current).catch((e) => console.error('editor mount failed', e))
    return () => {
      useEditorStore.getState().registerFlushLiveCanvas(null)
      clearWriteBackTimer()
      wrapper.destroy()
    }
  }, [setSelection, markChanged, syncCanvasSvg])

  const loadIntoEditor = (svg: string) => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    // A pending manual write-back refers to the canvas being replaced — drop
    // it, or its delayed syncCanvasSvg would clobber the programmatic load
    // with a serialization of the old document.
    if (writeBackTimerRef.current !== null) {
      window.clearTimeout(writeBackTimerRef.current)
      writeBackTimerRef.current = null
    }
    loadingRef.current = true
    void wrapper.ready.then(() => {
      try {
        wrapper.loadSvg(svg)
      } finally {
        // Let the load-triggered change events settle before treating
        // further changes as manual edits again.
        window.setTimeout(() => {
          loadingRef.current = false
        }, 200)
      }
    })
  }

  // Project switch: force the next load even if the revision number repeats.
  useEffect(() => {
    loadedRevisionRef.current = -2
  }, [activeProjectId])

  useEffect(() => {
    if (!currentSvg) return
    if (loadedRevisionRef.current === revision) return
    if (!wrapperRef.current) return
    loadedRevisionRef.current = revision
    loadIntoEditor(currentSvg)
  }, [revision, currentSvg])

  // When the store is cleared (New button), load an empty document so the
  // visible canvas resets too; the loadSvg effect above skips null SVGs.
  useEffect(() => {
    if (currentSvg) return
    if (loadedRevisionRef.current === -1) return
    loadedRevisionRef.current = -1
    loadIntoEditor(
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"></svg>'
    )
  }, [currentSvg])

  const [exportSvg, setExportSvg] = useState<string | null>(null)
  const exportBtnRef = useRef<HTMLButtonElement>(null)
  // Pending destructive/streaming confirmation, rendered by ConfirmDialog.
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)

  // Copy-PNG feedback: a transient button state plus an inline error message,
  // both reset by a timer so no toast system is needed.
  const [copyState, setCopyState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [copyError, setCopyError] = useState<string | null>(null)
  const copyTimerRef = useRef<number | null>(null)

  const clearCopyTimer = () => {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = null
    }
  }

  const scheduleCopyReset = (ms: number) => {
    clearCopyTimer()
    copyTimerRef.current = window.setTimeout(() => {
      copyTimerRef.current = null
      setCopyState('idle')
      setCopyError(null)
    }, ms)
  }

  useEffect(() => clearCopyTimer, [])

  // Switching or deleting while a response streams asks for confirmation so
  // unsaved turn work is never silently discarded.
  const runOrConfirm = (action: string, proceed: () => void) => {
    if (chatStatus !== 'streaming') {
      proceed()
      return
    }
    setConfirm({
      title: 'A response is still streaming',
      description: `${action} now will discard the incomplete reply.`,
      confirmLabel: 'Continue',
      onConfirm: proceed,
    })
  }

  const onSwitchProject = (id: string) => {
    if (id === activeProjectId) return
    runOrConfirm('Switching projects', () => void useProjectsStore.getState().switchTo(id))
  }

  // Inline rename: the project name becomes an input; Enter or blur commits,
  // Escape cancels. Empty or unchanged names are ignored.
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')

  const startRename = () => {
    if (!activeProject) return
    setRenameDraft(activeProject.name)
    setRenaming(true)
  }

  const commitRename = () => {
    if (!renaming) return
    setRenaming(false)
    const name = renameDraft.trim()
    if (!activeProject || !name || name === activeProject.name) return
    void useProjectsStore.getState().rename(activeProject.id, name)
  }

  const onRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commitRename()
    if (e.key === 'Escape') setRenaming(false)
  }

  const onDuplicateProject = () => {
    if (!activeProject) return
    runOrConfirm('Duplicating this project', () =>
      void useProjectsStore.getState().duplicate(activeProject.id)
    )
  }

  const onDeleteProject = () => {
    if (!activeProject) return
    setConfirm({
      title: `Delete project "${activeProject.name}"?`,
      description: 'Its artwork and conversation cannot be recovered.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => void useProjectsStore.getState().remove(activeProject.id),
    })
  }

  const onNew = () => {
    runOrConfirm('Starting a new project', () => void useProjectsStore.getState().create())
  }

  // Export always reads the live canvas (authoritative artwork), falling back
  // to the store snapshot if the editor is not mounted yet.
  const onOpenExport = () => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    void wrapper.ready.then(() => {
      const svg = wrapper.getSvg() ?? useEditorStore.getState().currentSvg
      if (svg) setExportSvg(svg)
    })
  }

  // Copy reads the live canvas like export does; the PNG uses the canvas's
  // intrinsic size at 1x with a transparent background (the dialog defaults).
  const onCopyPng = () => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    clearCopyTimer()
    setCopyError(null)
    void wrapper.ready
      .then(() => {
        const svg = wrapper.getSvg() ?? useEditorStore.getState().currentSvg
        if (!svg) return
        setCopyState('busy')
        return copyPngToClipboard(svg, {
          width: intrinsicDimensions(svg)?.width ?? 640,
          scale: 1,
          background: null,
        })
      })
      .then((result) => {
        if (!result) return
        if (result.ok) {
          setCopyState('done')
          scheduleCopyReset(2500)
        } else {
          setCopyState('idle')
          setCopyError(result.error)
          scheduleCopyReset(6000)
        }
      })
      .catch((e: Error) => {
        setCopyState('idle')
        setCopyError(`PNG copy failed: ${e.message}`)
        scheduleCopyReset(6000)
      })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">Snaplot</span>
        {projectStatus === 'loading' && <span className="text-muted-foreground">Loading projects…</span>}
        {projectStatus === 'error' && (
          <span className="text-destructive" title={projectError ?? undefined}>
            Failed to load projects
          </span>
        )}
        {projectStatus === 'ready' && (
          <div className="flex items-center overflow-hidden rounded-lg border border-input bg-transparent text-sm whitespace-nowrap select-none transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
            <div className="relative">
              <button
                type="button"
                className="group/name flex h-7 max-w-48 items-center rounded-l-lg py-0 pr-1.5 pl-2 font-medium text-foreground outline-none hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={startRename}
                disabled={!activeProject}
                aria-label="Rename project"
                title="Rename this project"
              >
                <span className={cn('flex min-w-0 items-center gap-1', renaming && 'invisible')}>
                  <span className="truncate">{activeProject?.name ?? 'No project'}</span>
                  <Pencil className="size-3 shrink-0 opacity-40 transition-opacity group-hover/name:opacity-100" />
                </span>
              </button>
              {renaming && (
                <Input
                  className="absolute inset-0 h-auto rounded-l-lg border-0 px-2 py-0 text-sm font-medium focus-visible:ring-0"
                  aria-label="Project name"
                  autoFocus
                  onFocus={(e) => e.target.select()}
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={onRenameKeyDown}
                  onBlur={commitRename}
                />
              )}
            </div>
            <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex h-7 items-center rounded-r-lg px-1.5 text-muted-foreground outline-none hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-muted/50"
                  disabled={projects.length === 0}
                  aria-label="Switch project"
                  title="Switch project"
                >
                  <ChevronDown className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-auto min-w-40 max-w-56">
                {projects.map((p) => (
                  <DropdownMenuItem key={p.id} onSelect={() => onSwitchProject(p.id)}>
                    <Check
                      className={p.id === activeProjectId ? undefined : 'opacity-0'}
                      aria-hidden="true"
                    />
                    <span className="truncate">{p.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        <span className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={onNew}
            aria-label="New project"
            title="Create a new empty project; the current one stays in the project list"
          >
            <Plus />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={onDuplicateProject}
            disabled={!activeProject}
            aria-label="Duplicate project"
            title="Duplicate this project"
          >
            <Files />
          </Button>
          <Button
            variant="destructive-outline"
            size="icon-sm"
            onClick={onDeleteProject}
            disabled={!activeProject}
            aria-label="Delete project"
            title="Delete this project"
          >
            <Trash2 />
          </Button>
        </span>
        {lastEditError && (
          <span className="max-w-[16rem] truncate text-xs text-destructive" title={lastEditError}>
            {lastEditError}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {copyError && (
            <span className="max-w-[16rem] truncate text-xs text-destructive" title={copyError}>
              {copyError}
            </span>
          )}
          <Button
            variant="outline"
            size="icon-sm"
            onClick={onCopyPng}
            disabled={!currentSvg || copyState === 'busy'}
            aria-label={copyState === 'busy' ? 'Copying PNG' : copyState === 'done' ? 'Copied' : 'Copy PNG'}
            title={
              copyState === 'busy'
                ? 'Copying the artwork as a PNG image'
                : copyState === 'done'
                  ? 'PNG copied to clipboard'
                  : currentSvg
                    ? 'Copy the artwork as a PNG image at canvas size'
                    : 'Create artwork first to copy'
            }
          >
            {copyState === 'busy' ? <Loader2 className="animate-spin" /> : copyState === 'done' ? <Check /> : <ClipboardCopy />}
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            ref={exportBtnRef}
            onClick={onOpenExport}
            disabled={!currentSvg}
            aria-label="Export"
            title={currentSvg ? 'Export the artwork as SVG or PNG' : 'Create artwork first to export'}
          >
            <Download />
          </Button>
        </span>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 border-none" style={{ width: '100%', height: '100%' }} />
      <span className="sr-only" role="status">
        {copyState === 'done' ? 'PNG copied to clipboard' : copyError ? `PNG copy failed: ${copyError}` : ''}
      </span>
      {!currentSvg && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="rounded-lg bg-background/80 px-4 py-2 text-sm text-muted-foreground">
            Describe an idea in the chat to create artwork.
          </p>
        </div>
      )}
      {exportSvg && (
        <ExportDialog
          svg={exportSvg}
          projectName={activeProject?.name}
          onClose={() => {
            setExportSvg(null)
            exportBtnRef.current?.focus()
          }}
        />
      )}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}
