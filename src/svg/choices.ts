export interface Choice {
  id: string
  label: string
}

export interface ChoiceBlock {
  questionId: string
  prompt: string
  choices: Choice[]
}

/** Validate a snaplot-choices payload; null when unusable. */
export function validateChoices(payload: unknown): ChoiceBlock | null {
  if (typeof payload !== 'object' || payload === null) return null
  const c = payload as Record<string, unknown>
  if (typeof c.questionId !== 'string' || !c.questionId) return null
  if (typeof c.prompt !== 'string' || !c.prompt) return null
  if (!Array.isArray(c.choices) || c.choices.length < 2 || c.choices.length > 6) return null
  const choices: Choice[] = []
  for (const raw of c.choices) {
    if (typeof raw !== 'object' || raw === null) return null
    const o = raw as Record<string, unknown>
    if (typeof o.id !== 'string' || !o.id || typeof o.label !== 'string' || !o.label) return null
    choices.push({ id: o.id, label: o.label })
  }
  return { questionId: c.questionId, prompt: c.prompt, choices }
}
