import type { PlanStep, PlanStepEdit } from '../types'

/**
 * Ensure step ids are non-empty and unique, labels trimmed. Checklist edits
 * key off ids, but providers do not enforce the tool schema — models omit or
 * duplicate ids often enough that raw steps cannot be trusted. Runs both at
 * tool dispatch (persisting normalized steps) and whenever persisted steps
 * are annotated, so legacy plans with empty/duplicate ids work too.
 */
export function normalizePlanSteps(steps: PlanStep[]): PlanStep[] {
  const seen = new Set<string>()
  return steps.map((s, i) => {
    let id = s.id.trim() || `step-${i + 1}`
    if (seen.has(id)) {
      let n = 2
      while (seen.has(`${id}-${n}`)) n++
      id = `${id}-${n}`
    }
    seen.add(id)
    return { id, label: s.label.trim() }
  })
}

/**
 * One-line summary of the user's checklist edits (e.g. `skip "Mountains";
 * change "Sun" to "Glowing sun"`), or null when nothing was edited. Injected
 * alongside the plan-steps context so the model sees the adjustments by name
 * without duplicating them in the chat transcript.
 */
export function planAdjustmentNote(
  steps: PlanStep[],
  edits: Record<string, PlanStepEdit>
): string | null {
  if (steps.length === 0) return null
  const original = normalizePlanSteps(steps)
  const annotated = original.map((s) => {
    const edit = edits[s.id]
    return edit ? { id: s.id, label: edit.label, included: edit.included } : { ...s, included: true }
  })
  const excluded = annotated.filter((s) => !s.included).map((s) => `"${s.label}"`)
  const renamed = annotated
    .filter((s) => {
      const o = original.find((x) => x.id === s.id)
      return s.included && o !== undefined && o.label !== s.label
    })
    .map((s) => `"${original.find((x) => x.id === s.id)!.label}" to "${s.label}"`)
  if (excluded.length === 0 && renamed.length === 0) return null
  const parts: string[] = []
  if (excluded.length > 0) parts.push(`skip ${excluded.join(', ')}`)
  if (renamed.length > 0) parts.push(`change ${renamed.join(', ')}`)
  return parts.join('; ')
}
