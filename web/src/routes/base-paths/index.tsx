import { useState, useCallback } from 'react'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useBasePaths } from '@/hooks/useBasePaths'
import { useMachines } from '@/hooks/queries/useMachines'
import { useAppContext } from '@/lib/app-context'

function BackIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function TrashIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
        </svg>
    )
}

function PlusIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

export default function BasePathsPage() {
    const goBack = useAppGoBack()
    const { api } = useAppContext()
    const { machines } = useMachines(api, true)
    const { getBasePaths, addBasePath, removeBasePath } = useBasePaths()
    const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null)
    const [newPath, setNewPath] = useState('')
    const [isAdding, setIsAdding] = useState(false)

    const selectedMachine = machines.find(m => m.id === selectedMachineId) ?? machines[0] ?? null
    const currentMachineId = selectedMachine?.id ?? null
    const basePaths = currentMachineId ? getBasePaths(currentMachineId) : []

    const handleAddPath = useCallback(() => {
        if (!currentMachineId || !newPath.trim()) return
        addBasePath(currentMachineId, newPath.trim())
        setNewPath('')
        setIsAdding(false)
    }, [currentMachineId, newPath, addBasePath])

    const handleRemovePath = useCallback((path: string) => {
        if (!currentMachineId) return
        removeBasePath(currentMachineId, path)
    }, [currentMachineId, removeBasePath])

    return (
        <div className="flex h-full flex-col">
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content flex items-center gap-2 p-3 border-b border-[var(--app-border)]">
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                    <div className="flex-1 font-semibold">Base Paths</div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-content">
                    {machines.length === 0 ? (
                        <div className="px-3 py-8 text-center text-sm text-[var(--app-hint)]">
                            No machines available
                        </div>
                    ) : (
                        <>
                            {/* Machine selector */}
                            <div className="border-b border-[var(--app-divider)]">
                                <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                                    Machine
                                </div>
                                <select
                                    value={currentMachineId ?? ''}
                                    onChange={(e) => setSelectedMachineId(e.target.value || null)}
                                    className="w-full px-3 py-3 bg-transparent text-[var(--app-fg)] border-none outline-none"
                                >
                                    {machines.map((machine) => (
                                        <option key={machine.id} value={machine.id}>
                                            {machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {/* Base paths list */}
                            <div className="border-b border-[var(--app-divider)]">
                                <div className="px-3 py-2 flex items-center justify-between">
                                    <div className="text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                                        Base Paths ({basePaths.length}/10)
                                    </div>
                                    {!isAdding && basePaths.length < 10 && (
                                        <button
                                            type="button"
                                            onClick={() => setIsAdding(true)}
                                            className="p-1 rounded-full text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                        >
                                            <PlusIcon className="h-4 w-4" />
                                        </button>
                                    )}
                                </div>

                                {isAdding && (
                                    <div className="px-3 pb-3 flex gap-2">
                                        <input
                                            type="text"
                                            value={newPath}
                                            onChange={(e) => setNewPath(e.target.value)}
                                            placeholder="/path/to/projects"
                                            className="flex-1 px-3 py-2 text-sm bg-[var(--app-bg)] border border-[var(--app-border)] rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                                            autoFocus
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') handleAddPath()
                                                if (e.key === 'Escape') {
                                                    setIsAdding(false)
                                                    setNewPath('')
                                                }
                                            }}
                                        />
                                        <button
                                            type="button"
                                            onClick={handleAddPath}
                                            disabled={!newPath.trim()}
                                            className="px-3 py-2 text-sm bg-[var(--app-link)] text-white rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            Add
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setIsAdding(false)
                                                setNewPath('')
                                            }}
                                            className="px-3 py-2 text-sm text-[var(--app-hint)] hover:text-[var(--app-text)] rounded-md"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                )}

                                {basePaths.length === 0 && !isAdding ? (
                                    <div className="px-3 py-6 text-center text-sm text-[var(--app-hint)]">
                                        No base paths configured. Add paths to enable quick navigation when creating sessions.
                                    </div>
                                ) : (
                                    <div className="flex flex-col divide-y divide-[var(--app-divider)]">
                                        {basePaths.map((path) => (
                                            <div key={path} className="flex items-center gap-3 px-3 py-2 hover:bg-[var(--app-subtle-bg)] transition-colors">
                                                <span className="flex-1 text-sm truncate">{path}</span>
                                                <button
                                                    type="button"
                                                    onClick={() => handleRemovePath(path)}
                                                    className="p-1.5 rounded-full text-red-500 hover:bg-red-500/10 transition-colors"
                                                    title="Remove"
                                                >
                                                    <TrashIcon />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Help text */}
                            <div className="px-3 py-4 text-xs text-[var(--app-hint)]">
                                Base paths are used when creating new sessions. Select a base path to browse its subdirectories and quickly navigate to your project folders.
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}
