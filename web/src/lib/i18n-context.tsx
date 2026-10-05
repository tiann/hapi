import { createContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { getTelegramWebApp, isTelegramEnvironment } from '@/hooks/useTelegram'
import { en, zhCN, ru } from './locales'

export type Locale = 'en' | 'zh-CN' | 'ru'

export type Translations = Record<string, string>

export type I18nContextValue = {
  t: (key: string, params?: Record<string, string | number>) => string
  locale: Locale
  setLocale: (locale: Locale) => void
}

export const I18nContext = createContext<I18nContextValue | null>(null)

const locales: Record<Locale, Translations> = { en, 'zh-CN': zhCN, ru }

/**
 * Map a BCP-47-ish language tag (`ru`, `ru-RU`, `zh-Hans`, `en-US`) onto a
 * supported locale. Returns null for anything we do not ship.
 */
export function normalizeLocaleTag(tag: string | null | undefined): Locale | null {
  if (!tag) return null
  const lower = tag.trim().toLowerCase().replace(/_/g, '-')
  if (!lower) return null
  if (lower === 'ru' || lower.startsWith('ru-')) return 'ru'
  if (lower === 'zh' || lower.startsWith('zh-')) return 'zh-CN'
  if (lower === 'en' || lower.startsWith('en-')) return 'en'
  return null
}

function readStoredLocale(): Locale | null {
  try {
    return normalizeLocaleTag(localStorage.getItem('hapi-lang'))
  } catch {
    return null
  }
}

/**
 * Pick the locale for a fresh session: an explicit user choice wins, then the
 * Telegram Mini App user's language, then the browser language, then English.
 * Telegram runs the app in its own web view, so `localStorage` from a normal
 * browser visit is not available and the language must be detected here.
 */
export function detectInitialLocale(): Locale {
  const stored = readStoredLocale()
  if (stored) return stored

  if (typeof window !== 'undefined') {
    const telegramLocale = normalizeLocaleTag(
      getTelegramWebApp()?.initDataUnsafe?.user?.language_code
    )
    if (telegramLocale) return telegramLocale
  }

  if (typeof navigator !== 'undefined') {
    const browserLocale = normalizeLocaleTag(navigator.language)
    if (browserLocale) return browserLocale
  }

  return 'en'
}

function interpolate(str: string, params?: Record<string, string | number>): string {
  if (!params) return str
  return str.replace(/\{(\w+)\}/g, (match, key) => {
    const value = params[key]
    return value !== undefined ? String(value) : match
  })
}

/**
 * Telegram loads its SDK asynchronously and `loadTelegramSdk` gives up after a
 * timeout, so the user's `language_code` can appear after the first render.
 * Poll briefly for the WebApp and resolve the language once it shows up.
 */
export async function resolveLateTelegramLocale(
  intervalMs = 500,
  maxAttempts = 20
): Promise<Locale | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const telegramLocale = normalizeLocaleTag(
      getTelegramWebApp()?.initDataUnsafe?.user?.language_code
    )
    if (telegramLocale) return telegramLocale
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return null
}

/**
 * Apply a late-detected Telegram locale unless the user has stored an explicit
 * choice in the meantime. Returns true when the locale was applied.
 */
export function applyLateTelegramLocale(
  detected: Locale | null,
  apply: (locale: Locale) => void
): boolean {
  if (!detected || readStoredLocale()) return false
  apply(detected)
  return true
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectInitialLocale())

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale)
    localStorage.setItem('hapi-lang', newLocale)
    document.documentElement.lang = newLocale
  }, [])

  const t = useCallback((key: string, params?: Record<string, string | number>): string => {
    const dict = locales[locale] ?? locales.en
    const value = dict[key]
    const fallback = locales.en[key] ?? key
    return interpolate(value ?? fallback, params)
  }, [locale])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // The Telegram SDK can finish loading after `detectInitialLocale` ran, so
  // pick up the Telegram language then — unless the user chose one explicitly.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (readStoredLocale()) return
    if (!isTelegramEnvironment()) return
    if (normalizeLocaleTag(getTelegramWebApp()?.initDataUnsafe?.user?.language_code)) return

    let cancelled = false
    void resolveLateTelegramLocale().then((detected) => {
      if (cancelled) return
      applyLateTelegramLocale(detected, setLocaleState)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <I18nContext.Provider value={{ t, locale, setLocale }}>
      {children}
    </I18nContext.Provider>
  )
}
