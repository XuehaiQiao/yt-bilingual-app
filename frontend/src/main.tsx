import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { recordAppVisit, registerServiceWorker } from './lib/pwa'

// One visit per page load; the install entry waits for the third (report 1.3.3).
recordAppVisit()
registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
