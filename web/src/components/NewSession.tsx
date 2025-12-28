import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { Autocomplete } from '@/components/ChatInput/Autocomplete'
import { FloatingOverlay } from '@/components/ChatInput/FloatingOverlay'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { usePlatform } from '@/hooks/usePlatform'
import { useSpawnSession } from '@/hooks/mutations/useSpawnSession'
import { useSessions } from '@/hooks/queries/useSessions'
import { useActiveSuggestions, type Suggestion } from '@/hooks/useActiveSuggestions'
import { useDirectorySuggestions } from '@/hooks/useDirectorySuggestions'
import { useRecentPaths } from '@/hooks/useRecentPaths'

type AgentType = 'claude' | 'codex' | 'gemini'
type SessionType = 'simple' | 'worktree'

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
    const { sessions } = useSessions(props.api)
    const isFormDisabled = isPending || props.isLoading
    const { getRecentPaths, addRecentPath, getLastUsedMachineId, setLastUsedMachineId } = useRecentPaths()

    const [machineId, setMachineId] = useState<string | null>(null)
    const [directory, setDirectory] = useState('')
    const [suppressSuggestions, setSuppressSuggestions] = useState(false)
    const [isDirectoryFocused, setIsDirectoryFocused] = useState(false)
    const [pathExistence, setPathExistence] = useState<Record<string, boolean>>({})
    const [agent, setAgent] = useState<AgentType>('claude')
    const [yoloMode, setYoloMode] = useState(false)
    const [sessionType, setSessionType] = useState<SessionType>('simple')
    const [worktreeName, setWorktreeName] = useState('')
    const [error, setError] = useState<string | null>(null)
    const worktreeInputRef = useRef<HTMLInputElement>(null)

    // Focus worktree input when switching to worktree mode
    useEffect(() => {
        if (sessionType === 'worktree') {
            worktreeInputRef.current?.focus()
        }
    }, [sessionType])

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

    const allPaths = useDirectorySuggestions(machineId, sessions, recentPaths)

    const pathsToCheck = useMemo(
        () => Array.from(new Set(allPaths)).slice(0, 1000),
        [allPaths]
    )

    useEffect(() => {
        let cancelled = false

        if (!machineId || pathsToCheck.length === 0) {
            setPathExistence({})
            return () => { cancelled = true }
        }

        void props.api.checkMachinePathsExists(machineId, pathsToCheck)
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
    }, [machineId, pathsToCheck, props.api])

    const verifiedPaths = useMemo(
        () => allPaths.filter((path) => pathExistence[path]),
        [allPaths, pathExistence]
    )

    const getSuggestions = useCallback(async (query: string): Promise<Suggestion[]> => {
        const lowered = query.toLowerCase()
        return verifiedPaths
            .filter((path) => path.toLowerCase().includes(lowered))
            .slice(0, 8)
            .map((path) => ({
                key: path,
                text: path,
                label: path
            }))
    }, [verifiedPaths])

    const activeQuery = (!isDirectoryFocused || suppressSuggestions) ? null : directory

    const [suggestions, selectedIndex, moveUp, moveDown, clearSuggestions] = useActiveSuggestions(
        activeQuery,
        getSuggestions,
        { allowEmptyQuery: true, autoSelectFirst: false }
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

    const handleSuggestionSelect = useCallback((index: number) => {
        const suggestion = suggestions[index]
        if (suggestion) {
            setDirectory(suggestion.text)
            clearSuggestions()
            setSuppressSuggestions(true)
        }
    }, [suggestions, clearSuggestions])

    const handleDirectoryChange = useCallback((value: string) => {
        setSuppressSuggestions(false)
        setDirectory(value)
    }, [])

    const handleDirectoryFocus = useCallback(() => {
        setSuppressSuggestions(false)
        setIsDirectoryFocused(true)
    }, [])

    const handleDirectoryBlur = useCallback(() => {
        setIsDirectoryFocused(false)
    }, [])

    const handleDirectoryKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (suggestions.length === 0) return

        if (event.key === 'ArrowUp') {
            event.preventDefault()
            moveUp()
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault()
            moveDown()
        }

        if (event.key === 'Enter' || event.key === 'Tab') {
            if (selectedIndex >= 0) {
                event.preventDefault()
                handleSuggestionSelect(selectedIndex)
            }
        }

        if (event.key === 'Escape') {
            clearSuggestions()
        }
    }, [suggestions, selectedIndex, moveUp, moveDown, clearSuggestions, handleSuggestionSelect])

    async function handleCreate() {
        if (!machineId || !directory.trim()) return

        setError(null)
        try {
            const result = await spawnSession({
                machineId,
                directory: directory.trim(),
                agent,
                yolo: yoloMode,
                sessionType,
                worktreeName: sessionType === 'worktree' ? (worktreeName.trim() || undefined) : undefined
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
                        <option value="">Loading machines…</option>
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
                <div className="relative">
                    <input
                        type="text"
                        placeholder="/path/to/project"
                        value={directory}
                        onChange={(event) => handleDirectoryChange(event.target.value)}
                        onKeyDown={handleDirectoryKeyDown}
                        onFocus={handleDirectoryFocus}
                        onBlur={handleDirectoryBlur}
                        disabled={isFormDisabled}
                        className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                    />
                    {suggestions.length > 0 && (
                        <div className="absolute top-full left-0 right-0 z-10 mt-1">
                            <FloatingOverlay maxHeight={200}>
                                <Autocomplete
                                    suggestions={suggestions}
                                    selectedIndex={selectedIndex}
                                    onSelect={handleSuggestionSelect}
                                />
                            </FloatingOverlay>
                        </div>
                    )}
                </div>

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

            {/* Session Type */}
            <div className="flex flex-col gap-1.5 px-3 py-3">
                <label className="text-xs font-medium text-[var(--app-hint)]">
                    Session type
                </label>
                <div className="flex flex-col gap-1.5">
                    {(['simple', 'worktree'] as const).map((type) => (
                        <div key={type} className="flex flex-col gap-2">
                            {type === 'worktree' ? (
                                <div className="flex items-center gap-2">
                                    <input
                                        id="session-type-worktree"
                                        type="radio"
                                        name="sessionType"
                                        value="worktree"
                                        checked={sessionType === 'worktree'}
                                        onChange={() => setSessionType('worktree')}
                                        disabled={isFormDisabled}
                                        className="accent-[var(--app-link)]"
                                    />
                                    <div className="flex-1">
                                        <div className="min-h-[34px] flex items-center">
                                            {sessionType === 'worktree' ? (
                                                <input
                                                    ref={worktreeInputRef}
                                                    type="text"
                                                    placeholder="Branch name (optional)"
                                                    value={worktreeName}
                                                    onChange={(e) => setWorktreeName(e.target.value)}
                                                    disabled={isFormDisabled}
                                                    className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-60"
                                                />
                                            ) : (
                                                <>
                                                    <label
                                                        htmlFor="session-type-worktree"
                                                        className="text-sm capitalize cursor-pointer"
                                                    >
                                                        Worktree
                                                    </label>
                                                    <span className="ml-2 text-xs text-[var(--app-hint)]">
                                                        Create a new git worktree next to the repo
                                                    </span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <label className="flex items-center gap-2 cursor-pointer min-h-[34px]">
                                    <input
                                        id="session-type-simple"
                                        type="radio"
                                        name="sessionType"
                                        value="simple"
                                        checked={sessionType === 'simple'}
                                        onChange={() => setSessionType('simple')}
                                        disabled={isFormDisabled}
                                        className="accent-[var(--app-link)]"
                                    />
                                    <span className="text-sm capitalize">Simple</span>
                                    <span className="text-xs text-[var(--app-hint)]">
                                        Use the selected directory as-is
                                    </span>
                                </label>
                            )}
                        </div>
                    ))}
                </div>
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

            {/* YOLO Mode */}
            <div className="flex flex-col gap-1.5 px-3 py-3">
                <label className="text-xs font-medium text-[var(--app-hint)]">
                    YOLO mode
                </label>
                <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-col">
                        <span className="text-sm text-[var(--app-fg)]">
                            Bypass approvals and sandbox
                        </span>
                        <span className="text-xs text-[var(--app-hint)]">
                            Uses dangerous agent flags when spawning.
                        </span>
                    </div>
                    <label className="relative inline-flex h-5 w-9 items-center">
                        <input
                            type="checkbox"
                            checked={yoloMode}
                            onChange={(e) => setYoloMode(e.target.checked)}
                            disabled={isFormDisabled}
                            className="peer sr-only"
                        />
                        <span className="absolute inset-0 rounded-full bg-[var(--app-border)] transition-colors peer-checked:bg-[var(--app-link)] peer-disabled:opacity-50" />
                        <span className="absolute left-0.5 h-4 w-4 rounded-full bg-[var(--app-bg)] transition-transform peer-checked:translate-x-4 peer-disabled:opacity-50" />
                    </label>
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
                    aria-busy={isPending}
                    className="gap-2"
                >
                    {isPending ? (
                        <>
                            <Spinner size="sm" label={null} className="text-[var(--app-button-text)]" />
                            Creating…
                        </>
                    ) : (
                        'Create'
                    )}
                </Button>
            </div>
        </div>
    )
}
