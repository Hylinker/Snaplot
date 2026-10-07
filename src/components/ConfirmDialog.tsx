import { useRef } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

/** A pending confirmation; rendered by ConfirmDialog until resolved. */
export interface ConfirmRequest {
  title: string
  description?: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void
}

interface ConfirmDialogProps {
  request: ConfirmRequest | null
  onClose: () => void
}

/**
 * Controlled confirmation dialog replacing window.confirm call sites.
 * Pass null to close; the confirm button runs request.onConfirm. The last
 * non-null request is kept for the exit animation so the dialog does not
 * flash empty content while fading out.
 */
export function ConfirmDialog({ request, onClose }: ConfirmDialogProps) {
  const lastRequestRef = useRef<ConfirmRequest | null>(null)
  if (request) lastRequestRef.current = request
  const shown = request ?? lastRequestRef.current

  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{shown?.title}</AlertDialogTitle>
          {shown?.description && (
            <AlertDialogDescription>{shown.description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={shown?.destructive ? 'destructive' : 'default'}
            onClick={shown?.onConfirm}
          >
            {shown?.confirmLabel ?? 'Continue'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
