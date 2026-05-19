import { useEffect, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { ApiClient } from '@/api/client'

const AUTO_SPAWN_ACTIVE_POLL_INTERVAL_MS = 500
const AUTO_SPAWN_ACTIVE_POLL_ATTEMPTS = 30

// Capture spawn params at module load time, before any effect can clean the URL
const initialSearch = typeof window !== 'undefined' ? window.location.search : ''
const initialQuery = new URLSearchParams(initialSearch)
const SPAWN_PARAMS = {
    spawn: initialQuery.get('spawn') === 'true',
    machine: initialQuery.get('machine'),
    dir: initialQuery.get('dir'),
    boot: initialQuery.get('boot'),
} as const

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}

async function waitForSessionActive(api: ApiClient, sessionId: string): Promise<boolean> {
    for (let attempt = 0; attempt < AUTO_SPAWN_ACTIVE_POLL_ATTEMPTS; attempt += 1) {
        try {
            const { session } = await api.getSession(sessionId)
            if (session.active) {
                return true
            }
        } catch {
        }

        await sleep(AUTO_SPAWN_ACTIVE_POLL_INTERVAL_MS)
    }

    return false
}

export function useAutoSpawn(api: ApiClient | null) {
    const navigate = useNavigate()
    const attemptedRef = useRef(false)

    useEffect(() => {
        if (!api || attemptedRef.current) return
        if (!SPAWN_PARAMS.spawn || !SPAWN_PARAMS.machine || !SPAWN_PARAMS.dir) return
        const machineId = SPAWN_PARAMS.machine
        const directory = SPAWN_PARAMS.dir

        attemptedRef.current = true

        api.checkMachinePathsExists(machineId, [directory]).then(async (exists) => {
            if (exists.exists[directory] === false) {
                console.error('Auto-spawn blocked: missing directory requires explicit confirmation')
                return
            }

            const result = await api.spawnSession(machineId, directory)
            if (result.type === 'success') {
                if (SPAWN_PARAMS.boot) {
                    try {
                        const active = await waitForSessionActive(api, result.sessionId)
                        if (!active) {
                            console.error('Auto-spawn boot message skipped: session did not become active in time')
                        } else {
                            await api.sendMessage(result.sessionId, SPAWN_PARAMS.boot)
                        }
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
