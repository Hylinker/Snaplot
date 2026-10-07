import type { AgentAction } from './actionEnvelope'
import { EDIT_OPERATIONS_SCHEMA, type Stage } from './promptBuilder'
import { normalizePlanSteps } from './planSteps'
import { validateAttributeControls, type AttributeControl } from '../svg/attributes'
import { validateChoices } from '../svg/choices'
import type { ToolCall, ToolDeclaration } from '../types'

/**
 * Native tool-calling contract for the agent turn workflow. The runner sends
 * these declarations with every request; the model answers with exactly one
 * tool call per reply, dispatched through the same verify pipeline as the
 * legacy text envelopes. Verify failures are fed back as tool-result messages
 * so the model always sees its own failed attempt in the conversation.
 */

const BUILD_DESCRIPTION = `Deliver the complete artwork as one <svg> document.
The SVG must be safe static content: no scripts, no event handlers, no animation elements.
Style with presentation attributes directly on elements (fill, stroke, font-family, opacity,
...); <style> blocks and CSS class rules are stripped. Images must be inline data: URIs
(external http(s) URLs are stripped); web fonts do not load — use generic families
(sans-serif, serif, monospace). Keep it compact (aim for fewer than 150 elements).`

const APPLY_EDITS_DESCRIPTION = `Refine the existing artwork with targeted operations.
${EDIT_OPERATIONS_SCHEMA}
Targets must reference the stable element ids given in the artwork context. Empty operations
is valid. Never repeat the artwork wholesale in a refinement; setFullSvg only for a complete
redesign.`

const ASK_QUESTION_DESCRIPTION = `Ask ONE clarifying question with quick-choice chips (2-6
choices), only when the answer materially changes the artwork.`

/** Bound for the optional build_svg project title. */
const PROJECT_NAME_MAX_CHARS = 80

/** Normalize the optional build_svg "name" — never fails the build over a title. */
function projectTitle(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.trim().slice(0, PROJECT_NAME_MAX_CHARS)
}

const PROPOSE_PLAN_DESCRIPTION = `Propose a design plan before the first artwork: present a
concise plan as markdown text (subject, composition/layout, color palette, style, canvas
size) and a steps array of the drawing steps. Keep the step list out of the reply text —
it renders to the user as an interactive checklist. The user confirms the plan before
anything is drawn. The user may edit the step list (exclude or rename steps) or reply with
feedback — when revising a plan, keep the same step ids and labels for unchanged steps.
Optionally attach pre-draw parameter controls ("attributes", at most 12).`

/**
 * JSON Schema variants for apply_edits operations, mirroring the
 * EditOperation union in svg/edits.ts. The strict oneOf keeps models from
 * omitting "type" or inventing type names — the top source of rejected edits.
 */
const EDIT_OPERATION_SCHEMAS = [
  {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['setRoot'] },
      reason: { type: 'string' },
      attributes: { type: 'object', additionalProperties: { type: ['string', 'number'] } },
    },
    required: ['type', 'reason', 'attributes'],
  },
  {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['setAttributes'] },
      reason: { type: 'string' },
      target: { type: 'string' },
      attributes: { type: 'object', additionalProperties: { type: ['string', 'number'] } },
    },
    required: ['type', 'reason', 'target', 'attributes'],
  },
  {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['insertElement'] },
      reason: { type: 'string' },
      target: { type: 'string' },
      position: { type: 'string', enum: ['child', 'before', 'after'] },
      element: { type: 'string' },
    },
    required: ['type', 'reason', 'target', 'element'],
  },
  {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['removeElement'] },
      reason: { type: 'string' },
      target: { type: 'string' },
    },
    required: ['type', 'reason', 'target'],
  },
  {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['replaceElement'] },
      reason: { type: 'string' },
      target: { type: 'string' },
      element: { type: 'string' },
    },
    required: ['type', 'reason', 'target', 'element'],
  },
  {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['setFullSvg'] },
      reason: { type: 'string' },
      svg: { type: 'string' },
    },
    required: ['type', 'reason', 'svg'],
  },
]

export const AGENT_TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: 'build_svg',
    description: BUILD_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        svg: {
          type: 'string',
          description: 'The complete <svg> document, starting with "<svg" and ending with "</svg>".',
        },
        name: {
          type: 'string',
          description:
            'Short project title (2-6 words) for the artwork; applied as the project name on the first build.',
        },
      },
      required: ['svg'],
      additionalProperties: false,
    },
  },
  {
    name: 'apply_edits',
    description: APPLY_EDITS_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          description: 'Ordered edit operations; shapes are documented in the tool description.',
          items: { oneOf: EDIT_OPERATION_SCHEMAS },
        },
      },
      required: ['operations'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_question',
    description: ASK_QUESTION_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        questionId: { type: 'string', description: 'Stable id for this question; defaults to "q".' },
        prompt: { type: 'string', description: 'The question shown to the user.' },
        choices: {
          type: 'array',
          description: '2-6 quick-choice chips.',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, label: { type: 'string' } },
            required: ['id', 'label'],
          },
        },
      },
      required: ['prompt', 'choices'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_plan',
    description: PROPOSE_PLAN_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Drawing steps of the plan.',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, label: { type: 'string' } },
            required: ['id', 'label'],
          },
        },
        attributes: {
          type: 'array',
          description: 'Optional pre-draw parameter controls (at most 12).',
          items: { type: 'object' },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
  },
]

const byName = (name: string): ToolDeclaration => {
  const t = AGENT_TOOL_DECLARATIONS.find((d) => d.name === name)
  if (!t) throw new Error(`unknown tool declaration: ${name}`)
  return t
}

/** Tool set offered to the model for the current turn stage. */
export function toolsForStage(stage: Stage, hasArtwork: boolean): ToolDeclaration[] {
  if (stage === 'plan') return [byName('propose_plan'), byName('ask_question')]
  return hasArtwork
    ? [byName('build_svg'), byName('apply_edits'), byName('ask_question')]
    : [byName('build_svg'), byName('ask_question')]
}

export type ToolDispatch =
  | { kind: 'ok'; action: AgentAction; attributeControls?: AttributeControl[] }
  | { kind: 'invalid'; reason: string }

function asRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Map one model tool call onto the internal action union. */
export function actionFromToolCall(call: ToolCall): ToolDispatch {
  const input = asRecord(call.input)
  switch (call.toolName) {
    case 'build_svg': {
      if (!input || typeof input.svg !== 'string' || !input.svg.trim()) {
        return { kind: 'invalid', reason: 'build_svg requires a non-empty "svg" string' }
      }
      const projectName = projectTitle(input.name)
      return {
        kind: 'ok',
        action: { action: 'build', svg: input.svg, ...(projectName ? { projectName } : {}) },
      }
    }
    case 'apply_edits': {
      if (!input || !Array.isArray(input.operations)) {
        return { kind: 'invalid', reason: 'apply_edits requires an "operations" array' }
      }
      return {
        kind: 'ok',
        action: { action: 'edit', operations: { operations: input.operations } },
      }
    }
    case 'ask_question': {
      if (!input) return { kind: 'invalid', reason: 'ask_question requires "prompt" and "choices"' }
      const block = validateChoices({
        questionId: asString(input.questionId) || 'q',
        prompt: asString(input.prompt),
        choices: input.choices,
      })
      if (!block) {
        return {
          kind: 'invalid',
          reason: 'ask_question requires a "prompt" and 2-6 choices, each with id and label',
        }
      }
      return { kind: 'ok', action: { action: 'question', ...block } }
    }
    case 'propose_plan': {
      if (!input || !Array.isArray(input.steps) || input.steps.length === 0) {
        return { kind: 'invalid', reason: 'propose_plan requires a non-empty "steps" array' }
      }
      const rawSteps = input.steps.map((s) => {
        const o = asRecord(s) ?? {}
        return { id: asString(o.id), label: asString(o.label) }
      })
      const action: AgentAction = { action: 'plan', steps: normalizePlanSteps(rawSteps) }
      const attributeControls = Array.isArray(input.attributes)
        ? validateAttributeControls({ attributes: input.attributes })
        : []
      return { kind: 'ok', action, ...(attributeControls.length > 0 ? { attributeControls } : {}) }
    }
    default:
      return { kind: 'invalid', reason: `unknown tool: ${call.toolName}` }
  }
}

export interface ToolResultPayload {
  ok: boolean
  applied?: boolean
  errors?: string[]
  visualReviewIssues?: string[]
}

/**
 * Tool-result `output` fed back into the conversation on retries. The AI SDK
 * ModelMessage schema requires a type-discriminated output, so the structured
 * payload rides in a `{ type: 'json', value }` wrapper.
 */
export function toolResultOutput(payload: ToolResultPayload): { type: 'json'; value: ToolResultPayload } {
  return {
    type: 'json',
    value: {
      ...payload,
      ...(payload.errors !== undefined || !payload.ok ? { errors: payload.errors ?? [] } : {}),
    },
  }
}
