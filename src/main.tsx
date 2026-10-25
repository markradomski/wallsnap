import { createRoot } from 'react-dom/client'
import { App } from './App'
import './global.css'
import { applyTheme, loadPref } from './theme'

applyTheme(loadPref()) // before first paint, to avoid a flash of the wrong theme
createRoot(document.getElementById('root')!).render(<App />)
