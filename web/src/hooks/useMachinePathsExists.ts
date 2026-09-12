import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { MachinePathsExistsResponse } from '@/types/api'

export function useMachinePathsExists(
    api: ApiClient,
    machineId: string | null,
    paths: string[]
): {
    pathExistence: Record<string, boolean>
    outsideWorkspaceRoots: Set<string>
    checkPathsExists: (pathsToCheck: string[]) => Promise<MachinePathsExistsResponse>
} {
    const [pathExistence, setPathExistence] = useState<Record<string, boolean>>({})
    const [outsideWorkspaceRoots, setOutsideWorkspaceRoots] = useState<Set<string>>(new Set())

    useEffect(() => {
        setPathExistence({})
        setOutsideWorkspaceRoots(new Set())
    }, [machineId])

    useEffect(() => {
        let cancelled = false

        if (!machineId || paths.length === 0) {
            setPathExistence({})
            setOutsideWorkspaceRoots(new Set())
            return () => {
                cancelled = true
            }
        }

        void api.checkMachinePathsExists(machineId, paths)
            .then((result) => {
                if (cancelled) return
                setPathExistence(result.exists ?? {})
                setOutsideWorkspaceRoots(new Set(result.outsideWorkspaceRoots ?? []))
            })
            .catch(() => {
                if (cancelled) return
                setPathExistence({})
                setOutsideWorkspaceRoots(new Set())
            })

        return () => {
            cancelled = true
        }
    }, [api, machineId, paths])

    const checkPathsExists = useCallback(async (pathsToCheck: string[]) => {
        if (!machineId || pathsToCheck.length === 0) {
            return { exists: {} }
        }

        const result = await api.checkMachinePathsExists(machineId, pathsToCheck)
        const exists = result.exists ?? {}
        setPathExistence((current) => ({ ...current, ...exists }))
        setOutsideWorkspaceRoots((current) => {
            const next = new Set(current)
            for (const path of pathsToCheck) next.delete(path)
            for (const path of result.outsideWorkspaceRoots ?? []) next.add(path)
            return next
        })
        return result
    }, [api, machineId])

    return {
        pathExistence,
        outsideWorkspaceRoots,
        checkPathsExists,
    }
}
