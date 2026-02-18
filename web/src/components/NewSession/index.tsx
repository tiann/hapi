import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { usePlatform } from '@/hooks/usePlatform'
import { useSpawnSession } from '@/hooks/mutations/useSpawnSession'
import { useSessions } from '@/hooks/queries/useSessions'
import { useActiveSuggestions, type Suggestion } from '@/hooks/useActiveSuggestions'
import { useDirectorySuggestions } from '@/hooks/useDirectorySuggestions'
import { useRecentPaths } from '@/hooks/useRecentPaths'
import type { AgentType, SessionType } from './types'
import { ActionButtons } from './ActionButtons'
import { AgentSelector } from './AgentSelector'
import { DirectorySection } from './DirectorySection'
import { MachineSelector } from './MachineSelector'
import { ModelSelector } from './ModelSelector'
import {
    loadPreferredAgent,
    loadPreferredYoloMode,
    savePreferredAgent,
    savePreferredYoloMode,
} from './preferences'
import { SessionTypeSelector } from './SessionTypeSelector'
import { YoloToggle } from './YoloToggle'

export function NewSession(props: {
    api: ApiClient
    machines: Machine[]
    isLoading?: boolean
    initialDirectory?: string
    initialMachineId?: string
    onSuccess: (sessionId: string) => void
    onCancel: () => void
}) {
    const { haptic } = usePlatform()
    const { spawnSession, isPending, error: spawnError } = useSpawnSession(props.api)
    const { sessions } = useSessions(props.api)
    const isFormDisabled = Boolean(isPending || props.isLoading)
    const { getRecentPaths, addRecentPath, getLastUsedMachineId, setLastUsedMachineId } = useRecentPaths()

    const [machineId, setMachineId] = useState<string | null>(null)
    const [directory, setDirectory] = useState(() => props.initialDirectory?.trim() ?? '')
    const [suppressSuggestions, setSuppressSuggestions] = useState(false)
    const [isDirectoryFocused, setIsDirectoryFocused] = useState(false)
    const [pathExistence, setPathExistence] = useState<Record<string, boolean>>({})
    const [agent, setAgent] = useState<AgentType>(loadPreferredAgent)
    const [model, setModel] = useState('auto')
    const [yoloMode, setYoloMode] = useState(loadPreferredYoloMode)
    const [sessionType, setSessionType] = useState<SessionType>('simple')
    const [worktreeName, setWorktreeName] = useState('')
    const [worktreeBranch, setWorktreeBranch] = useState('')
    const [availableBranches, setAvailableBranches] = useState<string[]>([])
    const [isBranchFocused, setIsBranchFocused] = useState(false)
    const [suppressBranchSuggestions, setSuppressBranchSuggestions] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const worktreeInputRef = useRef<HTMLInputElement>(null)
    const worktreeBranchInputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (sessionType === 'worktree') {
            worktreeInputRef.current?.focus()
        }
    }, [sessionType])

    useEffect(() => {
        if (sessionType !== 'worktree') {
            setAvailableBranches([])
            return
        }

        const trimmedDirectory = directory.trim()
        if (!machineId || !trimmedDirectory) {
            setAvailableBranches([])
            return
        }

        let cancelled = false
        const timeout = setTimeout(() => {
            void props.api.listMachineGitBranches(machineId, trimmedDirectory, 300)
                .then((result) => {
                    if (cancelled) return
                    const branches = Array.isArray(result.branches)
                        ? result.branches
                            .filter((value): value is string => typeof value === 'string')
                            .map((value) => value.trim())
                            .filter(Boolean)
                        : []
                    setAvailableBranches(Array.from(new Set(branches)))
                })
                .catch(() => {
                    if (cancelled) return
                    setAvailableBranches([])
                })
        }, 250)

        return () => {
            cancelled = true
            clearTimeout(timeout)
        }
    }, [props.api, machineId, directory, sessionType])

    useEffect(() => {
        setModel('auto')
    }, [agent])

    useEffect(() => {
        savePreferredAgent(agent)
    }, [agent])

    useEffect(() => {
        savePreferredYoloMode(yoloMode)
    }, [yoloMode])

    useEffect(() => {
        if (props.machines.length === 0) return
        if (machineId && props.machines.find((m) => m.id === machineId)) return

        const foundInitial = props.initialMachineId
            ? props.machines.find((m) => m.id === props.initialMachineId)
            : null
        if (foundInitial) {
            setMachineId(foundInitial.id)
            return
        }

        const lastUsed = getLastUsedMachineId()
        const foundLast = lastUsed ? props.machines.find((m) => m.id === lastUsed) : null

        if (foundLast) {
            setMachineId(foundLast.id)
            const paths = getRecentPaths(foundLast.id)
            if (paths[0] && !props.initialDirectory?.trim()) {
                setDirectory(paths[0])
            }
        } else if (props.machines[0]) {
            setMachineId(props.machines[0].id)
        }
    }, [props.machines, machineId, getLastUsedMachineId, getRecentPaths, props.initialDirectory, props.initialMachineId])

    useEffect(() => {
        if (!props.initialMachineId) return
        if (!props.machines.find((m) => m.id === props.initialMachineId)) return
        if (machineId && props.machines.find((m) => m.id === machineId)) return
        setMachineId(props.initialMachineId)
    }, [props.initialMachineId, props.machines, machineId])

    useEffect(() => {
        const nextDirectory = props.initialDirectory?.trim()
        if (!nextDirectory) return
        setDirectory(nextDirectory)
    }, [props.initialDirectory])

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

    const getBranchSuggestions = useCallback(async (query: string): Promise<Suggestion[]> => {
        const normalized = query.trim().toLowerCase()
        const filtered = normalized.length === 0
            ? availableBranches
            : availableBranches.filter((branch) => branch.toLowerCase().includes(normalized))

        return filtered
            .slice(0, 10)
            .map((branch) => ({
                key: branch,
                text: branch,
                label: branch
            }))
    }, [availableBranches])

    const activeBranchQuery = sessionType === 'worktree' && isBranchFocused && !suppressBranchSuggestions
        ? worktreeBranch
        : null

    const [branchSuggestions, branchSelectedIndex, moveBranchUp, moveBranchDown, clearBranchSuggestions] = useActiveSuggestions(
        activeBranchQuery,
        getBranchSuggestions,
        { allowEmptyQuery: true, autoSelectFirst: false }
    )

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

    const handleWorktreeBranchSuggestionSelect = useCallback((index: number) => {
        const suggestion = branchSuggestions[index]
        if (!suggestion) return
        setWorktreeBranch(suggestion.text)
        clearBranchSuggestions()
        setSuppressBranchSuggestions(true)
    }, [branchSuggestions, clearBranchSuggestions])

    const handleWorktreeBranchKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (branchSuggestions.length === 0) return

        if (event.key === 'ArrowUp') {
            event.preventDefault()
            moveBranchUp()
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault()
            moveBranchDown()
        }

        if (event.key === 'Enter' || event.key === 'Tab') {
            if (branchSelectedIndex >= 0) {
                event.preventDefault()
                handleWorktreeBranchSuggestionSelect(branchSelectedIndex)
            }
        }

        if (event.key === 'Escape') {
            clearBranchSuggestions()
        }
    }, [branchSuggestions, branchSelectedIndex, moveBranchUp, moveBranchDown, clearBranchSuggestions, handleWorktreeBranchSuggestionSelect])

    const handleWorktreeBranchFocus = useCallback(() => {
        setSuppressBranchSuggestions(false)
        setIsBranchFocused(true)
    }, [])

    const handleWorktreeBranchBlur = useCallback(() => {
        setIsBranchFocused(false)
    }, [])

    const handleWorktreeBranchChange = useCallback((value: string) => {
        setSuppressBranchSuggestions(false)
        setWorktreeBranch(value)
    }, [])

    async function handleCreate() {
        if (!machineId || !directory.trim()) return

        setError(null)
        try {
            const resolvedModel = model !== 'auto' && agent !== 'opencode' ? model : undefined
            const result = await spawnSession({
                machineId,
                directory: directory.trim(),
                agent,
                model: resolvedModel,
                yolo: yoloMode,
                sessionType,
                worktreeName: sessionType === 'worktree' ? (worktreeName.trim() || undefined) : undefined,
                worktreeBranch: sessionType === 'worktree' ? (worktreeBranch.trim() || undefined) : undefined
            })

            if (result.type === 'success') {
                haptic.notification('success')
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

    const canCreate = Boolean(machineId && directory.trim() && !isFormDisabled)

    return (
        <div className="flex flex-col divide-y divide-[var(--app-divider)]">
            <MachineSelector
                machines={props.machines}
                machineId={machineId}
                isLoading={props.isLoading}
                isDisabled={isFormDisabled}
                onChange={handleMachineChange}
            />
            <DirectorySection
                directory={directory}
                suggestions={suggestions}
                selectedIndex={selectedIndex}
                isDisabled={isFormDisabled}
                recentPaths={recentPaths}
                onDirectoryChange={handleDirectoryChange}
                onDirectoryFocus={handleDirectoryFocus}
                onDirectoryBlur={handleDirectoryBlur}
                onDirectoryKeyDown={handleDirectoryKeyDown}
                onSuggestionSelect={handleSuggestionSelect}
                onPathClick={handlePathClick}
            />
            <SessionTypeSelector
                sessionType={sessionType}
                worktreeName={worktreeName}
                worktreeBranch={worktreeBranch}
                branchSuggestions={branchSuggestions}
                branchSelectedIndex={branchSelectedIndex}
                worktreeInputRef={worktreeInputRef}
                worktreeBranchInputRef={worktreeBranchInputRef}
                isDisabled={isFormDisabled}
                onSessionTypeChange={setSessionType}
                onWorktreeNameChange={setWorktreeName}
                onWorktreeBranchChange={handleWorktreeBranchChange}
                onWorktreeBranchFocus={handleWorktreeBranchFocus}
                onWorktreeBranchBlur={handleWorktreeBranchBlur}
                onWorktreeBranchKeyDown={handleWorktreeBranchKeyDown}
                onWorktreeBranchSuggestionSelect={handleWorktreeBranchSuggestionSelect}
            />
            <AgentSelector
                agent={agent}
                isDisabled={isFormDisabled}
                onAgentChange={setAgent}
            />
            <ModelSelector
                agent={agent}
                model={model}
                isDisabled={isFormDisabled}
                onModelChange={setModel}
            />
            <YoloToggle
                yoloMode={yoloMode}
                isDisabled={isFormDisabled}
                onToggle={setYoloMode}
            />

            {(error ?? spawnError) ? (
                <div className="px-3 py-2 text-sm text-red-600">
                    {error ?? spawnError}
                </div>
            ) : null}

            <ActionButtons
                isPending={isPending}
                canCreate={canCreate}
                isDisabled={isFormDisabled}
                onCancel={props.onCancel}
                onCreate={handleCreate}
            />
        </div>
    )
}
