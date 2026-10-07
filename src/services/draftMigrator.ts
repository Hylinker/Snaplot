import { createProject, listProjects, saveContent } from './projectDb'
import { emptyProjectContent } from '../types'
import type { Project, ProjectContent } from '../types'

/**
 * One-time migration of the pre-R5 localStorage draft (written by the former
 * zustand persist middleware under `snaplot.chat.v1` / `snaplot.editor.v1`)
 * into an IndexedDB project named "Imported draft".
 *
 * Deterministic: runs only when no projects exist and the migration flag is
 * absent; on success the legacy keys are removed and the flag is written.
 */

const CHAT_KEY = 'snaplot.chat.v1'
const EDITOR_KEY = 'snaplot.editor.v1'
export const MIGRATION_FLAG = 'snaplot.migrated.v1'

interface PersistedEnvelope<S> {
  state?: S
  version?: number
}

interface PersistedChat {
  messages?: ProjectContent['messages']
  retryableIds?: string[]
  attributeValues?: ProjectContent['attributeValues']
  planConfirmed?: boolean
}

interface PersistedEditor {
  revision?: number
  currentSvg?: string | null
}

function readPersisted<S>(key: string): S | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedEnvelope<S>
    return (parsed.state ?? null) as S | null
  } catch {
    return null
  }
}

/** Read and normalize the legacy draft, or null when there is nothing to migrate. */
export function readLegacyDraft(): ProjectContent | null {
  const chat = readPersisted<PersistedChat>(CHAT_KEY)
  const editor = readPersisted<PersistedEditor>(EDITOR_KEY)
  const hasWork =
    (chat?.messages?.length ?? 0) > 0 || (editor?.currentSvg ?? null) !== null
  if (!hasWork) return null
  const content = emptyProjectContent()
  content.messages = (chat?.messages ?? []).map((m) => ({
    ...m,
    streaming: false,
    error: m.streaming ? 'Response interrupted' : m.error,
  }))
  content.retryableIds = chat?.retryableIds ?? []
  content.attributeValues = chat?.attributeValues ?? {}
  content.planConfirmed = chat?.planConfirmed ?? false
  content.revision = editor?.revision ?? 0
  content.currentSvg = editor?.currentSvg ?? null
  return content
}

/**
 * Migrate the legacy draft if needed. Returns the created project, or null
 * when no migration was necessary. Safe to call repeatedly (idempotent).
 */
export async function migrateLegacyDraft(): Promise<Project | null> {
  if (localStorage.getItem(MIGRATION_FLAG) !== null) return null
  const existing = await listProjects()
  if (existing.length > 0) {
    localStorage.setItem(MIGRATION_FLAG, '1')
    return null
  }
  const content = readLegacyDraft()
  if (!content) {
    localStorage.setItem(MIGRATION_FLAG, '1')
    return null
  }
  const project = await createProject('Imported draft')
  await saveContent(project.id, content)
  localStorage.removeItem(CHAT_KEY)
  localStorage.removeItem(EDITOR_KEY)
  localStorage.setItem(MIGRATION_FLAG, '1')
  return project
}
