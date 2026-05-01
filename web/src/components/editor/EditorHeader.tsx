import { useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { useMachines } from '@/hooks/queries/useMachines'

function getMachineLabel(machine: Machine): string {
    return machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id.slice(0, 8)
}

export function EditorHeader(props: {
    api: ApiClient
    machineId: string | null
    projectPath: string | null
    onSelectMachine: (machineId: string) => void
    onSelectProject: (projectPath: string) => void
    onBrowseProject: () => void
}) {
    const navigate = useNavigate()
    const { machines, isLoading: machinesLoading } = useMachines(props.api, true)

    const handleMachineChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
        props.onSelectMachine(event.target.value)
    }, [props])

    return (
        <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] shrink-0">
            <span className="font-semibold text-sm text-[var(--app-fg)] whitespace-nowrap">
                ⚡ HAPI Editor
            </span>

            <span className="text-[var(--app-hint)] text-xs">▸</span>

            <label className="sr-only" htmlFor="editor-machine-select">Machine</label>
            <select
                id="editor-machine-select"
                aria-label="Machine"
                value={props.machineId ?? ''}
                onChange={handleMachineChange}
                disabled={machinesLoading}
                className="bg-[var(--app-bg)] text-[var(--app-fg)] border border-[var(--app-border)] rounded-md px-2 py-1 text-xs min-w-0 max-w-[200px] truncate"
            >
                <option value="" disabled>{machinesLoading ? 'Loading...' : 'Select machine'}</option>
                {machines.map((machine) => (
                    <option key={machine.id} value={machine.id}>
                        🖥 {getMachineLabel(machine)}
                    </option>
                ))}
            </select>

            {props.machineId && (
                <>
                    <span className="text-[var(--app-hint)] text-xs">/</span>
                    <button
                        type="button"
                        aria-label="Browse project folder"
                        title={props.projectPath ?? 'Open folder'}
                        onClick={props.onBrowseProject}
                        className="flex min-w-0 max-w-[420px] items-center gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1 text-left text-xs text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                    >
                        <span className="shrink-0">📁</span>
                        <span className="min-w-0 truncate">
                            {props.projectPath ?? 'Open folder'}
                        </span>
                    </button>
                </>
            )}

            <span className="flex-1" />

            <button
                type="button"
                onClick={() => navigate({ to: '/sessions' })}
                className="px-3 py-1 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] text-xs hover:bg-[var(--app-subtle-bg)] transition-colors"
            >
                ← Agent Mode
            </button>
        </div>
    )
}
