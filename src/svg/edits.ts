import { sanitizeSvg } from './sanitize'

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Hard cap on a raw `setFullSvg` string before any parsing or sanitization,
 * so absurd inputs fail fast with a deterministic retry error.
 */
const MAX_RAW_SVG_INPUT = 1_000_000

export type EditOperation =
  | { type: 'setRoot'; reason: string; attributes: Record<string, string> }
  | { type: 'setAttributes'; target: string; reason: string; attributes: Record<string, string> }
  | { type: 'insertElement'; target: string; position?: 'before' | 'after' | 'child'; reason: string; element: string }
  | { type: 'removeElement'; target: string; reason: string }
  | { type: 'replaceElement'; target: string; reason: string; element: string }
  | { type: 'setFullSvg'; reason: string; svg: string }

export interface EditPayload {
  operations: EditOperation[]
}

const VALID_TYPES = new Set(['setRoot', 'setAttributes', 'insertElement', 'removeElement', 'replaceElement', 'setFullSvg'])

export interface ApplyResult {
  ok: boolean
  svg: string | null
  appliedCount: number
  errors: string[]
}

/**
 * Parse a single-element fragment for insert/replace. The documented fragment
 * form omits the xmlns declaration, so the fragment is parsed inside an SVG
 * wrapper — parsing it standalone would produce a null-namespace element that
 * serializes as `xmlns=""` and renders as nothing (audit A3).
 */
function parseElement(xml: string): Element {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="${SVG_NS}">${xml}</svg>`,
    'image/svg+xml'
  )
  if (doc.querySelector('parsererror')) {
    throw new Error('insert/replace element is not valid XML')
  }
  const children = Array.from(doc.documentElement.children)
  if (children.length !== 1) {
    throw new Error(`insert/replace element must contain exactly one element (got ${children.length})`)
  }
  const el = children[0]
  if (!isSvgNamespaceTree(el)) {
    throw new Error('insert/replace element must be an SVG element (foreign namespaces are not allowed)')
  }
  return el
}

function isSvgNamespaceTree(el: Element): boolean {
  if (el.namespaceURI !== SVG_NS) return false
  return Array.from(el.children).every(isSvgNamespaceTree)
}

/**
 * Validate and apply operations to a detached DOM copy. All-or-nothing:
 * if any operation is invalid the original document is untouched and a
 * deterministic error list is returned for model retry.
 */
export function applyEditOperations(currentSvg: string, payload: unknown): ApplyResult {
  const errors: string[] = []
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, svg: null, appliedCount: 0, errors: ['payload: expected a JSON object'] }
  }
  const ops = (payload as { operations?: unknown }).operations
  if (!Array.isArray(ops)) {
    return { ok: false, svg: null, appliedCount: 0, errors: ['operations: required and must be an array'] }
  }

  ops.forEach((op, i) => {
    const at = `operations[${i}]`
    if (typeof op !== 'object' || op === null) return errors.push(`${at}: expected an object`)
    const o = op as Record<string, unknown>
    if (typeof o.type !== 'string' || !VALID_TYPES.has(o.type)) {
      return errors.push(`${at}.type: unknown operation type ${JSON.stringify(o.type)}`)
    }
    // setRoot and setFullSvg address the root/document; every other operation
    // needs an explicit element id (matches the documented operation shapes).
    if (o.type !== 'setFullSvg' && o.type !== 'setRoot' && typeof o.target !== 'string') {
      errors.push(`${at}.target: required string element id`)
    }
    if ((o.type === 'setAttributes' || o.type === 'setRoot') && (typeof o.attributes !== 'object' || o.attributes === null)) {
      errors.push(`${at}.attributes: required object`)
    }
    if ((o.type === 'insertElement' || o.type === 'replaceElement') && typeof o.element !== 'string') {
      errors.push(`${at}.element: required XML string`)
    }
    if (o.type === 'setFullSvg' && typeof o.svg !== 'string') {
      errors.push(`${at}.svg: required SVG string`)
    }
  })
  if (errors.length > 0) return { ok: false, svg: null, appliedCount: 0, errors }

  const doc = new DOMParser().parseFromString(currentSvg, 'image/svg+xml')
  const root = doc.documentElement
  const find = (id: string) => root.querySelector(`[id=${JSON.stringify(id)}]`)

  let applied = 0
  try {
    for (const raw of ops as Record<string, never>[]) {
      const op = raw as unknown as EditOperation & Record<string, unknown>
      switch (op.type) {
        case 'setRoot': {
          for (const [k, v] of Object.entries(op.attributes)) root.setAttribute(k, String(v))
          break
        }
        case 'setAttributes': {
          const el = find(op.target)
          if (!el) throw new Error(`setAttributes: target "${op.target}" not found`)
          for (const [k, v] of Object.entries(op.attributes)) el.setAttribute(k, String(v))
          break
        }
        case 'insertElement': {
          const parent = find(op.target)
          if (!parent) throw new Error(`insertElement: target "${op.target}" not found`)
          const child = parseElement(op.element)
          const pos = op.position ?? 'child'
          if (pos === 'child') parent.append(child)
          else if (pos === 'before') parent.before(child)
          else parent.after(child)
          break
        }
        case 'removeElement': {
          const el = find(op.target)
          if (!el) throw new Error(`removeElement: target "${op.target}" not found`)
          el.remove()
          break
        }
        case 'replaceElement': {
          const el = find(op.target)
          if (!el) throw new Error(`replaceElement: target "${op.target}" not found`)
          el.replaceWith(parseElement(op.element))
          break
        }
        case 'setFullSvg': {
          if (op.svg.length > MAX_RAW_SVG_INPUT) {
            throw new Error(`setFullSvg: svg string is too large (${op.svg.length} chars)`)
          }
          const result = sanitizeSvg(op.svg)
          if (!result.ok) throw new Error(`setFullSvg: ${result.error}`)
          return { ok: true, svg: result.svg, appliedCount: applied + 1, errors: [] }
        }
      }
      applied++
    }
  } catch (e) {
    return { ok: false, svg: null, appliedCount: 0, errors: [(e as Error).message] }
  }

  const serialized = new XMLSerializer().serializeToString(root)
  const sanitized = sanitizeSvg(serialized)
  if (!sanitized.ok) {
    return { ok: false, svg: null, appliedCount: 0, errors: [`post-apply sanitization failed: ${sanitized.error}`] }
  }
  return { ok: true, svg: sanitized.svg, appliedCount: applied, errors }
}
