import { emptyProjectContent } from '../types'
import type { Project, ProjectContent } from '../types'

/**
 * IndexedDB persistence for projects.
 *
 * Database `snaplot` v1 with two object stores:
 * - `projects`: Project metadata keyed by id, indexed by updatedAt.
 * - `content`:  ProjectContent keyed by the project id.
 */

const DB_NAME = 'snaplot'
const DB_VERSION = 1
const PROJECTS_STORE = 'projects'
const CONTENT_STORE = 'content'

let dbPromise: Promise<IDBDatabase> | null = null

export function resetProjectDbForTests(): void {
  dbPromise = null
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
        db.createObjectStore(PROJECTS_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(CONTENT_STORE)) {
        db.createObjectStore(CONTENT_STORE)
      }
    }
    req.onsuccess = () => {
      req.result.onclose = () => {
        dbPromise = null
      }
      resolve(req.result)
    }
    req.onerror = () => {
      dbPromise = null
      reject(req.error ?? new Error('Failed to open project database'))
    }
  })
  return dbPromise
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode)
        const request = run(transaction.objectStore(store))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
      })
  )
}

export function newProjectId(): string {
  return `prj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function listProjects(): Promise<Project[]> {
  return tx<Project[]>(PROJECTS_STORE, 'readonly', (s) => s.getAll()).then((projects) =>
    projects.sort((a, b) => b.updatedAt - a.updatedAt)
  )
}

export function putProject(project: Project): Promise<void> {
  return tx<IDBValidKey>(PROJECTS_STORE, 'readwrite', (s) => s.put(project)).then(() => undefined)
}

export function deleteProjectRow(id: string): Promise<void> {
  return Promise.all([
    tx(PROJECTS_STORE, 'readwrite', (s) => s.delete(id)).then(() => undefined),
    tx(CONTENT_STORE, 'readwrite', (s) => s.delete(id)).then(() => undefined),
  ]).then(() => undefined)
}

export function loadContent(id: string): Promise<ProjectContent | undefined> {
  return tx<ProjectContent | undefined>(CONTENT_STORE, 'readonly', (s) => s.get(id))
}

export function saveContent(id: string, content: ProjectContent): Promise<void> {
  return tx(CONTENT_STORE, 'readwrite', (s) => s.put(content, id)).then(() => undefined)
}

export async function createProject(name: string): Promise<Project> {
  const now = Date.now()
  const project: Project = { id: newProjectId(), name, createdAt: now, updatedAt: now }
  await putProject(project)
  await saveContent(project.id, emptyProjectContent())
  return project
}

export async function duplicateProject(id: string, name: string): Promise<Project | null> {
  const [source] = await listProjects().then((all) => all.filter((p) => p.id === id))
  const content = await loadContent(id)
  if (!source) return null
  const copy = await createProject(name)
  if (content) await saveContent(copy.id, content)
  return copy
}
