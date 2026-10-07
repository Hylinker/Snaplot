const ID_PREFIX = 'el-'
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/

export const ADDRESSABLE = new Set([
  'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'use', 'symbol', 'image', 'a',
])

/** Sanitize a raw existing id; null when unusable. */
function safeId(raw: string | null): string | null {
  if (!raw) return null
  if (!ID_PATTERN.test(raw)) return null
  if (raw.startsWith('svg_')) return null // editor-internal
  return raw
}

/**
 * Ensure every addressable element has a stable unique id. Existing safe ids
 * are preserved; generated ids use the el-N namespace.
 */
export function assignStableIds(svgString: string): { svg: string; clearedSelectionIds: string[] } {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml')
  const root = doc.documentElement
  const used = new Set<string>()
  const clearedSelectionIds: string[] = []

  // First pass: collect preserved ids.
  const addressables = Array.from(root.querySelectorAll('*')).filter((el) =>
    ADDRESSABLE.has(el.tagName.replace(/^svg:/, ''))
  )
  const idMap = new Map<Element, string>()
  for (const el of addressables) {
    const raw = safeId(el.getAttribute('id'))
    if (raw && !used.has(raw)) {
      used.add(raw)
      idMap.set(el, raw)
    } else if (raw) {
      // duplicate id: unusable, will be regenerated
      clearedSelectionIds.push(raw)
    }
  }

  // Second pass: assign ids where missing.
  let counter = 1
  const nextId = () => {
    let id = `${ID_PREFIX}${counter++}`
    while (used.has(id)) id = `${ID_PREFIX}${counter++}`
    used.add(id)
    return id
  }
  for (const el of addressables) {
    if (!idMap.has(el)) {
      const id = nextId()
      el.setAttribute('id', id)
      idMap.set(el, id)
    }
  }

  return {
    svg: new XMLSerializer().serializeToString(root),
    clearedSelectionIds,
  }
}
