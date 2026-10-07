import { cn } from '@/lib/utils'

interface ReasoningBlockProps {
  reasoning: string
  streaming: boolean
}

/**
 * Collapsible reasoning panel for assistant messages. Uses the native
 * details/summary pair so it stays uncontrolled: it auto-opens while
 * streaming and afterwards keeps whatever state the user chose.
 */
export function ReasoningBlock({ reasoning, streaming }: ReasoningBlockProps) {
  return (
    <details className="mb-1 rounded-lg border bg-muted/40 px-2 py-1" open={streaming || undefined}>
      <summary
        className={cn(
          'cursor-pointer select-none text-[11px] text-muted-foreground',
          streaming && 'animate-pulse'
        )}
      >
        {streaming ? 'Thinking…' : 'Thought process'}
      </summary>
      <div className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
        {streaming ? (reasoning.split('\n').filter((l) => l.trim()).pop() ?? '') : reasoning}
      </div>
    </details>
  )
}
