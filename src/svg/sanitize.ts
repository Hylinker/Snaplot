const SVG_NS = 'http://www.w3.org/2000/svg'

/** Elements allowed in safe static SVG artwork. */
const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'metadata',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop',
  'clipPath', 'mask', 'pattern', 'marker',
  'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'feColorMatrix',
  'feFlood', 'feComposite', 'feMerge', 'feMergeNode',
  'use', 'symbol', 'image', 'a',
])

const URL_ATTRS = new Set(['href', 'xlink:href', 'src'])

/** Attributes removed unconditionally (event handlers, unsafe refs). */
const DENIED_ATTR_PATTERN = /^on/i

const ALLOWED_ATTR_EXTRA = new Set([
  'id', 'class', 'style', 'role', 'aria-label', 'aria-hidden', 'tabindex',
  'xmlns', 'xmlns:xlink',
])

const GEOMETRY_PAINT_ATTRS = new Set([
  'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'width', 'height', 'points', 'transform', 'gradientTransform',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'stroke-dashoffset', 'stroke-miterlimit', 'opacity', 'color',
  'offset', 'stop-color', 'stop-opacity', 'viewBox', 'preserveAspectRatio',
  'gradientUnits', 'spreadMethod', 'clip-path', 'mask', 'filter',
  'clipPathUnits', 'patternUnits', 'markerWidth', 'markerHeight',
  'refX', 'refY', 'orient', 'markerUnits', 'font-family', 'font-size',
  'font-weight', 'font-style', 'text-anchor', 'dominant-baseline',
  'letter-spacing', 'word-spacing', 'text-decoration',
  'fx', 'fy', 'in', 'in2', 'result', 'values', 'type', 'mode',
  'stdDeviation', 'dx', 'dy', 'slope', 'intercept', 'operator',
  'xlink:href', 'href', 'target', 'version', 'baseProfile',
  'startOffset', 'patternTransform', 'vector-effect', 'paint-order',
  'alignment-baseline', 'textLength', 'lengthAdjust',
  'k1', 'k2', 'k3', 'k4',
  'maskUnits', 'maskContentUnits', 'primitiveUnits', 'filterUnits',
])

function isAllowedAttribute(_el: string, name: string): boolean {
  if (DENIED_ATTR_PATTERN.test(name)) return false
  if (URL_ATTRS.has(name)) return true // value checked separately
  return ALLOWED_ATTR_EXTRA.has(name) || GEOMETRY_PAINT_ATTRS.has(name)
}

/** Only safe URL values pass: fragments, and http(s) are rejected for
 * external references per the strict initial policy. data: images other
 * than text/html are allowed for gradients/images is deferred — fail closed. */
function isAllowedUrlValue(value: string): boolean {
  const v = value.trim().toLowerCase()
  if (v.startsWith('#')) return true
  if (v.startsWith('javascript:') || v.startsWith('data:text/html')) return false
  if (v.startsWith('data:image/')) return true
  return false // http(s), mailto, unknown schemes: external refs deferred
}

export interface SanitizeResult {
  ok: boolean
  svg: string | null
  removedElements: string[]
  removedAttributes: string[]
  error?: string
}

export function parseSvgDocument(xml: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(xml, 'image/svg+xml')
  if (doc.querySelector('parsererror')) {
    throw new Error('Invalid XML: ' + (doc.querySelector('parsererror')?.textContent ?? '').slice(0, 200))
  }
  const root = doc.documentElement
  if (!root || root.namespaceURI !== SVG_NS || root.tagName.toLowerCase() !== 'svg') {
    throw new Error('Response is not an <svg> document element')
  }
  return root as unknown as SVGSVGElement
}

/**
 * Sanitize against the static-SVG allowlist. Fails closed: unknown elements
 * and attributes are removed; `ok:false` signals the document was rejected.
 */
export function sanitizeSvg(xml: string): SanitizeResult {
  let root: SVGSVGElement
  try {
    root = parseSvgDocument(xml)
  } catch (e) {
    return { ok: false, svg: null, removedElements: [], removedAttributes: [], error: (e as Error).message }
  }

  const removedElements: string[] = []
  const removedAttributes: string[] = []

  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (!ALLOWED_ELEMENTS.has(child.tagName.replace(/^svg:/, ''))) {
        removedElements.push(child.tagName)
        child.remove()
        continue
      }
      walk(child)
    }
  }
  walk(root)

  const all = [root as unknown as Element, ...Array.from(root.querySelectorAll('*'))]
  for (const el of all) {
    for (const attr of Array.from(el.attributes)) {
      const localName = attr.name.replace(/^xlink:/, 'xlink:')
      const allowed =
        isAllowedAttribute(el.tagName, attr.name) &&
        (!URL_ATTRS.has(attr.name) || isAllowedUrlValue(attr.value))
      if (!allowed) {
        removedAttributes.push(`${el.tagName}@${localName}`)
        el.removeAttribute(attr.name)
      }
    }
    // strip inline event styles that could smuggle urls via style attr
    const style = el.getAttribute('style')
    if (style && /url\((['"]?)\s*(https?:|javascript:)/i.test(style)) {
      el.removeAttribute('style')
      removedAttributes.push(`${el.tagName}@style`)
    }
  }

  return {
    ok: true,
    svg: new XMLSerializer().serializeToString(root),
    removedElements,
    removedAttributes,
  }
}
