import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '@/api/client'

export function useMachinePathsExists(
    api: ApiClient,
    machineId: string | null,
    paths: string[]
): {
    pathExistence: Record<string, boolean>
    checkPathsExists: (pathsToCheck: string[]) => Promise<Record<string, boolean>>
} {
    const [pathExistence, setPathExistence] = useState<Record<string, boolean>>({})

    useEffect(() => {
        setPathExistence({})
    }, [machineId])

    useEffect(() => {
        let cancelled = false

        if (!machineId || paths.length === 0) {
            setPathExistence({})
            return () => {
                cancelled = true
            }
        }

        void api.checkMachinePathsExists(machineId, paths)
            .then((result) => {
                if (cancelled) return
                setPathExistence(result.exists ?? {})
            })
            .catch(() => {
                if (cancelled) return
                setPathExistence({})
            })

        return () => {
            cancelled = true
        }
    }, [api, machineId, paths])

    const checkPathsExists = useCallback(async (pathsToCheck: string[]) => {
        if (!machineId || pathsToCheck.length === 0) {
            return {}
        }

        const result = await api.checkMachinePathsExists(machineId, pathsToCheck)
        const exists = result.exists ?? {}
        setPathExistence((current) => ({ ...current, ...exists }))
        return exists
    }, [api, machineId])

    return {
        pathExistence,
        checkPathsExists,
    }
}
