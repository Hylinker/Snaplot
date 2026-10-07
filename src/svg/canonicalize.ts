/**
 * Canonical serialization: sort attributes deterministically, drop whitespace
 * text nodes, so the same logical document always serializes identically.
 */
export function canonicalizeSvg(svgString: string): string {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml')
  const root = doc.documentElement

  const visit = (el: Element) => {
    // Namespace declarations (xmlns*) are managed by the serializer, not the
    // attribute list: re-setting them as plain attributes makes XMLSerializer
    // emit duplicates, producing invalid XML.
    const attrs = Array.from(el.attributes).filter((a) => !a.name.startsWith('xmlns'))
    const sorted = attrs.sort((a, b) => a.name.localeCompare(b.name))
    for (const attr of sorted) {
      el.removeAttribute(attr.name)
    }
    for (const attr of sorted) {
      el.setAttribute(attr.name, attr.value.trim())
    }
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3 /* text */) {
        const t = child.textContent?.trim()
        if (!t) child.remove()
      } else if (child.nodeType === 1 /* element */) {
        visit(child as Element)
      } else if (child.nodeType === 8 /* comment */) {
        child.remove()
      }
    }
  }
  visit(root)
  return new XMLSerializer().serializeToString(root)
}
