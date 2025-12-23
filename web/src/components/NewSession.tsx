import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { Button } from '@/components/ui/button'
import { usePlatform } from '@/hooks/usePlatform'
import { useSpawnSession } from '@/hooks/mutations/useSpawnSession'
import { useRecentPaths } from '@/hooks/useRecentPaths'

type AgentType = 'claude' | 'codex' | 'gemini'

function getMachineTitle(machine: Machine): string {
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
}

export function NewSession(props: {
    api: ApiClient
    machines: Machine[]
    isLoading?: boolean
    onSuccess: (sessionId: string) => void
    onCancel: () => void
}) {
    const { haptic } = usePlatform()
    const { spawnSession, isPending, error: spawnError } = useSpawnSession(props.api)
    const isFormDisabled = isPending || props.isLoading
    const { getRecentPaths, addRecentPath, getLastUsedMachineId, setLastUsedMachineId } = useRecentPaths()

    const [machineId, setMachineId] = useState<string | null>(null)
    const [directory, setDirectory] = useState('')
    const [agent, setAgent] = useState<AgentType>('claude')
    const [error, setError] = useState<string | null>(null)

    // Initialize with last used machine or first available
    useEffect(() => {
        if (props.machines.length === 0) return
        if (machineId && props.machines.find((m) => m.id === machineId)) return

        const lastUsed = getLastUsedMachineId()
        const foundLast = lastUsed ? props.machines.find((m) => m.id === lastUsed) : null

        if (foundLast) {
            setMachineId(foundLast.id)
            const paths = getRecentPaths(foundLast.id)
            if (paths[0]) setDirectory(paths[0])
        } else if (props.machines[0]) {
            setMachineId(props.machines[0].id)
        }
    }, [props.machines, machineId, getLastUsedMachineId, getRecentPaths])

    const selectedMachine = useMemo(
        () => props.machines.find((m) => m.id === machineId) ?? null,
        [props.machines, machineId]
    )

    const recentPaths = useMemo(
        () => getRecentPaths(machineId),
        [getRecentPaths, machineId]
    )

    const handleMachineChange = useCallback((newMachineId: string) => {
        setMachineId(newMachineId)
        // Auto-fill most recent path for the new machine
        const paths = getRecentPaths(newMachineId)
        if (paths[0]) {
            setDirectory(paths[0])
        } else {
            setDirectory('')
        }
    }, [getRecentPaths])

    const handlePathClick = useCallback((path: string) => {
        setDirectory(path)
    }, [])

    async function handleCreate() {
        if (!machineId || !directory.trim()) return

        setError(null)
        try {
            const result = await spawnSession({
                machineId,
                directory: directory.trim(),
                agent,
            })

            if (result.type === 'success') {
                haptic.notification('success')
                // Save for next time
                setLastUsedMachineId(machineId)
                addRecentPath(machineId, directory.trim())
                props.onSuccess(result.sessionId)
                return
            }

            haptic.notification('error')
            setError(result.message)
        } catch (e) {
            haptic.notification('error')
            setError(e instanceof Error ? e.message : 'Failed to create session')
        }
    }

    const canCreate = machineId && directory.trim() && !isFormDisabled

    return (
        <div className="flex flex-col divide-y divide-[var(--app-divider)]">
            {/* Machine Selector */}
            <div className="flex flex-col gap-1.5 px-3 py-3">
                <label className="text-xs font-medium text-[var(--app-hint)]">
                    Machine
                </label>
                <select
                    value={machineId ?? ''}
                    onChange={(e) => handleMachineChange(e.target.value)}
                    disabled={isFormDisabled}
                    className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                >
                    {props.isLoading && (
                        <option value="">Loading machines...</option>
                    )}
                    {!props.isLoading && props.machines.length === 0 && (
                        <option value="">No machines available</option>
                    )}
                    {props.machines.map((m) => (
                        <option key={m.id} value={m.id}>
                            {getMachineTitle(m)}
                            {m.metadata?.platform ? ` (${m.metadata.platform})` : ''}
                        </option>
                    ))}
                </select>
            </div>

            {/* Directory Input */}
            <div className="flex flex-col gap-1.5 px-3 py-3">
                <label className="text-xs font-medium text-[var(--app-hint)]">
                    Directory
                </label>
                <input
                    type="text"
                    placeholder="/path/to/project"
                    value={directory}
                    onChange={(e) => setDirectory(e.target.value)}
                    disabled={isFormDisabled}
                    className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                />

                {/* Recent Paths */}
                {recentPaths.length > 0 && (
                    <div className="flex flex-col gap-1 mt-1">
                        <span className="text-xs text-[var(--app-hint)]">Recent:</span>
                        <div className="flex flex-wrap gap-1">
                            {recentPaths.map((path) => (
                                <button
                                    key={path}
                                    type="button"
                                    onClick={() => handlePathClick(path)}
                                    disabled={isFormDisabled}
                                    className="rounded bg-[var(--app-subtle-bg)] px-2 py-1 text-xs text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors truncate max-w-[200px] disabled:opacity-50"
                                    title={path}
                                >
                                    {path}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* Agent Selector */}
            <div className="flex flex-col gap-1.5 px-3 py-3">
                <label className="text-xs font-medium text-[var(--app-hint)]">
                    Agent
                </label>
                <div className="flex gap-3">
                    {(['claude', 'codex', 'gemini'] as const).map((agentType) => (
                        <label
                            key={agentType}
                            className="flex items-center gap-1.5 cursor-pointer"
                        >
                            <input
                                type="radio"
                                name="agent"
                                value={agentType}
                                checked={agent === agentType}
                                onChange={() => setAgent(agentType)}
                                disabled={isFormDisabled}
                                className="accent-[var(--app-link)]"
                            />
                            <span className="text-sm capitalize">{agentType}</span>
                        </label>
                    ))}
                </div>
            </div>

            {/* Error Message */}
            {(error ?? spawnError) ? (
                <div className="px-3 py-2 text-sm text-red-600">
                    {error ?? spawnError}
                </div>
            ) : null}

            {/* Action Buttons */}
            <div className="flex gap-2 px-3 py-3">
                <Button
                    variant="secondary"
                    onClick={props.onCancel}
                    disabled={isFormDisabled}
                >
                    Cancel
                </Button>
                <Button
                    onClick={handleCreate}
                    disabled={!canCreate}
                >
                    {isPending ? 'Creating...' : 'Create'}
                </Button>
            </div>
        </div>
    )
}
