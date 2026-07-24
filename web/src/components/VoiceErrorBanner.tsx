import { useEffect } from 'react'
import { useVoiceOptional } from '@/lib/voice-context'

export function VoiceErrorBanner() {
    const voice = useVoiceOptional()

    const shouldShow = voice && voice.status === 'error' && voice.errorMessage

    useEffect(() => {
        if (!shouldShow || !voice) return

        const timer = setTimeout(() => {
            voice.setStatus('disconnected')
        }, 3000)

        return () => clearTimeout(timer)
    }, [shouldShow, voice])

    if (!shouldShow) {
        return null
    }

    return (
        <div className="fixed top-0 left-0 right-0 bg-red-500 text-white text-center pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] text-sm font-medium z-50 flex items-center justify-center border-b border-red-600">
            {voice.errorMessage}
        </div>
    )
}
