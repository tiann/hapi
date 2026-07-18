import { useCallback, useEffect, useRef, useState } from 'react'
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
    const machineIdentityRef = useRef({ machineId, generation: 0 })
    if (machineIdentityRef.current.machineId !== machineId) {
        machineIdentityRef.current = {
            machineId,
            generation: machineIdentityRef.current.generation + 1,
        }
    }
    const imperativeRequestGenerationRef = useRef(0)

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

        const machineGeneration = machineIdentityRef.current.generation
        const requestGeneration = ++imperativeRequestGenerationRef.current
        const result = await api.checkMachinePathsExists(machineId, pathsToCheck)
        const exists = result.exists ?? {}
        if (
            machineIdentityRef.current.machineId === machineId
            && machineIdentityRef.current.generation === machineGeneration
            && imperativeRequestGenerationRef.current === requestGeneration
        ) {
            setPathExistence((current) => ({ ...current, ...exists }))
        }
        return exists
    }, [api, machineId])

    return {
        pathExistence,
        checkPathsExists,
    }
}
