import { create } from 'zustand'
import { useChatStore } from './chat'
import type { ProjectContent } from '../types'

export interface EditorSelection {
  id: string | null
  tagName: string
  attributes: Record<string, string>
}

interface EditorState {
  /** Document revision: bumped by setSvg/undo — drives editor reloads. */
  revision: number
  /** Manual-edit counter: bumped by canvas changes, never triggers reload. */
  manualRevision: number
  currentSvg: string | null
  selection: EditorSelection | null
  lastEditError: string | null
}

interface EditorActions {
  setSvg: (svg: string) => void
  setSelection: (sel: EditorSelection | null) => void
  /**
   * After an AI edit lands, drop the selection if its target element no
   * longer exists in the new document (e.g. it was removed/replaced).
   */
  syncSelectionAfterEdit: (svg: string) => void
  /** Write back live canvas state without triggering an editor reload. */
  syncCanvasSvg: (svg: string) => void
  /** Flush a pending debounced canvas write-back synchronously, if any. */
  flushLiveCanvas: () => void
  /** Install (or clear, with null) the live-canvas flush implementation. */
  registerFlushLiveCanvas: (fn: (() => void) | null) => void
  markChanged: () => void
  setEditError: (err: string | null) => void
  /**
   * Restore the canvas to a prior turn's SVG. Null means the artwork did not
   * exist yet — reset to the plan-first workflow.
   */
  restoreSvg: (svg: string | null) => void
  clear: () => void
  /** Load persisted project content (R5). */
  hydrate: (content: ProjectContent) => void
}

/**
 * Synchronous flush of a pending live-canvas write-back, installed by the
 * workspace component that owns the canvas. Kept outside zustand state so
 * registering it never triggers store subscriptions (autosave). Readers that
 * need the authoritative document — turn dispatch, visual review, persistence
 * — call it before snapshotting, so a manual edit made inside the write-back
 * debounce window is never silently lost (audit "live canvas freshness").
 */
let flushLiveCanvasImpl: (() => void) | null = null

export const useEditorStore = create<EditorState & EditorActions>()(
    (set, get) => ({
      revision: 0,
      manualRevision: 0,
      currentSvg: null,
      selection: null,
      lastEditError: null,

      setSvg: (svg) =>
        set((s) => ({
          currentSvg: svg,
          revision: s.revision + 1,
          lastEditError: null,
        })),

      setSelection: (selection) => set({ selection }),

      syncSelectionAfterEdit: (svg) => {
        const { selection } = get()
        if (!selection?.id) return
        const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
        if (!doc.documentElement?.querySelector(`[id=${JSON.stringify(selection.id)}]`)) {
          set({ selection: null })
        }
      },

      syncCanvasSvg: (svg) => set({ currentSvg: svg }),

      flushLiveCanvas: () => flushLiveCanvasImpl?.(),

      registerFlushLiveCanvas: (fn) => {
        flushLiveCanvasImpl = fn
      },

      markChanged: () => set((s) => ({ manualRevision: s.manualRevision + 1 })),
      setEditError: (lastEditError) => set({ lastEditError }),

      restoreSvg: (svg) => {
        if (svg === null) {
          get().clear()
          return
        }
        set((s) => ({
          currentSvg: svg,
          revision: s.revision + 1,
          selection: null,
          lastEditError: null,
        }))
      },

      clear: () => {
        // Clearing the canvas restarts the plan-first workflow.
        useChatStore.getState().setPlanConfirmed(false)
        set({
          revision: 0,
          manualRevision: 0,
          currentSvg: null,
          selection: null,
          lastEditError: null,
        })
      },

      hydrate: (content) =>
        set({
          revision: content.revision,
          manualRevision: content.manualRevision,
          currentSvg: content.currentSvg,
          selection: null,
          lastEditError: null,
        }),
    }),
  )
