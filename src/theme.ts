import { useEffect, useState } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'
export const THEME_KEY = 'wallsnap.theme'
const QUERY = '(prefers-color-scheme: dark)'

export const isPref = (v: unknown): v is ThemePref => v === 'system' || v === 'light' || v === 'dark'

/** The concrete theme for a preference; "system" follows the OS. */
export const resolveTheme = (pref: ThemePref, systemDark: boolean): 'light' | 'dark' =>
  pref === 'system' ? (systemDark ? 'dark' : 'light') : pref

/** Storage can be unavailable (private mode, blocked): fall back to following the system. */
export function loadPref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return isPref(v) ? v : 'system'
  } catch {
    return 'system'
  }
}

function savePref(pref: ThemePref) {
  try {
    localStorage.setItem(THEME_KEY, pref)
  } catch {
    /* preference simply isn't persisted */
  }
}

export function applyTheme(pref: ThemePref) {
  const dark = window.matchMedia(QUERY).matches
  document.documentElement.dataset.theme = resolveTheme(pref, dark)
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(loadPref)
  useEffect(() => {
    applyTheme(pref)
    if (pref !== 'system') return
    const mq = window.matchMedia(QUERY)
    const onChange = () => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [pref])
  return [pref, (p) => { savePref(p); setPref(p) }]
}
