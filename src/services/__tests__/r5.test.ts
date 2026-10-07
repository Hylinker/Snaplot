import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createProject,
  deleteProjectRow,
  duplicateProject,
  listProjects,
  loadContent,
  putProject,
  resetProjectDbForTests,
  saveContent,
} from '../projectDb'
import { MIGRATION_FLAG, migrateLegacyDraft } from '../draftMigrator'
import { emptyProjectContent } from '../../types'
import { useProjectsStore } from '../../stores/projects'
import { useChatStore } from '../../stores/chat'
import { useEditorStore } from '../../stores/editor'

const CHAT_KEY = 'snaplot.chat.v1'
const EDITOR_KEY = 'snaplot.editor.v1'

// Lets one test hold deleteProjectRow open past the autosave debounce, so the
// armed save fires while the delete is mid-flight (the audit N4 window).
const deleteStall = vi.hoisted(() => ({ ms: 0 }))

vi.mock('../projectDb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../projectDb')>()
  return {
    ...actual,
    deleteProjectRow: async (id: string) => {
      await actual.deleteProjectRow(id)
      if (deleteStall.ms > 0) {
        await new Promise((resolve) => setTimeout(resolve, deleteStall.ms))
      }
    },
  }
})

// A fresh in-memory IDB factory per test avoids deleteDatabase blocking on
// the still-open cached connection inside projectDb.
function resetDb(): void {
  resetProjectDbForTests()
  Object.defineProperty(globalThis, 'indexedDB', {
    value: new IDBFactory(),
    writable: true,
    configurable: true,
  })
}

beforeEach(async () => {
  resetDb()
  localStorage.clear()
  useProjectsStore.setState({
    projects: [],
    activeProjectId: null,
    status: 'idle',
    error: null,
  })
  useChatStore.getState().clear()
  useEditorStore.getState().clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('projectDb', () => {
  it('creates, lists, updates, and deletes projects', async () => {
    const a = await createProject('A')
    const b = await createProject('B')
    let all = await listProjects()
    expect(all.map((p) => p.name)).toEqual(['B', 'A']) // newest first

    await putProject({ ...a, name: 'A2', updatedAt: a.updatedAt + 5000 })
    all = await listProjects()
    expect(all.find((p) => p.id === a.id)?.name).toBe('A2')

    await deleteProjectRow(a.id)
    expect((await listProjects()).map((p) => p.id)).toEqual([b.id])
    expect(await loadContent(a.id)).toBeUndefined()
  })

  it('duplicates content into a new project', async () => {
    const src = await createProject('Original')
    await saveContent(src.id, {
      ...emptyProjectContent(),
      messages: [{ id: 'm1', role: 'user', text: 'hi' }],
      planConfirmed: true,
      revision: 2,
      currentSvg: '<svg/>',
    })
    const copy = await duplicateProject(src.id, 'Copy')
    expect(copy).not.toBeNull()
    expect(copy!.name).toBe('Copy')
    expect(copy!.id).not.toBe(src.id)
    const content = await loadContent(copy!.id)
    expect(content?.currentSvg).toBe('<svg/>')
    expect(content?.planConfirmed).toBe(true)
    // duplicate of an unknown id is a null result
    expect(await duplicateProject('nope', 'X')).toBeNull()
  })
})

describe('draft migration', () => {
  it('migrates a legacy localStorage draft into an IndexedDB project', async () => {
    localStorage.setItem(
      CHAT_KEY,
      JSON.stringify({
        state: {
          messages: [{ id: 'm1', role: 'user', text: 'draw a cat', streaming: true }],
          retryableIds: [],
          attributeValues: {},
          planConfirmed: true,
        },
        version: 0,
      })
    )
    localStorage.setItem(
      EDITOR_KEY,
      JSON.stringify({
        state: { revision: 3, currentSvg: '<svg cat/>', undoSnapshot: null, undoReason: null },
        version: 0,
      })
    )

    const project = await migrateLegacyDraft()
    expect(project?.name).toBe('Imported draft')
    const content = await loadContent(project!.id)
    expect(content?.messages).toHaveLength(1)
    // mid-stream messages are normalized on migration
    expect(content?.messages[0].streaming).toBe(false)
    expect(content?.currentSvg).toBe('<svg cat/>')
    expect(content?.planConfirmed).toBe(true)
    // deterministic completion: keys removed, flag written
    expect(localStorage.getItem(CHAT_KEY)).toBeNull()
    expect(localStorage.getItem(EDITOR_KEY)).toBeNull()
    expect(localStorage.getItem(MIGRATION_FLAG)).not.toBeNull()
    // idempotent
    expect(await migrateLegacyDraft()).toBeNull()
  })

  it('skips migration when there is no work or projects already exist', async () => {
    expect(await migrateLegacyDraft()).toBeNull() // empty draft
    expect(localStorage.getItem(MIGRATION_FLAG)).not.toBeNull()
    localStorage.removeItem(MIGRATION_FLAG)
    await createProject('Existing')
    expect(await migrateLegacyDraft()).toBeNull()
  })
})

describe('projects store', () => {
  it('init creates a first project when none exist', async () => {
    await useProjectsStore.getState().init()
    const s = useProjectsStore.getState()
    expect(s.status).toBe('ready')
    expect(s.projects).toHaveLength(1)
    expect(s.projects[0].name).toBe('Untitled project')
    expect(s.activeProjectId).toBe(s.projects[0].id)
  })

  it('switching projects isolates content', async () => {
    await useProjectsStore.getState().init()
    const first = useProjectsStore.getState().activeProjectId!
    useChatStore.getState().appendUser('draw a cat')
    useEditorStore.getState().setSvg('<svg cat/>')
    await useProjectsStore.getState().create('Second')
    expect(useProjectsStore.getState().activeProjectId).not.toBe(first)
    expect(useChatStore.getState().messages).toHaveLength(0)
    expect(useEditorStore.getState().currentSvg).toBeNull()

    await useProjectsStore.getState().switchTo(first)
    expect(useChatStore.getState().messages.map((m) => m.text)).toEqual(['draw a cat'])
    expect(useEditorStore.getState().currentSvg).toBe('<svg cat/>')
  })

  it('autosaves content after the debounce once streaming has finished', async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    await useProjectsStore.getState().init()
    const id = useProjectsStore.getState().activeProjectId!
    useChatStore.getState().appendUser('hello')
    useChatStore.getState().setStatus('streaming')
    await sleep(1200)
    // Mid-stream: nothing is written.
    expect((await loadContent(id))?.messages).toHaveLength(0)
    useChatStore.getState().setStatus('idle')
    await sleep(1200)
    expect((await loadContent(id))?.messages.map((m) => m.text)).toEqual(['hello'])
  })

  it('persists a withdraw even when the autosave fires mid-stream', async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    await useProjectsStore.getState().init()
    const id = useProjectsStore.getState().activeProjectId!
    useChatStore.getState().appendUser('draw a cat')
    const assistantId = useChatStore.getState().beginAssistant()
    useChatStore.getState().appendAssistantDelta(assistantId, '```svg\n<svg/>\n```')
    useChatStore.getState().finishAssistant(assistantId, 'artwork-updated')
    // The user withdraws and immediately resends — the save timer fires mid-stream.
    useChatStore.getState().withdraw(assistantId)
    useChatStore.getState().setStatus('streaming')
    await sleep(1200)
    // The dropped save must reschedule, not vanish.
    useChatStore.getState().setStatus('idle')
    await sleep(1200)
    const content = await loadContent(id)
    expect(content?.messages).toHaveLength(0)
  })

  it('deleting the active project switches away without resurrecting it', async () => {
    await useProjectsStore.getState().init()
    const first = useProjectsStore.getState().activeProjectId!
    useChatStore.getState().appendUser('doomed work')
    await useProjectsStore.getState().create('Keeper')
    const second = useProjectsStore.getState().activeProjectId!
    await useProjectsStore.getState().switchTo(first)
    await useProjectsStore.getState().remove(first)
    const s = useProjectsStore.getState()
    expect(s.activeProjectId).toBe(second)
    expect(s.projects.map((p) => p.id)).toEqual([second])
    // The removed project's content row is gone and was not resurrected by
    // the internal switch (which must skip flushing the doomed stores).
    expect(await loadContent(first)).toBeUndefined()
  })

  it('a save scheduled before delete cannot resurrect the project', async () => {
    await useProjectsStore.getState().init()
    const first = useProjectsStore.getState().activeProjectId!
    await useProjectsStore.getState().create('Keeper')
    const second = useProjectsStore.getState().activeProjectId!
    await useProjectsStore.getState().switchTo(first)

    // Hold the delete open past the 800ms autosave debounce: the armed save
    // fires while the doomed id is still the active project, exactly the
    // window that used to re-create the deleted content row.
    deleteStall.ms = 1000
    try {
      useChatStore.getState().appendUser('doomed work')
      await useProjectsStore.getState().remove(first)
    } finally {
      deleteStall.ms = 0
    }

    expect(await loadContent(first)).toBeUndefined()
    expect(useProjectsStore.getState().activeProjectId).toBe(second)
  })

  it('flushing mid-stream omits the incomplete assistant reply', async () => {
    await useProjectsStore.getState().init()
    const id = useProjectsStore.getState().activeProjectId!
    useChatStore.getState().appendUser('draw a cat')
    const assistantId = useChatStore.getState().beginAssistant()
    useChatStore.getState().appendAssistantDelta(assistantId, 'partial ```svg\n<svg')

    // Switch/create flushes while the turn streams: the user message is kept,
    // the half-written reply is not persisted.
    await useProjectsStore.getState().flush()
    const content = await loadContent(id)
    expect(content?.messages.map((m) => m.role)).toEqual(['user'])
    expect(content?.messages[0]?.text).toBe('draw a cat')
  })

  it('renames and duplicates update the project list', async () => {
    await useProjectsStore.getState().init()
    const id = useProjectsStore.getState().activeProjectId!
    await useProjectsStore.getState().rename(id, 'Renamed')
    expect(useProjectsStore.getState().projects[0].name).toBe('Renamed')
    const copy = await useProjectsStore.getState().duplicate(id)
    expect(copy?.name).toBe('Renamed (copy)')
    expect(useProjectsStore.getState().projects).toHaveLength(2)
  })
})
