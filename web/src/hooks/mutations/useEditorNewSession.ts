import { useCallback, useState } from 'react'
import type { ApiClient } from '@/api/client'

export function useEditorNewSession(args: {
    api: ApiClient | null
    machineId: string | null
    projectPath: string | null
    onCreated: (sessionId: string) => void
}): {
    createSession: () => void
    isCreating: boolean
    error: string | null
} {
    const [isCreating, setIsCreating] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const createSession = useCallback(() => {
        if (!args.api || !args.machineId || !args.projectPath) {
            setError('Select a machine and project first')
            return
        }

        setError(null)
        setIsCreating(true)
        void (async () => {
            try {
                const result = await args.api!.spawnSession(args.machineId!, args.projectPath!, 'codex')
                if (result.type === 'success') {
                    args.onCreated(result.sessionId)
                    return
                }
                setError(result.message)
            } catch (spawnError) {
                setError(spawnError instanceof Error ? spawnError.message : 'Failed to create session')
            } finally {
                setIsCreating(false)
            }
        })()
    }, [args])

    return { createSession, isCreating, error }
}
