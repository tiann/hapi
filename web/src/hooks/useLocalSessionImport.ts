import { useCallback, useEffect, useRef, useState } from 'react'
import type {
    LocalSessionImportApi,
    LocalSessionImportFlavor,
    LocalSessionImportPayload,
    LocalSessionImportResponse,
    LocalSessionListItem
} from '../lib/localSessionImport'
import { apiErrorMessage } from '../api/client'

/**
 * Shared state machine behind the flavor import dialogs: scan the
 * machine's local sessions, keep the dialog selection, and run imports
 * through the generic REST pair. One selection may be continued inline by
 * the caller; bulk selections import in the background.
 */

export type UseLocalSessionImportOptions = {
    api: LocalSessionImportApi
    flavor: LocalSessionImportFlavor
    /** Work directory used to scope the scan and the import. */
    directory?: string | null
    /** Machine hosting the session that is being continued (may be null). */
    machineId?: string | null
    /**
     * When false, sessions are only fetched through an explicit refresh()
     * (the New Session form loads its import list when the picker opens).
     */
    auto?: boolean
}

export type UseLocalSessionImportResult = {
    sessions: LocalSessionListItem[]
    machineId: string | null
    isLoading: boolean
    error: string | null
    isImporting: boolean
    refresh: () => Promise<void>
    importSessions: (sessionIds: string[], payloadOverrides?: Partial<LocalSessionImportPayload>) => Promise<LocalSessionImportResponse['results'] | null>
}

export function useLocalSessionImport(options: UseLocalSessionImportOptions): UseLocalSessionImportResult {
    const { api, flavor, directory, machineId, auto = true } = options
    const [sessions, setSessions] = useState<LocalSessionListItem[]>([])
    const [resolvedMachineId, setResolvedMachineId] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [isImporting, setIsImporting] = useState(false)
    const loadGenerationRef = useRef(0)

    const refresh = useCallback(async () => {
        const generation = ++loadGenerationRef.current
        setIsLoading(true)
        setError(null)
        try {
            const result = await api.getLocalSessions(flavor, directory ?? null, machineId ?? null)
            if (generation !== loadGenerationRef.current) return
            if (!result.success) {
                setError(result.error)
                setSessions([])
                setResolvedMachineId(result.machineId ?? null)
                return
            }
            setSessions(result.sessions)
            setResolvedMachineId(result.machineId ?? machineId ?? null)
        } catch (loadError) {
            if (generation !== loadGenerationRef.current) return
            setError(apiErrorMessage(loadError, 'Failed to load local sessions'))
            setSessions([])
        } finally {
            if (generation === loadGenerationRef.current) setIsLoading(false)
        }
    }, [api, flavor, directory, machineId])

    // Invalidate an in-flight scan when its scope (directory/machine) changes:
    // the stale response is dropped and the loading state clears immediately,
    // before a new scan is issued (auto mode re-issues below).
    useEffect(() => {
        loadGenerationRef.current += 1
        setIsLoading(false)
        setResolvedMachineId(null)
    }, [directory, machineId])

    useEffect(() => {
        if (!auto) return
        void refresh()
    }, [auto, refresh])

    const importSessions = useCallback(async (sessionIds: string[], payloadOverrides?: Partial<LocalSessionImportPayload>) => {
        if (isImporting || sessionIds.length === 0) return null
        setIsImporting(true)
        try {
            const result = await api.importLocalSessions(flavor, {
                sessionIds,
                cwd: directory ?? null,
                machineId: resolvedMachineId ?? machineId ?? null,
                ...payloadOverrides
            })
            if (result.success || result.results.length > 0) return result.results
            setError(result.error ?? null)
            return null
        } catch (importError) {
            setError(apiErrorMessage(importError, 'Failed to import local sessions'))
            return null
        } finally {
            setIsImporting(false)
        }
    }, [api, flavor, directory, machineId, resolvedMachineId, isImporting])

    return {
        sessions,
        machineId: resolvedMachineId,
        isLoading,
        error,
        isImporting,
        refresh,
        importSessions
    }
}