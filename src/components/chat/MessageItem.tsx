import { parseReply } from '@/services/actionEnvelope'
import { extractJson, hasOpenFence } from '@/svg/extract'
import { validateChoices } from '@/svg/choices'
import { Undo2 } from 'lucide-react'
import type { UiMessage } from '@/types'
import { cn } from '@/lib/utils'
import { Markdown } from '@/components/Markdown'
import { ReasoningBlock } from '@/components/chat/ReasoningBlock'
import { PlanChecklist } from '@/components/chat/PlanChecklist'
import { Button } from '@/components/ui/button'
import type { AnnotatedPlanStep } from '@/stores/chat'

const OUTCOME_LABEL: Record<string, string> = {
  'artwork-updated': 'Artwork updated',
  rejected: 'Edit rejected',
  question: 'Question',
  plan: 'Plan',
}

// Progress copy per streaming tool; unknown names fall back to a generic cue.
const TOOL_PROGRESS_LABEL: Record<string, string> = {
  build_svg: 'Generating artwork…',
  apply_edits: 'Applying edits…',
  ask_question: 'Preparing a question…',
  propose_plan: 'Drafting a plan…',
}

interface MessageItemProps {
  message: UiMessage
  /** Panel-level streaming status; hides chips and actions mid-turn. */
  streaming: boolean
  retryable: boolean
  /** Text of the user message in this turn, offered to Retry. */
  turnUserText?: string
  /** Images attached to the user message in this turn, offered to Retry. */
  turnUserImages?: string[]
  /** Checklist steps for a plan reply, edits applied (defaults when not pending). */
  planStepsAnnotated?: AnnotatedPlanStep[]
  /** True while this plan reply is the pending plan awaiting confirmation
   *  (keeps its checklist editable and re-enables its spent chips). */
  planEditable?: boolean
  onPlanStepToggle: (stepId: string) => void
  onPlanStepRename: (stepId: string, label: string) => void
  /** True when this reply's chips are stale (e.g. a superseded plan). */
  chipsDisabled?: boolean
  onChipClick: (chip: { id: string; label: string }, messageId: string) => void
  onRetry: (messageId: string, text: string, images?: string[]) => void
  onWithdraw: (messageId: string) => void
}

// Legacy fallback: choices parsed from envelope text (projects created before
// tool calling); new replies carry structured chips on the message instead.
function messageChips(m: UiMessage): { id: string; label: string }[] | null {
  const envelope = m.role === 'assistant' && m.raw ? parseReply(m.raw) : null
  if (envelope?.kind === 'ok' && envelope.action.action === 'question') {
    return envelope.action.choices
  }
  if (envelope?.kind === 'ok' && envelope.action.action === 'plan') {
    return [{ id: 'confirm-draw', label: 'Looks good, draw it' }]
  }
  const choices = m.role === 'assistant' && m.raw ? extractJson(m.raw, 'snaplot-choices') : null
  const validChoices = choices ? validateChoices(choices) : null
  return validChoices?.choices ?? null
}

/** One chat turn: reasoning, bubble, outcome, plan checklist, chips and retry affordances. */
export function MessageItem({
  message: m,
  streaming,
  retryable,
  turnUserText,
  turnUserImages,
  planStepsAnnotated,
  planEditable,
  onPlanStepToggle,
  onPlanStepRename,
  chipsDisabled,
  onChipClick,
  onRetry,
  onWithdraw,
}: MessageItemProps) {
  const chips = m.chips ?? messageChips(m)
  const checklist =
    m.role === 'assistant' && (m.planSteps?.length ?? 0) > 0
      ? (planStepsAnnotated ?? m.planSteps!.map((s) => ({ ...s, included: true })))
      : null
  // The artwork payload (fenced block or tool arguments) can suppress display
  // text while streaming, so show an explicit progress cue instead of a bare
  // ellipsis.
  const payloadStreaming =
    m.role === 'assistant' &&
    Boolean(m.streaming) &&
    (hasOpenFence(m.raw ?? '') || Boolean(m.toolActive))
  const progressLabel = m.toolActive
    ? (TOOL_PROGRESS_LABEL[m.toolActive] ?? 'Working…')
    : 'Generating artwork…'
  return (
    <div className={`mb-3 flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div className={`min-w-0 group ${m.role === 'user' ? 'max-w-[85%]' : 'w-full max-w-3xl'}`}>
        {m.role === 'assistant' && m.reasoning && (
          <ReasoningBlock reasoning={m.reasoning} streaming={Boolean(m.streaming)} />
        )}
        <div
          className={`text-sm ${
            m.role === 'user'
              ? 'rounded-lg bg-primary px-3 py-1.5 text-primary-foreground'
              : 'py-1 text-foreground'
          }`}
        >
          {m.role === 'user' && m.images && m.images.length > 0 && (
            <div className="mb-1 flex flex-col items-end gap-1">
              {m.images.map((src, idx) => (
                <img
                  key={idx}
                  src={src}
                  alt={`Attached reference image ${idx + 1}`}
                  className="max-h-40 max-w-full rounded-md border border-primary-foreground/20"
                />
              ))}
            </div>
          )}
          {m.role === 'assistant' ? (
            m.text ? (
              <Markdown text={m.text} />
            ) : m.streaming && !payloadStreaming ? (
              '…'
            ) : null
          ) : (
            m.text
          )}
          {m.streaming && !payloadStreaming && <span className="ml-1 animate-pulse">▍</span>}
          {payloadStreaming && (
            <div className="mt-1 animate-pulse text-[11px] text-muted-foreground">
              {progressLabel}
            </div>
          )}
          {m.role === 'user' && m.selection && (
            <div className="mt-1 text-[11px] text-primary-foreground/70">
              → &lt;{m.selection.tagName}&gt; {m.selection.id}
            </div>
          )}
          {(m.outcome || (m.role === 'assistant' && !m.streaming)) && (
            <div className="mt-1 flex items-center gap-2">
              {m.outcome && (
                <div className="text-[11px] text-muted-foreground">{OUTCOME_LABEL[m.outcome]}</div>
              )}
              {m.role === 'assistant' && !m.streaming && !streaming && (
                <button
                  className="inline-flex size-6 items-center justify-center rounded-full border text-muted-foreground opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100"
                  aria-label="Withdraw this reply"
                  title="Withdraw this reply and all edits after it"
                  onClick={() => onWithdraw(m.id)}
                >
                  <Undo2 className="size-3" />
                </button>
              )}
            </div>
          )}
          {m.error && <div className="mt-1 text-[11px] text-destructive">{m.error}</div>}
        </div>
        {checklist && !streaming && !m.streaming && (
          <PlanChecklist
            steps={checklist}
            editable={Boolean(planEditable)}
            onToggle={onPlanStepToggle}
            onRename={onPlanStepRename}
          />
        )}
        {chips && !streaming && (
          <div className="mt-1 flex flex-wrap gap-1">
            {chips.map((c) => {
              const used = m.chipsUsed?.includes(c.id) ?? false
              // A re-armed pending plan (e.g. after withdrawing the build it
              // confirmed) offers its chips again: chipsUsed records click
              // history, not a latch — chip liveness derives from the plan
              // being pending.
              const spent = (used && !planEditable) || Boolean(chipsDisabled)
              return (
                <button
                  key={c.id}
                  disabled={spent}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs transition-colors',
                    spent
                      ? 'cursor-not-allowed border-border bg-muted/50 text-muted-foreground'
                      : 'border-primary/40 bg-primary/5 text-primary hover:bg-primary/10'
                  )}
                  onClick={() => onChipClick(c, m.id)}
                >
                  {c.label}
                </button>
              )
            })}
          </div>
        )}
        {retryable && turnUserText !== undefined && (
          <div className="mt-1">
            <Button
              variant="outline"
              size="sm"
              className="h-auto rounded-full border-amber-300 bg-amber-50 px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-100"
              onClick={() => onRetry(m.id, turnUserText, turnUserImages ?? [])}
            >
              Retry
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
