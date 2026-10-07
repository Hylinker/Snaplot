import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** When the automatic visual review runs after artwork changes. */
export type VisualReviewMode = 'first' | 'always' | 'never'

export interface Settings {
  baseUrl: string
  apiKey: string
  model: string
  askBeforeDraw: boolean
  /** Optional model used for vision review; falls back to `model` when empty. */
  visionModel: string
  visualReviewMode: VisualReviewMode
}

interface SettingsState extends Settings {
  setSettings: (patch: Partial<Settings>) => void
  isConfigured: () => boolean
}

const DEFAULTS: Settings = {
  baseUrl: '',
  apiKey: '',
  model: '',
  askBeforeDraw: false,
  visionModel: '',
  visualReviewMode: 'first',
}

/** String fields trimmed on save — stray whitespace fails provider requests. */
const TRIMMED_FIELDS = ['baseUrl', 'apiKey', 'model', 'visionModel'] as const

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...DEFAULTS,
      setSettings: (patch) => {
        const next: Partial<Settings> = { ...patch }
        for (const key of TRIMMED_FIELDS) {
          const value = next[key]
          if (typeof value === 'string') next[key] = value.trim()
        }
        set(next)
      },
      isConfigured: () => {
        const s = get()
        return Boolean(s.baseUrl.trim() && s.model.trim())
      },
    }),
    {
      name: 'snaplot.settings.v1',
      // The API key stays browser-local; it is never logged and never sent
      // to the provider as part of chat history.
      partialize: (s) => ({
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        model: s.model,
        askBeforeDraw: s.askBeforeDraw,
        visionModel: s.visionModel,
        visualReviewMode: s.visualReviewMode,
      }),
    }
  )
)
