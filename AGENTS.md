# AGENTS.md

Guidance for coding agents working on Snaplot.

## Project Overview

Snaplot is a local-first, AI-powered SVG design workspace. The user describes artwork in a chat panel; the assistant builds or refines SVG artwork, which loads into a visual SVG editor (SVG-Edit v7) for direct manual refinement. It is a Vite + React 19 + TypeScript single-page application with a dev-only API proxy. Users bring their own OpenAI-compatible API key, stored browser-locally.

The full product plan and phased exit criteria live in `docs/build-plan.md` (kept as historical design background; `README.md` is the user-facing project readme). Read the plan before making scope decisions.

## Commands

- `npm run dev` — Vite dev server (includes the `POST /api/chat` dev proxy).
- `npm run build` — `tsc -b && vite build`. TypeScript strict mode; the build fails on type errors.
- `npm test` — Vitest, single run.
- `npm run test:watch` — Vitest in watch mode.

Run `npm test` after any change to `src/svg/`, `src/services/`, or `src/stores/`; these areas are developed test-first.

## Language Rule

All code, comments, UI copy (button labels, tooltips, error messages), prompts, and documentation must be in English. Never introduce non-English strings in code, even as examples.

## Code Map

| Path | Role |
|------|------|
| `src/services/agentRunner.ts` | Turn state machine: streaming, tool dispatch, tool-result retry loop, store updates |
| `src/services/agentTools.ts` | Tool declarations (`build_svg`, `apply_edits`, `ask_question`, `propose_plan`), stage tool sets, tool-call → action mapping, tool-result payloads |
| `src/services/actionEnvelope.ts` | Legacy `snaplot-action` envelope parser — retained only to render replies persisted by older versions; new turns use native tool calls |
| `src/services/promptBuilder.ts` | Stage-aware system prompts and context assembly |
| `src/services/streamClient.ts` | Streaming client (deltas, tool calls, cancellation via `AbortController`) |
| `src/svg/` | The SVG pipeline: `extract.ts`, `sanitize.ts`, `ids.ts`, `canonicalize.ts`, `edits.ts`, `verify.ts`, `attributes.ts`, `choices.ts` |
| `src/services/visionReview.ts` | Visual review: rasterize artwork to PNG, send a multimodal (text + image) request to the vision model, parse the JSON verdict; auto trigger in the verify loop plus the manual button turn |
| `src/services/imageAttach.ts` | Chat image attachments: validation + normalization (small files pass through, larger ones are downscaled to JPEG); shared `blobToDataUrl` |
| `src/editor/EditorWrapper.ts` | The single wrapper around SVG-Edit. All editor API access goes through it |
| `src/stores/` | Zustand stores with narrow responsibilities: `settings.ts`, `chat.ts` (turn stage, plan confirmation gate, plan checklist edits + `findLatestPlan`/`annotatePlanSteps` helpers), `editor.ts` (editor handle, SVG revision, selection), `projects.ts` (project list, active project, autosave/switch) |
| `src/server/chatProxy.ts` | Dev-only `/api/chat` proxy middleware. No application logic in the proxy |
| `src/types.ts` | Shared request/response/editor/operation types — the one bounded types module |
| `src/components/` | Presentation-oriented React components (AppShell, WorkspacePanel, ChatPanel, SettingsPanel, ExportDialog, Markdown) |
| `src/components/ui/` | Vendored shadcn/ui primitives (Radix + Tailwind; button, dialog, select, …). Owned code: extend variants in place (e.g. the `destructive-outline` Button variant) instead of adding wrapper components |
| `src/components/chat/` | Chat column subcomponents (MessageItem, ReasoningBlock, AttributeControls, ChatComposer); store wiring and turn handlers stay in `ChatPanel.tsx` |
| `src/lib/utils.ts` | `cn()` Tailwind class merge helper used by every UI primitive |
| `src/svgedit.d.ts` | Hand-maintained type declarations (svgedit ships none) |
| `docs/workflow.md` | The agent turn workflow specification |
| `docs/r0-findings.md` | Validated SVG-Edit integration facts and caveats |

Empty directories named without separators (e.g. `srccomponents`, `srcsvg`) are artifacts; the real code lives under `src/`.

## Agent Turn Workflow

Every user message runs a staged state machine:

```text
UNDERSTAND → PLAN → AWAIT_CONFIRM → IMPLEMENT → VERIFY → REPORT
     ↑                                            │
     └──── (verify failure: tool-result feedback, retry ≤ 2) ────┘
```

- If artwork already exists, the turn enters IMPLEMENT directly; otherwise a plan must be confirmed before the first build. The pending plan derives from persisted messages (`findLatestPlan`), not the ephemeral `turnStage`, so it survives reloads.
- A pending plan offers three paths: the confirm chip (sets `planConfirmed`; the user-adjusted steps are injected into the build prompt as `CONFIRMED PLAN STEPS`), the editable step checklist (`planStepEdits`: uncheck to exclude, click to rename; injected into the next prompt and reset when a new plan lands), or typed feedback — which runs as a plan-revision turn (`STAGE: PLAN (REVISION)` directive: keep unchanged steps stable, revise via `propose_plan` again).
- Actions arrive as native tool calls (`toolChoice: "auto"`), one per reply: `build_svg` (complete SVG, optionally naming the project via `name` — applied only while the project still has its default name) or `apply_edits` (operations targeting stable `el-N` ids). Text-only replies are accepted as informational when artwork exists.
- All programmatic checks (sanitize, drawable elements, size/element budgets, edit-target validation, all-or-nothing apply) are centralized in `src/svg/verify.ts`. Verification failures are fed back as tool-result messages appended to the conversation, so the model sees its own failed attempt.
- Stages are internal; the user never manages them.

See `docs/workflow.md` for the full contract.

## Hard Constraints

- **Fail-closed sanitizer**: every SVG entering the editor passes the pipeline (parse → validate → sanitize → canonicalize → stable IDs → load). Unknown elements/attributes are removed or the SVG is rejected. No external references, event handlers, or script content.
- **Atomic edits**: edit operations apply all-or-nothing against a detached DOM copy. A failed operation leaves the editor unchanged.
- **Authoritative artwork**: the current editor SVG revision is the source of truth. Never send the model an SVG reconstructed from chat text; canonicalize the current editor serialization before each request.
- **Editor isolation**: no direct svgedit API calls outside `EditorWrapper`. No direct provider calls from React components.
- **Key safety**: API keys are stored in `localStorage` under a namespaced key, never logged, and never included in chat history sent to the model.
- **SVG-Edit caveats** (validated in `docs/r0-findings.md`): keep one editor instance alive for the app lifetime (v7 has no teardown and leaks listeners on remount); AI rollback is app-level, not raw `undoMgr.undo()`; keep `public/svgedit/images/` and `public/images/eye.svg` in sync on svgedit upgrades.
- **SVG-Edit CSS isolation**: SVG-Edit renders in the same document (no iframe), so global CSS leaks both ways. Never restyle or wrap `.svg_editor` / the editor container div, and scope any global reset overrides around `.svg_editor` if collisions appear. `svgedit.css` must stay imported before `index.css` in `main.tsx`.

## UI Conventions

The UI layer is built on shadcn/ui (Radix primitives + Tailwind CSS v4), matching the build plan Core Decisions (`docs/build-plan.md`).

- Primitives live in `src/components/ui/`; compose them with `cn()` from `@/lib/utils`. Configuration lives in `components.json` (add more via `npx shadcn@latest add <name>`).
- Prefer design-token utilities (`bg-background`, `text-muted-foreground`, `text-primary`, `border-border`) over raw palette classes (`neutral-*`, `blue-*`). Tokens are CSS variables in `src/index.css`; keep the blue `--primary`.
- Icons come from `lucide-react`; do not add ad-hoc inline SVG icon components.
- Never use `window.confirm` / `window.alert`; use the AlertDialog-based `ConfirmDialog` (`src/components/ConfirmDialog.tsx`).
- Import via the `@/` alias (configured in `tsconfig.json` and `vite.config.ts`).
- Transient feedback stays inline (button label swap + `sr-only` live region); there is intentionally no toast system.

## Conventions

- TypeScript strict mode.
- Services contain testable business logic; components stay presentation-oriented.
- TDD for parser, sanitizer, edit, state, and streaming-boundary services.
- Keep first implementations vertical and observable rather than broad and speculative.

## Build Status

Phase R0 (integration spike) is complete and documented in `docs/r0-findings.md`. Code for R1–R5 (working shell, initial generation, structured refinement, export, projects / IndexedDB persistence) is present with tests. All phases of the build plan (`docs/build-plan.md`) are implemented.

The UI layer is refactored onto shadcn/ui: vendored Radix-based primitives in `src/components/ui/`, design tokens in `src/index.css`, chat column split into `src/components/chat/`, and `window.confirm` replaced by `ConfirmDialog`.

R5 notes: IndexedDB (`src/services/projectDb.ts`) is the persistence authority for chat and editor state (their former localStorage persist middleware is removed). `src/stores/projects.ts` owns the project list, debounced autosave (skipped mid-stream), and the switch/hydrate sequence; `src/services/draftMigrator.ts` performs the one-time migration of the legacy `snaplot.chat.v1` / `snaplot.editor.v1` localStorage draft into an "Imported draft" project.
