export type ControlType = 'text' | 'textarea' | 'number' | 'select' | 'color' | 'boolean'

export interface AttributeControl {
  id: string
  label: string
  type: ControlType
  defaultValue: string | number | boolean
  options?: { id: string; label: string }[]
  min?: number
  max?: number
  step?: number
}

export const MAX_CONTROLS = 12

const TYPES: ControlType[] = ['text', 'textarea', 'number', 'select', 'color', 'boolean']

/**
 * Validate a snaplot-attributes payload. Invalid controls are ignored
 * individually; more than MAX_CONTROLS keeps only the first MAX_CONTROLS.
 */
export function validateAttributeControls(payload: unknown): AttributeControl[] {
  if (typeof payload !== 'object' || payload === null) return []
  const attrs = (payload as { attributes?: unknown }).attributes
  if (!Array.isArray(attrs)) return []

  const out: AttributeControl[] = []
  for (const raw of attrs) {
    if (out.length >= MAX_CONTROLS) break
    if (typeof raw !== 'object' || raw === null) continue
    const c = raw as Record<string, unknown>
    if (typeof c.id !== 'string' || !c.id) continue
    if (typeof c.label !== 'string' || !c.label) continue
    if (typeof c.type !== 'string' || !TYPES.includes(c.type as ControlType)) continue
    if (!('defaultValue' in c)) continue
    if (out.some((x) => x.id === c.id)) continue

    const type = c.type as ControlType
    let defaultValue: string | number | boolean = c.defaultValue as string
    if (type === 'number') {
      const n = Number(c.defaultValue)
      if (!Number.isFinite(n)) continue
      defaultValue = n
    } else if (type === 'boolean') {
      if (typeof c.defaultValue !== 'boolean') continue
      defaultValue = c.defaultValue
    } else if (typeof c.defaultValue !== 'string') {
      continue
    }

    const control: AttributeControl = { id: c.id, label: c.label, type, defaultValue }

    if (type === 'select') {
      const options = Array.isArray(c.options) ? c.options : []
      const parsed = options
        .filter(
          (o): o is { id: string; label: string } =>
            typeof o === 'object' && o !== null && typeof (o as { id?: unknown }).id === 'string' && typeof (o as { label?: unknown }).label === 'string'
        )
      if (parsed.length < 2) continue // enumerated choices need >= 2 options
      control.options = parsed
    }

    if (type === 'number') {
      if (typeof c.min === 'number' && Number.isFinite(c.min)) control.min = c.min
      if (typeof c.max === 'number' && Number.isFinite(c.max)) control.max = c.max
      if (typeof c.step === 'number' && c.step > 0) control.step = c.step
      if (control.min !== undefined && control.max !== undefined && control.min > control.max) continue
    }

    out.push(control)
  }
  return out
}

export type AttributeValues = Record<string, string | number | boolean>

/** Current values: defaults overlaid with user edits. */
export function applyDefaults(controls: AttributeControl[], values: AttributeValues): AttributeValues {
  const out: AttributeValues = {}
  for (const c of controls) {
    out[c.id] = c.id in values ? values[c.id] : c.defaultValue
  }
  return out
}
