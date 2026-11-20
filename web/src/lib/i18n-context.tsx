import { createContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { getTelegramWebApp, isTelegramEnvironment } from '@/hooks/useTelegram'
import enDictionary from './locales/en'

export type Locale = 'en' | 'zh-CN' | 'ru' | 'ja'

export type Translations = Record<string, string>

export type I18nContextValue = {
  t: (key: string, params?: Record<string, string | number>) => string
  locale: Locale
  setLocale: (locale: Locale) => void
}

export const I18nContext = createContext<I18nContextValue | null>(null)

// Only the English dictionary ships in the entry bundle: it is the fallback
// every locale renders against while (and if) its own dictionary is loading.
// The other locales are separate chunks fetched on demand, which keeps three
// ~100KB string tables out of the sessions-list first paint.
const lazyLocaleLoaders: { [K in Exclude<Locale, 'en'>]: () => Promise<{ default: Translations }> } = {
    'zh-CN': () => import('./locales/zh-CN'),
    ru: () => import('./locales/ru'),
    ja: () => import('./locales/ja'),
}

// Widen the `as const` literal dictionary to Translations for keyed lookups.
const en: Translations = enDictionary
const loadedDictionaries: Partial<Record<Locale, Translations>> = { en }
const localeLoadPending = new Map<Locale, Promise<void>>()

/**
 * Load (once) the dictionary for a non-English locale. Resolves when the
 * dictionary is available in `loadedDictionaries`; failures reject and clear
 * the in-flight marker so a later switch can retry.
 */
export function isLocaleDictionaryLoaded(locale: Locale): boolean {
    return locale === 'en' || Boolean(loadedDictionaries[locale])
}

export function loadLocaleDictionary(locale: Locale): Promise<void> {
    if (locale === 'en' || loadedDictionaries[locale]) return Promise.resolve()
    let pending = localeLoadPending.get(locale)
    if (!pending) {
        pending = lazyLocaleLoaders[locale]()
            .then((module) => {
                loadedDictionaries[locale] = module.default
            })
            .finally(() => {
                localeLoadPending.delete(locale)
            })
        localeLoadPending.set(locale, pending)
    }
    return pending
}

// Start the initial locale's fetch before React renders so non-English users
// see their language on the first meaningful paint (the chunk downloads in
// parallel with the rest of the boot sequence).
if (typeof window !== 'undefined') {
    void loadLocaleDictionary(detectInitialLocale()).catch(() => {})
}

/**
 * Map a BCP-47-ish language tag (`ru`, `ru-RU`, `zh-Hans`, `en-US`) onto a
 * supported locale. Returns null for anything we do not ship.
 */
export function normalizeLocaleTag(tag: string | null | undefined): Locale | null {
  if (!tag) return null
  const lower = tag.trim().toLowerCase().replace(/_/g, '-')
  if (!lower) return null
  if (lower === 'ru' || lower.startsWith('ru-')) return 'ru'
  if (lower === 'ja' || lower.startsWith('ja-')) return 'ja'
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
  // Bumped when the active locale's dictionary finishes loading so `t` (and
  // every consumer of it) re-renders with real translations. Until then the
  // English fallback renders, exactly like an unknown key today.
  const [dictVersion, setDictVersion] = useState(0)

  useEffect(() => {
    // English ships in the entry bundle — nothing to load, no version bump.
    // A bump would rebuild `t` (and every row reading it) even when the
    // dictionary never changed, which defeats row memoization.
    if (locale === 'en') return
    let cancelled = false
    const wasLoaded = isLocaleDictionaryLoaded(locale)
    loadLocaleDictionary(locale)
      .then(() => {
        if (!cancelled && !wasLoaded) setDictVersion((version) => version + 1)
      })
      .catch(() => {
        // Keep the English fallback; switching again retries the load.
      })
    return () => {
      cancelled = true
    }
  }, [locale])

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale)
    localStorage.setItem('hapi-lang', newLocale)
    document.documentElement.lang = newLocale
  }, [])

  const t = useCallback((key: string, params?: Record<string, string | number>): string => {
    const dict = (locale !== 'en' ? loadedDictionaries[locale] : undefined) ?? en
    const value = dict[key]
    const fallback = en[key] ?? key
    return interpolate(value ?? fallback, params)
  }, [locale, dictVersion])

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
