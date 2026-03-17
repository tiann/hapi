import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { VoiceNotificationProvider, VoiceNotificationSettings } from '@hapi/protocol/voice'
import { DEFAULT_VOICE_NOTIFICATION_SETTINGS } from '@hapi/protocol/voice'

const STORAGE_KEY = 'hapi-voice-notifications'

type PriorityLevel = 'low' | 'normal' | 'high'
const PRIORITY_ORDER: Record<PriorityLevel, number> = { low: 0, normal: 1, high: 2 }

export interface VoiceNotificationEvent {
    text: string
    sessionId: string
    priority: PriorityLevel
    category: 'permission' | 'ready' | 'error' | 'completion'
}

interface VoiceNotificationContextValue {
    settings: VoiceNotificationSettings
    updateSettings: (patch: Partial<VoiceNotificationSettings>) => void
    speak: (event: VoiceNotificationEvent) => void
    speaking: boolean
}

const VoiceNotificationContext = createContext<VoiceNotificationContextValue | null>(null)

function loadSettings(): VoiceNotificationSettings {
    try {
        const stored = localStorage.getItem(STORAGE_KEY)
        if (stored) {
            return { ...DEFAULT_VOICE_NOTIFICATION_SETTINGS, ...JSON.parse(stored) }
        }
    } catch { /* ignore */ }
    return { ...DEFAULT_VOICE_NOTIFICATION_SETTINGS }
}

function saveSettings(settings: VoiceNotificationSettings): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch { /* ignore */ }
}

/**
 * Speak text using Web Speech API (browser built-in TTS).
 * Returns a promise that resolves when speech finishes.
 */
function speakWithBrowser(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!('speechSynthesis' in window)) {
            reject(new Error('Web Speech API not supported'))
            return
        }

        const utterance = new SpeechSynthesisUtterance(text)
        utterance.rate = 1.05
        utterance.pitch = 1.0
        utterance.volume = 1.0

        // Try to use a natural-sounding English voice
        const voices = speechSynthesis.getVoices()
        const preferred = voices.find(
            (v) => v.lang.startsWith('en') && v.name.toLowerCase().includes('samantha')
        ) ?? voices.find(
            (v) => v.lang.startsWith('en') && !v.localService
        ) ?? voices.find(
            (v) => v.lang.startsWith('en')
        )
        if (preferred) {
            utterance.voice = preferred
        }

        utterance.onend = () => resolve()
        utterance.onerror = (e) => reject(new Error(e.error))
        speechSynthesis.speak(utterance)
    })
}

/**
 * Speak text using ElevenLabs TTS via the hub proxy endpoint.
 * Falls back to browser TTS if the API call fails.
 */
async function speakWithElevenLabs(text: string, api: ApiClient): Promise<void> {
    try {
        const audioBuffer = await api.fetchTTS(text)
        const blob = new Blob([audioBuffer], { type: 'audio/mpeg' })
        const url = URL.createObjectURL(blob)

        return new Promise<void>((resolve, reject) => {
            const audio = new Audio(url)
            audio.onended = () => {
                URL.revokeObjectURL(url)
                resolve()
            }
            audio.onerror = () => {
                URL.revokeObjectURL(url)
                reject(new Error('Audio playback failed'))
            }
            audio.play().catch(reject)
        })
    } catch (error) {
        console.warn('[VoiceNotification] ElevenLabs TTS failed, falling back to browser:', error)
        return speakWithBrowser(text)
    }
}

export function VoiceNotificationProvider({
    children,
    api
}: {
    children: ReactNode
    api: ApiClient | null
}) {
    const [settings, setSettings] = useState<VoiceNotificationSettings>(loadSettings)
    const [speaking, setSpeaking] = useState(false)
    const queueRef = useRef<VoiceNotificationEvent[]>([])
    const processingRef = useRef(false)
    const apiRef = useRef(api)

    useEffect(() => {
        apiRef.current = api
    }, [api])

    const processQueue = useCallback(async () => {
        if (processingRef.current) return
        processingRef.current = true
        setSpeaking(true)

        while (queueRef.current.length > 0) {
            const event = queueRef.current.shift()!
            try {
                const currentSettings = loadSettings()
                if (currentSettings.provider === 'elevenlabs' && apiRef.current) {
                    await speakWithElevenLabs(event.text, apiRef.current)
                } else {
                    await speakWithBrowser(event.text)
                }
            } catch (error) {
                console.error('[VoiceNotification] TTS error:', error)
            }
        }

        processingRef.current = false
        setSpeaking(false)
    }, [])

    const speak = useCallback((event: VoiceNotificationEvent) => {
        const currentSettings = loadSettings()
        if (!currentSettings.enabled) return

        // Check priority threshold
        if (PRIORITY_ORDER[event.priority] < PRIORITY_ORDER[currentSettings.minPriority]) {
            return
        }

        queueRef.current.push(event)
        void processQueue()
    }, [processQueue])

    const updateSettings = useCallback((patch: Partial<VoiceNotificationSettings>) => {
        setSettings((prev) => {
            const next = { ...prev, ...patch }
            saveSettings(next)
            return next
        })
    }, [])

    return (
        <VoiceNotificationContext.Provider value={{ settings, updateSettings, speak, speaking }}>
            {children}
        </VoiceNotificationContext.Provider>
    )
}

export function useVoiceNotifications(): VoiceNotificationContextValue {
    const ctx = useContext(VoiceNotificationContext)
    if (!ctx) {
        throw new Error('useVoiceNotifications must be used within VoiceNotificationProvider')
    }
    return ctx
}

export function useVoiceNotificationsOptional(): VoiceNotificationContextValue | null {
    return useContext(VoiceNotificationContext)
}
