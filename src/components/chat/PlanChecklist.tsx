import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import type { AnnotatedPlanStep } from '@/stores/chat'

interface PlanChecklistProps {
  steps: AnnotatedPlanStep[]
  /** True only while this message is the live pending plan awaiting confirmation. */
  editable: boolean
  onToggle: (stepId: string) => void
  onRename: (stepId: string, label: string) => void
}

/** Drawing-step checklist under a plan reply: uncheck to skip a step, click a label to rename. */
export function PlanChecklist({ steps, editable, onToggle, onRename }: PlanChecklistProps) {
  return (
    <div className="mt-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5">
      {editable && (
        <p className="px-6 pb-1 text-[11px] text-muted-foreground">
          Uncheck a step to skip it; click a label to rename.
        </p>
      )}
      <ul className="space-y-0.5">
        {steps.map((s) => (
          <li key={s.id} className="flex items-center gap-2">
            <Checkbox
              checked={s.included}
              disabled={!editable}
              onCheckedChange={() => onToggle(s.id)}
              aria-label={s.included ? `Exclude step: ${s.label}` : `Include step: ${s.label}`}
            />
            {editable ? (
              <input
                className="min-w-0 flex-1 rounded-sm border border-transparent bg-transparent px-1 py-0.5 text-xs text-foreground outline-none transition-colors hover:border-border focus-visible:border-border"
                value={s.label}
                aria-label="Step label"
                onChange={(e) => onRename(s.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
                }}
              />
            ) : (
              <span
                className={cn(
                  'text-xs text-foreground',
                  !s.included && 'text-muted-foreground line-through'
                )}
              >
                {s.label}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
