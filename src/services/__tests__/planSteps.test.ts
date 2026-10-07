import { describe, expect, it } from 'vitest'
import { normalizePlanSteps, planAdjustmentNote } from '../planSteps'

describe('normalizePlanSteps', () => {
  it('synthesizes ids for steps without one and trims labels', () => {
    expect(
      normalizePlanSteps([{ id: '', label: ' Sky ' }, { id: '  ', label: 'Mountains' }])
    ).toEqual([
      { id: 'step-1', label: 'Sky' },
      { id: 'step-2', label: 'Mountains' },
    ])
  })

  it('uniquifies duplicated ids', () => {
    expect(
      normalizePlanSteps([
        { id: 's1', label: 'A' },
        { id: 's1', label: 'B' },
        { id: 's1-2', label: 'C' },
      ]).map((s) => s.id)
    ).toEqual(['s1', 's1-2', 's1-2-2'])
  })
})

describe('planAdjustmentNote', () => {
  const steps = [
    { id: 's1', label: 'Sky' },
    { id: 's2', label: 'Mountains' },
    { id: 's3', label: 'Sun' },
  ]

  it('returns null when nothing was edited or no steps exist', () => {
    expect(planAdjustmentNote(steps, {})).toBeNull()
    expect(planAdjustmentNote([], { s1: { included: false, label: 'x' } })).toBeNull()
  })

  it('summarizes exclusions and renames', () => {
    expect(
      planAdjustmentNote(steps, {
        s2: { included: false, label: 'Mountains' },
        s3: { included: true, label: 'Glowing sun' },
      })
    ).toBe('skip "Mountains"; change "Sun" to "Glowing sun"')
  })

  it('keys edits correctly for legacy plans with empty ids', () => {
    const legacy = [
      { id: '', label: 'Sky' },
      { id: '', label: 'Mountains' },
    ]
    expect(planAdjustmentNote(legacy, { 'step-2': { included: false, label: 'Mountains' } })).toBe(
      'skip "Mountains"'
    )
  })
})
