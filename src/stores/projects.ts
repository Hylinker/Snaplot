import { create } from 'zustand'
import type { Project, ProjectContent } from '../types'
import { emptyProjectContent } from '../types'
import {
  createProject as dbCreateProject,
  deleteProjectRow,
  duplicateProject as dbDuplicateProject,
  listProjects,
  loadContent,
  putProject,
  saveContent,
} from '../services/projectDb'
import { migrateLegacyDraft } from '../services/draftMigrator'
import { useChatStore } from './chat'
import { useEditorStore } from './editor'

const ACTIVE_KEY = 'snaplot.activeProject.v1'
const AUTOSAVE_DEBOUNCE_MS = 800

/** Name given to every project the user (or the LLM) has not named yet. */
export const DEFAULT_PROJECT_NAME = 'Untitled project'

export type ProjectsStatus = 'idle' | 'loading' | 'ready' | 'error'

interface ProjectsState {
  projects: Project[]
  activeProjectId: string | null
  status: ProjectsStatus
  error: string | null
  init: () => Promise<void>
  /** Flush any pending debounced save immediately. */
  flush: () => Promise<void>
  create: (name?: string) => Promise<Project>
  rename: (id: string, name: string) => Promise<void>
  duplicate: (id: string) => Promise<Project | null>
  remove: (id: string) => Promise<void>
  switchTo: (id: string, opts?: { skipFlush?: boolean }) => Promise<void>
}

/** True while a switch/hydrate is running; suppresses autosave. */
let switching = false
/** Serializes switch transitions so rapid switches cannot interleave. */
let switchChain: Promise<void> = Promise.resolve()
let saveTimer: ReturnType<typeof setTimeout> | null = null
let subscriptionsSetUp = false

export function snapshotContent(): ProjectContent {
  const chat = useChatStore.getState()
  const editor = useEditorStore.getState()
  return {
    // A message still streaming is deliberately omitted: a flush during a
    // turn must not bake the half-written reply into the persisted project
    // (the switch/create dialog promises the incomplete reply is discarded).
    messages: chat.messages.filter((m) => !m.streaming),
    retryableIds: chat.retryableIds,
    attributeValues: chat.attributeValues,
    planConfirmed: chat.planConfirmed,
    planStepEdits: chat.planStepEdits,
    draft: chat.draft,
    revision: editor.revision,
    manualRevision: editor.manualRevision,
    currentSvg: editor.currentSvg,
  }
}

function applyContent(content: ProjectContent): void {
  useChatStore.getState().hydrate(content)
  useEditorStore.getState().hydrate(content)
}

async function persistActiveContent(): Promise<void> {
  const { activeProjectId, projects } = useProjectsStore.getState()
  if (!activeProjectId) return
  // Persist the live canvas, not a pre-debounce snapshot of it.
  useEditorStore.getState().flushLiveCanvas()
  if (!useProjectsStore.getState().projects.some((p) => p.id === activeProjectId)) return
  await saveContent(activeProjectId, snapshotContent())
  const project = projects.find((p) => p.id === activeProjectId)
  if (project) {
    const updated = { ...project, updatedAt: Date.now() }
    await putProject(updated)
    useProjectsStore.setState((s) => ({
      projects: s.projects
        .map((p) => (p.id === updated.id ? updated : p))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    }))
  }
}

function scheduleAutosave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    // Never write mid-turn: partial streams would replace whole content.
    // Reschedule instead of dropping — otherwise a change made just before a
    // turn (e.g. withdrawing a reply) could never be persisted.
    if (
      switching ||
      useChatStore.getState().status === 'streaming'
    ) {
      scheduleAutosave()
      return
    }
    const { activeProjectId, status } = useProjectsStore.getState()
    if (!activeProjectId || status !== 'ready') return
    void persistActiveContent().catch((e) =>
      useProjectsStore.setState({ error: String(e ?? 'Failed to save project') })
    )
  }, AUTOSAVE_DEBOUNCE_MS)
}

function setupSubscriptions(): void {
  if (subscriptionsSetUp) return
  subscriptionsSetUp = true
  useChatStore.subscribe(scheduleAutosave)
  useEditorStore.subscribe(scheduleAutosave)
  // Persist immediately when the tab is hidden or closed, so a withdraw
  // cannot be lost to a reload racing the debounced autosave.
  const flushOnUnload = () => {
    if (useChatStore.getState().status === 'streaming') return
    if (!useProjectsStore.getState().activeProjectId) return
    void useProjectsStore.getState().flush()
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnUnload()
  })
  window.addEventListener('pagehide', flushOnUnload)
}

function setActiveProjectId(id: string | null): void {
  if (id === null) localStorage.removeItem(ACTIVE_KEY)
  else localStorage.setItem(ACTIVE_KEY, id)
  useProjectsStore.setState({ activeProjectId: id })
}

export const useProjectsStore = create<ProjectsState>()((set, get) => ({
  projects: [],
  activeProjectId: null,
  status: 'idle',
  error: null,

  init: async () => {
    setupSubscriptions()
    set({ status: 'loading', error: null })
    try {
      await migrateLegacyDraft()
      let projects = await listProjects()
      if (projects.length === 0) {
        const created = await dbCreateProject(DEFAULT_PROJECT_NAME)
        projects = [created]
      }
      const storedId = localStorage.getItem(ACTIVE_KEY)
      const active =
        projects.find((p) => p.id === storedId)?.id ?? projects[0].id
      const content = (await loadContent(active)) ?? emptyProjectContent()
      switching = true
      try {
        applyContent(content)
      } finally {
        switching = false
      }
      setActiveProjectId(active)
      set({ projects, status: 'ready' })
    } catch (e) {
      set({ status: 'error', error: String(e ?? 'Failed to load projects') })
    }
  },

  flush: async () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    await persistActiveContent()
  },

  create: async (name = DEFAULT_PROJECT_NAME) => {
    // A live turn belongs to the outgoing project — cancel it before the
    // stores are replaced, so its continuation cannot land here (audit A1).
    useChatStore.getState().cancelActive()
    // Save the outgoing work before replacing the stores.
    await get().flush()
    const project = await dbCreateProject(name)
    switching = true
    try {
      applyContent(emptyProjectContent())
    } finally {
      switching = false
    }
    setActiveProjectId(project.id)
    set((s) => ({ projects: [project, ...s.projects] }))
    return project
  },

  rename: async (id, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const project = get().projects.find((p) => p.id === id)
    if (!project) return
    const updated = { ...project, name: trimmed, updatedAt: Date.now() }
    await putProject(updated)
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? updated : p)),
    }))
  },

  duplicate: async (id) => {
    const source = get().projects.find((p) => p.id === id)
    if (!source) return null
    const copy = await dbDuplicateProject(id, `${source.name} (copy)`)
    if (!copy) return null
    set((s) => ({ projects: [copy, ...s.projects] }))
    return copy
  },

  remove: async (id) => {
    // Cancel any armed autosave first: a timer firing during the awaits below
    // would still see the doomed project as active and resurrect its content
    // row after the delete (audit N4).
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    await deleteProjectRow(id)
    const remaining = (await listProjects()).filter((p) => p.id !== id)
    if (get().activeProjectId !== id) {
      set({ projects: remaining })
      return
    }
    if (remaining.length > 0) {
      // skipFlush: the removed project's stores hold work we are discarding.
      await get().switchTo(remaining[0].id, { skipFlush: true })
      set({ projects: await listProjects() })
      return
    }
    // Last project deleted: start over with a fresh one.
    const created = await dbCreateProject(DEFAULT_PROJECT_NAME)
    useChatStore.getState().cancelActive()
    switching = true
    try {
      applyContent(emptyProjectContent())
    } finally {
      switching = false
    }
    setActiveProjectId(created.id)
    set({ projects: [created] })
  },

  switchTo: async (id, opts) => {
    if (get().activeProjectId === id) return
    // Serialize transitions: two interleaved switch sequences could apply one
    // project's content while the other becomes active (audit A1).
    const run = async () => {
      // The in-flight turn belongs to the outgoing project — cancel it so its
      // continuation cannot mutate the newly hydrated stores.
      useChatStore.getState().cancelActive()
      if (!opts?.skipFlush) await get().flush()
      const content = (await loadContent(id)) ?? emptyProjectContent()
      switching = true
      try {
        applyContent(content)
      } finally {
        switching = false
      }
      setActiveProjectId(id)
    }
    const next = switchChain.then(run, run)
    switchChain = next.catch(() => {})
    await next
  },
}))
