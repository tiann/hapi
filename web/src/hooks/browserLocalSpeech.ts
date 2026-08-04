export interface LocalSpeechRecognitionResult {
    readonly isFinal: boolean
    readonly 0: { readonly transcript: string }
}

export interface LocalSpeechRecognitionEvent extends Event {
    readonly results: { readonly length: number; readonly [index: number]: LocalSpeechRecognitionResult }
}

export interface LocalSpeechRecognition extends EventTarget {
    continuous: boolean
    interimResults: boolean
    lang: string
    processLocally: boolean
    onresult: ((event: LocalSpeechRecognitionEvent) => void) | null
    onerror: ((event: Event & { error?: string }) => void) | null
    onend: (() => void) | null
    start: () => void
    stop: () => void
    abort: () => void
}

export interface LocalSpeechRecognitionConstructor {
    new(): LocalSpeechRecognition
    prototype: LocalSpeechRecognition
}

export type LocalSpeechRecognitionAvailability = (
    options: { langs: string[]; processLocally: true }
) => Promise<string> | string

export interface BrowserLocalSpeechEnvironment {
    userAgent?: string
    userAgentData?: { platform?: string; mobile?: boolean }
    speechRecognition?: unknown
}

export interface BrowserLocalSpeechSupport {
    constructor: LocalSpeechRecognitionConstructor
    available: LocalSpeechRecognitionAvailability
}

function currentUserAgent(): string {
    return typeof navigator === 'undefined' ? '' : navigator.userAgent
}

function currentSpeechRecognition(): unknown {
    return (globalThis as typeof globalThis & {
        SpeechRecognition?: unknown
    }).SpeechRecognition
}

function currentUserAgentData(): BrowserLocalSpeechEnvironment['userAgentData'] {
    return (typeof navigator === 'undefined'
        ? undefined
        : (navigator as Navigator & { userAgentData?: BrowserLocalSpeechEnvironment['userAgentData'] }).userAgentData)
}

const SAFE_DESKTOP_PLATFORMS = new Set(['Windows', 'macOS', 'Linux', 'Chrome OS'])

/**
 * The experimental on-device speech API is eligible only with explicit,
 * trustworthy User-Agent Client Hints that identify a desktop platform. Android
 * WebViews can expose a partial shape whose native `available()` call crashes
 * the renderer, so missing, unknown, and mobile environments fail closed.
 */
export function isConfirmedDesktopSpeechEnvironment(
    _userAgent: string,
    userAgentData?: BrowserLocalSpeechEnvironment['userAgentData']
): boolean {
    return userAgentData?.mobile === false
        && typeof userAgentData.platform === 'string'
        && SAFE_DESKTOP_PLATFORMS.has(userAgentData.platform)
}

function staticAvailabilityMethod(candidate: Function): LocalSpeechRecognitionAvailability | null {
    for (let target: object | null = candidate; target && target !== Function.prototype; target = Object.getPrototypeOf(target)) {
        const descriptor = Object.getOwnPropertyDescriptor(target, 'available')
        if (descriptor) return typeof descriptor.value === 'function'
            ? descriptor.value as LocalSpeechRecognitionAvailability
            : null
    }
    return null
}

/**
 * Checks only the browser API shape. It intentionally does not instantiate
 * recognition or call the experimental `SpeechRecognition.available()` method.
 */
export function getBrowserLocalSpeechSupport(
    environment: BrowserLocalSpeechEnvironment = {}
): BrowserLocalSpeechSupport | null {
    const userAgent = environment.userAgent ?? currentUserAgent()
    const userAgentData = environment.userAgentData ?? currentUserAgentData()
    if (!isConfirmedDesktopSpeechEnvironment(userAgent, userAgentData)) return null

    const candidate = environment.speechRecognition ?? currentSpeechRecognition()
    if (typeof candidate !== 'function') return null
    const constructor = candidate as LocalSpeechRecognitionConstructor
    if (!constructor.prototype || !('processLocally' in constructor.prototype)) return null
    const available = staticAvailabilityMethod(candidate)
    return available ? { constructor, available } : null
}

export function hasBrowserLocalSpeechSupport(): boolean {
    return getBrowserLocalSpeechSupport() !== null
}
