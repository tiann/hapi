import { useEffect, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { ApiClient } from '@/api/client'

// Capture spawn params at module load time, before any effect can clean the URL
const initialSearch = typeof window !== 'undefined' ? window.location.search : ''
const initialQuery = new URLSearchParams(initialSearch)
const SPAWN_PARAMS = {
    spawn: initialQuery.get('spawn') === 'true',
    machine: initialQuery.get('machine'),
    dir: initialQuery.get('dir'),
    boot: initialQuery.get('boot'),
} as const

export function useAutoSpawn(api: ApiClient | null) {
    const navigate = useNavigate()
    const attemptedRef = useRef(false)

    useEffect(() => {
        if (!api || attemptedRef.current) return
        if (!SPAWN_PARAMS.spawn || !SPAWN_PARAMS.machine || !SPAWN_PARAMS.dir) return

        attemptedRef.current = true

        api.spawnSession(SPAWN_PARAMS.machine, SPAWN_PARAMS.dir).then(async (result) => {
            if (result.type === 'success') {
                if (SPAWN_PARAMS.boot) {
                    try {
                        await api.sendMessage(result.sessionId, SPAWN_PARAMS.boot)
                    } catch (err) {
                        console.error('Auto-spawn boot message failed:', err)
                    }
                }
                navigate({
                    to: '/sessions/$sessionId',
                    params: { sessionId: result.sessionId },
                    replace: true,
                })
            } else {
                console.error('Auto-spawn failed:', result.message)
            }
        }).catch((err) => {
            console.error('Auto-spawn error:', err)
        })
    }, [api, navigate])
}
