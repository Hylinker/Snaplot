import { useRef, type RefObject } from 'react'
import { ArrowUp, Eye, ImagePlus, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ATTACH_ACCEPT } from '@/services/imageAttach'

/** One pending attachment in the composer (the id is the React key). */
export interface PendingAttachment {
  id: string
  dataUrl: string
}

interface ChatComposerProps {
  input: string
  onInputChange: (value: string) => void
  onSend: () => void
  onCancel: () => void
  onVisualReview: () => void
  streaming: boolean
  isConfigured: boolean
  hasArtwork: boolean
  /** True while a plan awaits confirmation — switches the placeholder wording. */
  planPending?: boolean
  /** Forwarded to the textarea so chips can focus it (e.g. "Request changes"). */
  textareaRef?: RefObject<HTMLTextAreaElement | null>
  attachments: PendingAttachment[]
  /** Unified entry for picked, pasted and dropped files. */
  onFiles: (files: File[]) => void
  onRemoveAttachment: (id: string) => void
  attachError: string | null
}

/** Message composer: attachments, textarea, and visual-review / send controls. */
export function ChatComposer({
  input,
  onInputChange,
  onSend,
  onCancel,
  onVisualReview,
  streaming,
  isConfigured,
  hasArtwork,
  planPending,
  textareaRef,
  attachments,
  onFiles,
  onRemoveAttachment,
  attachError,
}: ChatComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const imageFiles = (list: FileList | null): File[] =>
    Array.from(list ?? []).filter((f) => f.type.startsWith('image/'))

  return (
    <div
      className="border-t p-2"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const files = imageFiles(e.dataTransfer.files)
        if (files.length) onFiles(files)
      }}
    >
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <div key={a.id} className="relative">
              <img
                src={a.dataUrl}
                alt="Attached image"
                className="h-16 w-16 rounded-md border object-cover"
              />
              <button
                type="button"
                className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground hover:bg-muted"
                aria-label="Remove attachment"
                onClick={() => onRemoveAttachment(a.id)}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept={ATTACH_ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            onFiles(imageFiles(e.target.files))
            e.target.value = ''
          }}
        />
        <Button
          variant="outline"
          className="size-10 shrink-0 rounded-full"
          disabled={!isConfigured}
          title="Attach images"
          aria-label="Attach images"
          onClick={() => fileInputRef.current?.click()}
        >
          <ImagePlus className="size-5" />
        </Button>
        <Textarea
          ref={textareaRef}
          className="min-h-[2.5rem] flex-1 resize-y text-sm"
          placeholder={
            !isConfigured
              ? 'Configure Settings first…'
              : planPending
                ? 'Suggest changes to the plan, or tap “Looks good, draw it”…'
                : 'Describe artwork or request a change…'
          }
          value={input}
          disabled={!isConfigured}
          rows={2}
          onChange={(e) => onInputChange(e.target.value)}
          onPaste={(e) => {
            const files = imageFiles(e.clipboardData.files)
            if (files.length) {
              e.preventDefault()
              onFiles(files)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSend()
            }
          }}
        />
        <Button
          variant="outline"
          className="size-10 shrink-0 rounded-full"
          disabled={!isConfigured || streaming || !hasArtwork}
          title="Visual review — send a screenshot of the artwork to the vision model"
          aria-label="Visual review"
          onClick={onVisualReview}
        >
          <Eye className="size-5" />
        </Button>
        <Button
          className="size-10 shrink-0 rounded-full"
          disabled={streaming ? !isConfigured : !isConfigured || (!input.trim() && attachments.length === 0)}
          title={streaming ? 'Stop' : 'Send'}
          aria-label={streaming ? 'Stop' : 'Send'}
          onClick={() => (streaming ? onCancel() : onSend())}
        >
          {streaming ? <Square className="size-4" /> : <ArrowUp className="size-5" />}
        </Button>
      </div>
      {attachError && <p className="mt-1 text-xs text-destructive">{attachError}</p>}
    </div>
  )
}
