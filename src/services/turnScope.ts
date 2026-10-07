import { useProjectsStore } from '../stores/projects'

export interface TurnScope {
  token: number
  projectId: string | null
}

let turnCounter = 0

/**
 * Turns are bound to the active project plus a unique token. Every async
 * continuation of a turn (stream callbacks, retries, visual-review results)
 * must re-check its scope before writing to stores: a project switch, create,
 * or delete mid-turn must never land stale state in the newly active project
 * (audit A1). Starting a new turn invalidates all previous scopes, so a late
 * continuation of a superseded turn is dropped as well.
 */
export function beginTurnScope(): TurnScope {
  return { token: ++turnCounter, projectId: useProjectsStore.getState().activeProjectId }
}

export function turnScopeValid(scope: TurnScope): boolean {
  return (
    scope.token === turnCounter &&
    useProjectsStore.getState().activeProjectId === scope.projectId
  )
}
