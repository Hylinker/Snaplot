import { useEffect, useMemo, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import { useChatStore, annotatePlanSteps, findLatestPlan, findTurnUserIndex, type AnnotatedPlanStep } from '@/stores/chat'
import { useEditorStore } from '@/stores/editor'
import { useSettingsStore } from '@/stores/settings'
import { sendChatMessage } from '@/services/agentRunner'
import { sendVisualReviewTurn } from '@/services/visionReview'
import { MAX_ATTACHMENTS_PER_MESSAGE, normalizeImageFile } from '@/services/imageAttach'
import { extractJson } from '@/svg/extract'
import type { UiMessage } from '@/types'
import {
  validateAttributeControls,
  applyDefaults,
  type AttributeControl,
} from '@/svg/attributes'
import { SettingsPanel } from '@/components/SettingsPanel'
import { MessageItem } from '@/components/chat/MessageItem'
import { AttributeControls } from '@/components/chat/AttributeControls'
import { ChatComposer, type PendingAttachment } from '@/components/chat/ChatComposer'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

/** Chat column: settings, message thread, parameter panel and composer. */
export function ChatPanel() {
  const retryableIds = useChatStore((s) => s.retryableIds)
  const messages = useChatStore((s) => s.messages)
  const status = useChatStore((s) => s.status)
  const lastError = useChatStore((s) => s.lastError)
  const attributeValues = useChatStore((s) => s.attributeValues)
  const setAttributeValue = useChatStore((s) => s.setAttributeValue)
  const planConfirmed = useChatStore((s) => s.planConfirmed)
  const planStepEdits = useChatStore((s) => s.planStepEdits)
  const input = useChatStore((s) => s.draft)
  const setInput = useChatStore((s) => s.setDraft)
  const [showSettings, setShowSettings] = useState(false)
  const [pendingBuild, setPendingBuild] = useState<{ text: string; images: string[] } | null>(null)
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const attachSeq = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const settingsBtnRef = useRef<HTMLButtonElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const isConfigured = useSettingsStore((s) => s.isConfigured())
  const askBeforeDraw = useSettingsStore((s) => s.askBeforeDraw)
  const hasArtwork = useEditorStore((s) => Boolean(s.currentSvg))
  const selection = useEditorStore((s) => s.selection)
  const streaming = status === 'streaming'

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  // Attribute controls proposed by the most recent assistant message: the
  // structured payload from plan tool calls, with the legacy fenced block in
  // raw text as fallback for older projects.
  const controls: AttributeControl[] = useMemo(() => {
    const last = [...messages].reverse().find(
      (m) => m.role === 'assistant' && (m.attributeControls?.length || m.raw)
    )
    if (last?.attributeControls?.length) return last.attributeControls
    if (!last?.raw) return []
    const payload = extractJson(last.raw, 'snaplot-attributes')
    return payload ? validateAttributeControls(payload) : []
  }, [messages])
  const values = useMemo(
    () => (controls.length ? applyDefaults(controls, attributeValues) : {}),
    [controls, attributeValues]
  )

  // The pending plan derives from persisted messages (reload-proof): the
  // latest plan reply while the first artwork does not exist and no plan is
  // confirmed. Mid-stream it is suspended — a revision reply is landing.
  const pendingPlan = useMemo(
    () => (!hasArtwork && !planConfirmed && !streaming ? findLatestPlan(messages) : null),
    [hasArtwork, planConfirmed, streaming, messages]
  )

  // The latest plan reply without gates: checklist display follows it so the
  // user's adjustments survive (read-only) after the plan is confirmed and
  // built, until a newer plan supersedes it. Editability stays with pendingPlan.
  const latestPlan = useMemo(() => findLatestPlan(messages), [messages])

  // Checklist steps per plan reply: edits apply only to the latest plan;
  // older plan replies render their proposed steps as confirmed or superseded.
  const annotatedStepsFor = (m: UiMessage): AnnotatedPlanStep[] | undefined =>
    (m.planSteps?.length ?? 0) > 0
      ? m.id === latestPlan?.id
        ? annotatePlanSteps(m.planSteps!, planStepEdits)
        : m.planSteps!.map((s) => ({ ...s, included: true }))
      : undefined

  const isStalePlan = (m: UiMessage): boolean =>
    ((m.planSteps?.length ?? 0) > 0 ||
      Boolean(m.chips?.some((c) => c.id === 'confirm-draw'))) &&
    m.id !== pendingPlan?.id

  const dispatch = (text: string, images: string[] = []) => {
    sendChatMessage(text, images).catch((e) => {
      // Defense in depth: sendChatMessage is expected to be non-throwing.
      console.error('[snaplot] sendChatMessage failed:', e)
      useChatStore.getState().setStatus('error', (e as Error).message)
    })
  }

  const send = (text?: string, images?: string[]) => {
    const value = (text ?? input).trim()
    const imgs = images ?? attachments.map((a) => a.dataUrl)
    if ((!value && imgs.length === 0) || streaming) return
    // A pending plan turns typed text into revision feedback, not a build
    // request — the ask-before-draw gate only applies to fresh generation.
    if (askBeforeDraw && !hasArtwork && !pendingPlan) {
      // Confirmation step instead of immediate generation.
      setPendingBuild({ text: value, images: imgs })
      return
    }
    setInput('')
    setAttachments([])
    setAttachError(null)
    dispatch(value, imgs)
  }

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return
    const room = MAX_ATTACHMENTS_PER_MESSAGE - attachments.length
    if (room <= 0) {
      setAttachError(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} images per message`)
      return
    }
    const accepted = files.slice(0, room)
    let error: string | null =
      files.length > accepted.length
        ? `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} images per message — added the first ${accepted.length}`
        : null
    for (const file of accepted) {
      const result = await normalizeImageFile(file)
      if (result.ok) {
        const dataUrl = result.dataUrl
        setAttachments((prev) => [...prev, { id: `att-${++attachSeq.current}`, dataUrl }])
      } else {
        error = result.error
      }
    }
    setAttachError(error)
  }

  const interpretation = !hasArtwork
    ? pendingPlan
      ? 'Awaiting confirmation'
      : planConfirmed
        ? 'Will create'
        : 'Planning'
    : 'Will edit'

  const onWithdraw = (messageId: string) => {
    const msgs = useChatStore.getState().messages
    const i = msgs.findIndex((m) => m.id === messageId)
    // The user message being removed goes back into the input box. Standalone
    // replies (manual visual review) have no user message of their own — the
    // composer keeps whatever it held.
    const turnUserIndex = i === -1 ? -1 : findTurnUserIndex(msgs, i)
    const turnUser = turnUserIndex === -1 ? undefined : msgs[turnUserIndex]
    const svgBefore = useChatStore.getState().withdraw(messageId)
    // Legacy messages without a snapshot: keep the canvas as-is.
    if (svgBefore !== undefined) {
      useEditorStore.getState().restoreSvg(svgBefore)
    }
    if (turnUser?.text !== undefined) setInput(turnUser.text)
    setAttachments(
      (turnUser?.images ?? []).map((dataUrl) => ({
        id: `att-${++attachSeq.current}`,
        dataUrl,
      }))
    )
  }

  const onChipClick = (chip: { id: string; label: string }, messageId: string) => {
    if (!isConfigured) return
    if (chip.id === 'request-changes') {
      // Input affordance, not a turn: focus the composer for revision feedback.
      composerRef.current?.focus()
      return
    }
    // Confirming the plan lets the next turn enter build mode; checklist edits
    // ride along via the system-side CONFIRMED PLAN STEPS injection (with a
    // Checklist adjustments line), so the chat stays free of duplication.
    if (chip.id === 'confirm-draw') {
      useChatStore.getState().setPlanConfirmed(true)
    }
    useChatStore.getState().markChipUsed(messageId, chip.id)
    setInput('')
    // Choice chips are model-driven turns; skip the ask-before-draw gate.
    dispatch(chip.label)
  }

  const onPlanStepToggle = (stepId: string) => {
    const plan = pendingPlan
    if (!plan?.planSteps?.length) return
    const step = annotatePlanSteps(
      plan.planSteps,
      useChatStore.getState().planStepEdits
    ).find((s) => s.id === stepId)
    if (!step) return
    useChatStore.getState().setPlanStepEdit(stepId, {
      included: !step.included,
      label: step.label,
    })
  }

  const onPlanStepRename = (stepId: string, label: string) => {
    if (!label.trim()) return // a label cannot be emptied; the input snaps back
    const plan = pendingPlan
    if (!plan?.planSteps?.length) return
    const step = annotatePlanSteps(
      plan.planSteps,
      useChatStore.getState().planStepEdits
    ).find((s) => s.id === stepId)
    if (!step) return
    useChatStore.getState().setPlanStepEdit(stepId, { included: step.included, label })
  }

  const onRetry = (messageId: string, text: string, images: string[] = []) => {
    if (!isConfigured) return
    useChatStore.getState().markRetryable(messageId, false)
    dispatch(text, images)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Chat</span>
        <Badge variant="secondary">{interpretation}</Badge>
        <Button
          ref={settingsBtnRef}
          variant="outline"
          size="icon-sm"
          className="ml-auto"
          onClick={() => setShowSettings(true)}
          aria-label="Settings"
          title="Open provider settings"
        >
          <Settings />
        </Button>
      </div>

      {showSettings && (
        <SettingsPanel
          onClose={() => {
            setShowSettings(false)
            // The dialog unmount resets focus to <body>; restore it after that.
            requestAnimationFrame(() => settingsBtnRef.current?.focus())
          }}
        />
      )}

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {messages.length === 0 && (
          <p className="mt-8 text-center text-sm text-muted-foreground/70">
            {isConfigured
              ? 'Describe the artwork you want to create.'
              : 'Configure a provider in Settings to begin.'}
          </p>
        )}
        {messages.map((m, i) => {
          const retryable =
            m.role === 'assistant' && !m.streaming && (retryableIds as string[]).includes(m.id)
          const turnUserIndex = retryable ? findTurnUserIndex(messages, i) : -1
          const turnUser = turnUserIndex === -1 ? undefined : messages[turnUserIndex]
          return (
            <MessageItem
              key={m.id}
              message={m}
              streaming={streaming}
              retryable={retryable}
              turnUserText={turnUser?.text}
              turnUserImages={turnUser?.images}
              planStepsAnnotated={annotatedStepsFor(m)}
              planEditable={m.id === pendingPlan?.id}
              onPlanStepToggle={onPlanStepToggle}
              onPlanStepRename={onPlanStepRename}
              chipsDisabled={isStalePlan(m)}
              onChipClick={onChipClick}
              onRetry={onRetry}
              onWithdraw={onWithdraw}
            />
          )
        })}
        {status === 'error' && lastError && (
          <Alert variant="destructive" className="mb-3">
            <AlertDescription className="text-xs">{lastError}</AlertDescription>
          </Alert>
        )}
      </div>

      {controls.length > 0 && (
        <AttributeControls controls={controls} values={values} onChange={setAttributeValue} />
      )}

      {pendingBuild !== null && (
        <div className="flex items-center gap-2 border-t border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span className="flex-1 truncate">
            Generate artwork for “{pendingBuild.text || 'the attached image'}”?
          </span>
          <Button
            size="sm"
            onClick={() => {
              if (!isConfigured) return
              const v = pendingBuild
              setPendingBuild(null)
              setInput('')
              setAttachments([])
              setAttachError(null)
              // Confirming the gate lets the next turn enter build mode.
              useChatStore.getState().setPlanConfirmed(true)
              dispatch(v.text, v.images)
            }}
          >
            Yes, draw
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPendingBuild(null)}>
            No
          </Button>
        </div>
      )}

      {selection?.id && (
        <div className="flex items-center gap-2 border-t border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary">
          <span className="flex-1 truncate">
            🎯 Target element: &lt;{selection.tagName}&gt; {selection.id}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => useEditorStore.getState().setSelection(null)}
          >
            Cancel
          </Button>
        </div>
      )}

      <ChatComposer
        input={input}
        onInputChange={setInput}
        onSend={() => send()}
        onCancel={() => useChatStore.getState().cancelActive()}
        onVisualReview={() => {
          sendVisualReviewTurn().catch((e) => {
            console.error('[snaplot] visual review failed:', e)
            useChatStore.getState().setStatus('error', (e as Error).message)
          })
        }}
        streaming={streaming}
        isConfigured={isConfigured}
        hasArtwork={hasArtwork}
        planPending={Boolean(pendingPlan)}
        textareaRef={composerRef}
        attachments={attachments}
        onFiles={handleFiles}
        onRemoveAttachment={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
        attachError={attachError}
      />
    </div>
  )
}
