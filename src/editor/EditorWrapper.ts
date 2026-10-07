import Editor from 'svgedit/dist/editor/Editor.js'
import { ADDRESSABLE, assignStableIds } from '../svg/ids'

export interface SelectionInfo {
  id: string | null
  tagName: string
  attributes: Record<string, string>
}

export interface EditorWrapperEvents {
  onSelectionChange?: (sel: SelectionInfo | null) => void
  onCanvasChange?: () => void
}

/**
 * Single boundary around the SVG-Edit v7 API. All application code talks to
 * this interface; SVG-Edit specifics never leak past this module.
 */
export class EditorWrapper {
  private editor: Editor | null = null
  private container: HTMLElement | null = null
  private mountToken = 0
  /** True once the current mount finished initializing (synchronous probe). */
  private readyResolved = false
  /** Resolves once the current mount is ready; never rejects. */
  private readyPromise: Promise<void> = Promise.resolve()
  private readonly events: EditorWrapperEvents

  constructor(events: EditorWrapperEvents = {}) {
    this.events = events
  }

  async mount(container: HTMLElement): Promise<void> {
    if (this.editor && this.container === container) return this.readyPromise
    this.destroy()

    // SVG-Edit's async init() cannot survive a destroy() mid-flight and it
    // resolves element lookups through document-global IDs. Deferring the
    // actual construction lets React StrictMode's throwaway first mount
    // collapse into this single init, and `token` aborts stale mounts.
    const token = ++this.mountToken
    const ready = (async () => {
      await new Promise((r) => setTimeout(r, 100))
      if (token !== this.mountToken) return

      this.container = container
      this.editor = new Editor(container)
      this.editor.setConfig({
        allowInitialUserOverride: false,
        noDefaultExtensions: false,
        extensions: [],
        userExtensions: [],
        no_save_warning: true,
        initTool: 'select',
        // Icons resolve relative to the page URL by default, which 404s under
        // Vite; serve them from public/svgedit/images instead.
        imgPath: '/svgedit/images',
      })

      // init() builds the DOM and resolves ready callbacks; it must be called
      // before ready() listeners will ever fire.
      this.editor.init()

      await new Promise<void>((resolve) => {
        this.editor!.ready(() => resolve())
      })
      if (token !== this.mountToken) return // destroyed while initializing
      this.readyResolved = true

      // Receive canvas events. We subscribe via canvas-level event binding
      // instead of addExtension: the editor's `extension_added`
      // post-processing calls leftPanel.add(events.id, events.click), which
      // crashes for extensions without a left-panel button. bind() is
      // single-slot and svgedit already occupies it, so chain onto the
      // previous handler; `call("selected", elems)` invokes handlers as
      // (window, elems).
      const canvas = this.editor.svgCanvas as unknown as {
        bind: (
          name: string,
          handler: (...args: unknown[]) => unknown
        ) => ((...args: unknown[]) => unknown) | undefined
      }
      const prevSelected: ((...a: unknown[]) => unknown) | undefined = canvas.bind(
        'selected',
        (...args: unknown[]) => {
          // Keep svgedit's own handler alive (it drives its context panels).
          void prevSelected?.(...args)
          const elems = (args[1] ?? []) as Element[]
          this.events.onSelectionChange?.(this.describeSelection(elems))
        }
      )
      const prevChanged: ((...a: unknown[]) => unknown) | undefined = canvas.bind(
        'changed',
        (...args: unknown[]) => {
          void prevChanged?.(...args)
          this.events.onCanvasChange?.()
        }
      )
      void prevSelected
      void prevChanged
    })()
    this.readyPromise = ready.catch((e) =>
      console.error('[snaplot] editor bridge failed:', e)
    )
    return this.readyPromise
  }

  /** Await before issuing load/get calls after mount(). */
  get ready(): Promise<void> {
    return this.readyPromise
  }

  /** True when calls can be issued synchronously (no awaiting `ready`). */
  get isReady(): boolean {
    return this.readyResolved && this.editor !== null
  }

  /**
   * Load a complete SVG document. Returns the serialized readback.
   * Goes through Editor.loadSvgString (not raw canvas.setSvgString) because
   * only the editor-level path calls updateCanvas(), which resizes/re-centers
   * the workarea to the loaded document — otherwise content with dimensions
   * other than the default canvas renders outside the visible canvas.
   *
   * Programmatic loads are app-level state, not user edits: the undo stack is
   * reset afterwards so an in-editor Ctrl+Z can never pop a document load and
   * empty the canvas (AI/project-switch loads; see docs/r0-findings.md).
   * Undo for AI actions is the app-level svgBefore snapshot, never the raw
   * svgedit stack.
   */
  loadSvg(xml: string): string | null {
    const editor = this.editor
    if (!editor?.svgCanvas) {
      throw new Error('EditorWrapper: editor not mounted or not ready')
    }
    try {
      editor.loadSvgString(xml, { noAlert: true })
      editor.svgCanvas.undoMgr?.resetUndoStack()
    } catch (e) {
      throw new Error(`EditorWrapper.loadSvg: ${(e as Error).message}`)
    }
    return this.getSvg()
  }

  getSvg(): string | null {
    return this.requireCanvas().getSvgString()
  }

  /**
   * Assign stable el-N ids to addressable canvas elements that lack a
   * safe id (e.g. svgedit-generated svg_N ones) and write them back onto the
   * live canvas DOM, so subsequent serializations keep the same ids. Direct
   * DOM writes bypass svgedit's undo on purpose: ids are addressing metadata,
   * not user-visible content. Returns the serialized canvas with ids applied.
   */
  assignStableIds(): { svg: string; clearedSelectionIds: string[] } | null {
    const svg = this.getSvg()
    if (!svg) return null
    const result = assignStableIds(svg)

    // The assigned document preserves element order, so the Nth addressable
    // in the serialized form corresponds to the Nth one on the canvas.
    const doc = new DOMParser().parseFromString(result.svg, 'image/svg+xml')
    const assignedIds = Array.from(doc.documentElement.querySelectorAll('*'))
      .filter((el) => ADDRESSABLE.has(el.tagName.replace(/^svg:/, '')))
      .map((el) => el.getAttribute('id'))
    // Not declared on the editor's SvgCanvas type, but provided by the
    // underlying svgcanvas package (see its bundled d.ts).
    const canvasRoot = (this.requireCanvas() as unknown as {
      getSvgRoot(): SVGSVGElement
    }).getSvgRoot()
    const canvasElems = Array.from(canvasRoot.querySelectorAll('*')).filter((el) =>
      ADDRESSABLE.has(el.tagName.replace(/^svg:/, ''))
    )
    if (canvasElems.length === assignedIds.length) {
      canvasElems.forEach((el, i) => {
        const id = assignedIds[i]
        if (id && el.getAttribute('id') !== id) el.setAttribute('id', id)
      })
    }

    return result
  }

  getSelection(): SelectionInfo | null {
    const elems = this.requireCanvas().getSelectedElements().filter(Boolean)
    return this.describeSelection(elems)
  }

  destroy(): void {
    this.mountToken++
    this.readyResolved = false
    // SVG-Edit v7 exposes no destroy(); remove the DOM it created inside the
    // container so a remount starts clean. Listener leaks are tracked in the
    // spike findings.
    if (this.container) {
      this.container.innerHTML = ''
    }
    this.editor = null
    this.container = null
  }

  private requireCanvas() {
    if (!this.editor?.svgCanvas) {
      throw new Error('EditorWrapper: editor not mounted or not ready')
    }
    return this.editor.svgCanvas
  }

  private describeSelection(elems: Element[]): SelectionInfo | null {
    if (elems.length === 0) return null
    const el = elems[0]
    const attributes: Record<string, string> = {}
    for (const attr of Array.from(el.attributes)) {
      attributes[attr.name] = attr.value
    }
    return {
      id: el.getAttribute('id'),
      tagName: el.tagName,
      attributes,
    }
  }
}
