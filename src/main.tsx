import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell } from './components/AppShell'
// Declared as the UI font token (--font-sans); importing it here makes the
// dependency real instead of silently falling back to the generic sans-serif.
import '@fontsource-variable/geist'
import 'svgedit/dist/editor/svgedit.css'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppShell />
  </StrictMode>
)
