declare module 'svgedit/dist/editor/Editor.js' {
  /** The canvas API surface Snaplot actually uses (see EditorWrapper). */
  export interface SvgCanvas {
    getSvgString(): string | null
    getSelectedElements(): Element[]
    undoMgr: {
      resetUndoStack(): void
    }
  }

  export default class Editor {
    svgCanvas: SvgCanvas | null
    constructor(container?: HTMLElement | null)
    init(): Editor
    setConfig(config: Record<string, unknown>): void
    ready(cb: () => void | Promise<void>): void
    loadSvgString(xml: string, opts?: { noAlert?: boolean }): void
  }
}
