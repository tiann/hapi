import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ApiClient } from '@/api/client'
import type { CodexLocalSessionSummary, Machine } from '@/types/api'
import type { GrokPermissionMode } from '@hapi/protocol'
import { usePlatform } from '@/hooks/usePlatform'
import { useMachinePathsExists } from '@/hooks/useMachinePathsExists'
import { useSpawnSession } from '@/hooks/mutations/useSpawnSession'
import { useCodexModels } from '@/hooks/queries/useCodexModels'
import { useCursorModelsForMachine } from '@/hooks/queries/useCursorModelsForMachine'
import { useOpencodeModelsForCwd } from '@/hooks/queries/useOpencodeModelsForCwd'
import { useGrokModelsForCwd } from '@/hooks/queries/useGrokModelsForCwd'
import { useSessions } from '@/hooks/queries/useSessions'
import { useActiveSuggestions, type Suggestion } from '@/hooks/useActiveSuggestions'
import { useDirectorySuggestions } from '@/hooks/useDirectorySuggestions'
import { useRecentPaths } from '@/hooks/useRecentPaths'
import { useTranslation } from '@/lib/use-translation'
import { getCodexModelReasoningEfforts } from '@/lib/codexModelCapabilities'
import {
    buildNewSessionCursorPickerState,
    isCursorEffortWireAllowed,
    resolveCursorBaseFromWire,
    resolveNewSessionCursorBaseSelectValue,
    resolveNewSessionCursorEffortSelectValue,
    resolveWireIdForBaseChange,
    shouldShowCursorModelsUnavailable
} from './newSessionCursorModels'
import { buildCursorEffortPickerOptions, resolveCursorVariantOptions } from '@/lib/cursorModelOptions'
import {
    clearNewSessionFormDraft,
    loadNewSessionFormDraft,
    newSessionDraftMatchesMachine,
    saveNewSessionFormDraft,
    shouldRestoreNewSessionFormDraft
} from './newSessionFormDraft'
import type { AgentType, LaunchEffort, CodexReasoningEffort, SessionType } from './types'
import { ActionButtons } from './ActionButtons'
import { AgentSelector } from './AgentSelector'
import { DirectorySection } from './DirectorySection'
import { GrokPermissionModeSelector } from './GrokPermissionModeSelector'
import { MachineSelector } from './MachineSelector'
import { ModelSelector } from './ModelSelector'
import { OpencodeModelSelector } from './OpencodeModelSelector'
import { LaunchEffortSelector } from './LaunchEffortSelector'
import { shouldEnableOpencodeModelDiscovery } from './opencodeModelsGate'
import { buildGrokEffortOptions, buildGrokModelOptions, shouldEnableGrokModelDiscovery } from './grokModels'
import { ReasoningEffortSelector } from './ReasoningEffortSelector'
import {
    loadPreferredAgent,
    loadPreferredYoloMode,
    savePreferredAgent,
    savePreferredYoloMode,
} from './preferences'
import { SessionTypeSelector } from './SessionTypeSelector'
import { YoloToggle } from './YoloToggle'
import { CodexSessionSyncDialog } from '@/components/CodexSessionSyncDialog'
import { formatRunnerSpawnError } from '../../utils/formatRunnerSpawnError'
import { markCodexSessionsImported } from '@/lib/codexImportedSessions'




function CodexImportSelectButton(props: {
    selectedSession: CodexLocalSessionSummary | null
    isLoading: boolean
    isDisabled: boolean
    error: string | null
    onOpen: () => void
    onClear: () => void
}) {
    const { t } = useTranslation()
    return (
        <div className="flex flex-col gap-2 px-3 py-3">
            <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                    <div className="text-xs font-medium text-[var(--app-hint)]">{t('codexSync.newSessionInline.title')}</div>
                    <div className="truncate text-[11px] text-[var(--app-hint)]">
                        {props.selectedSession ? props.selectedSession.title : t('codexSync.newSessionInline.description')}
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {props.selectedSession ? (
                        <button type="button" className="text-xs text-[var(--app-link)]" onClick={props.onClear} disabled={props.isDisabled}>
                            {t('codexSync.newSessionInline.clear')}
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1.5 text-xs text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] disabled:opacity-50"
                        onClick={props.onOpen}
                        disabled={props.isDisabled || props.isLoading}
                    >
                        {props.isLoading ? t('codexSync.confirm.loading') : t('codexSync.newSessionInline.choose')}
                    </button>
                </div>
            </div>
            {props.error ? <div className="text-xs text-red-600">{props.error}</div> : null}
        </div>
    )
}

export function NewSession(props: {
    api: ApiClient
    machines: Machine[]
    isLoading?: boolean
    onSuccess: (sessionId: string) => void
    onCancel: () => void
    onChooseFolder?: (args: { machineId: string | null; directory: string }) => void
    initialDirectory?: string
    initialMachineId?: string
}) {
    const { haptic } = usePlatform()
    const { t } = useTranslation()
    const { spawnSession, isPending, error: spawnError } = useSpawnSession(props.api)
    const { sessions } = useSessions(props.api)
    const { getRecentPaths, addRecentPath, getLastUsedMachineId, setLastUsedMachineId } = useRecentPaths()

    const [machineId, setMachineId] = useState<string | null>(props.initialMachineId ?? null)
    const [directory, setDirectory] = useState(props.initialDirectory ?? '')
    const [suppressSuggestions, setSuppressSuggestions] = useState(false)
    const [isDirectoryFocused, setIsDirectoryFocused] = useState(false)
    const [agent, setAgent] = useState<AgentType>(loadPreferredAgent)
    const [model, setModel] = useState('auto')
    const [cursorSelectedBase, setCursorSelectedBase] = useState('auto')
    const pendingCursorBaseRef = useRef<string | null>(null)
    const [effort, setEffort] = useState<LaunchEffort>('auto')
    const [modelReasoningEffort, setModelReasoningEffort] = useState<CodexReasoningEffort>('default')
    const [yoloMode, setYoloMode] = useState(loadPreferredYoloMode)
    const [grokPermissionMode, setGrokPermissionMode] = useState<GrokPermissionMode>('default')
    const [sessionType, setSessionType] = useState<SessionType>('simple')
    const [worktreeName, setWorktreeName] = useState('')
    const [directoryCreationConfirmed, setDirectoryCreationConfirmed] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [codexImportSessions, setCodexImportSessions] = useState<CodexLocalSessionSummary[]>([])
    const [selectedCodexImportSessionId, setSelectedCodexImportSessionId] = useState<string | null>(null)
    const [codexImportMachineId, setCodexImportMachineId] = useState<string | null>(null)
    const [isLoadingCodexImportSessions, setIsLoadingCodexImportSessions] = useState(false)
    const [codexImportError, setCodexImportError] = useState<string | null>(null)
    const [isImportingCodexSession, setIsImportingCodexSession] = useState(false)
    const [isCodexImportDialogOpen, setIsCodexImportDialogOpen] = useState(false)
    const isFormDisabled = Boolean(isPending || props.isLoading || isImportingCodexSession)
    const worktreeInputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (sessionType === 'worktree') {
            worktreeInputRef.current?.focus()
        }
    }, [sessionType])

    useEffect(() => {
        setEffort('auto')
        setModelReasoningEffort('default')
        setGrokPermissionMode('default')
        if (agent !== 'cursor') {
            setModel('auto')
            setCursorSelectedBase('auto')
        }
    }, [agent])

    useEffect(() => {
        savePreferredAgent(agent)
    }, [agent])

    useEffect(() => {
        if (agent !== 'codex') {
            setSelectedCodexImportSessionId(null)
            setCodexImportSessions([])
            setCodexImportMachineId(null)
            setCodexImportError(null)
        }
    }, [agent])

    useEffect(() => {
        savePreferredYoloMode(yoloMode)
    }, [yoloMode])

    useEffect(() => {
        if (props.initialDirectory !== undefined) {
            setDirectory(props.initialDirectory)
        }
    }, [props.initialDirectory])

    useEffect(() => {
        if (props.initialMachineId !== undefined) {
            setMachineId(props.initialMachineId)
        }
    }, [props.initialMachineId])

    const restoredFromBrowseRef = useRef(false)
    useEffect(() => {
        if (restoredFromBrowseRef.current) {
            return
        }
        if (!shouldRestoreNewSessionFormDraft({
            initialDirectory: props.initialDirectory,
            initialMachineId: props.initialMachineId
        })) {
            return
        }
        const draft = loadNewSessionFormDraft()
        if (!draft) {
            return
        }
        const targetMachineId = props.initialMachineId ?? machineId
        if (!newSessionDraftMatchesMachine(draft, targetMachineId)) {
            clearNewSessionFormDraft()
            return
        }
        restoredFromBrowseRef.current = true
        setAgent(draft.agent)
        setModel(draft.model)
        setCursorSelectedBase(draft.cursorSelectedBase)
        setEffort(draft.effort)
        setModelReasoningEffort(draft.modelReasoningEffort)
        setYoloMode(draft.yoloMode)
        setGrokPermissionMode(draft.grokPermissionMode)
        setSessionType(draft.sessionType)
        setWorktreeName(draft.worktreeName)
        clearNewSessionFormDraft()
    }, [
        props.initialDirectory,
        props.initialMachineId,
        machineId
    ])

    useEffect(() => {
        if (props.machines.length === 0) return
        if (machineId && props.machines.find((m) => m.id === machineId)) return

        const lastUsed = getLastUsedMachineId()
        const foundLast = lastUsed ? props.machines.find((m) => m.id === lastUsed) : null

        if (foundLast) {
            setMachineId(foundLast.id)
            if (!props.initialDirectory) {
                const paths = getRecentPaths(foundLast.id)
                if (paths[0]) setDirectory(paths[0])
            }
        } else if (props.machines[0]) {
            setMachineId(props.machines[0].id)
        }
    }, [props.machines, machineId, getLastUsedMachineId, getRecentPaths, props.initialDirectory])

    const selectedMachine = useMemo(
        () => (machineId ? props.machines.find((machine) => machine.id === machineId) ?? null : null),
        [machineId, props.machines]
    )
    const codexModelsState = useCodexModels({
        api: props.api,
        machineId,
        enabled: agent === 'codex' && Boolean(machineId)
    })
    const [opencodeSelectedModel, setOpencodeSelectedModel] = useState<string | null>(null)
    const runnerSpawnError = useMemo(
        () => formatRunnerSpawnError(selectedMachine),
        [selectedMachine]
    )
    const codexModelOptions = useMemo(() => {
        const options = [{ value: 'auto', label: 'Default' }]
        for (const codexModel of codexModelsState.models) {
            options.push({
                value: codexModel.id,
                label: codexModel.displayName
            })
        }
        if (model !== 'auto' && !options.some((option) => option.value === model)) {
            options.splice(1, 0, { value: model, label: model })
        }
        return options
    }, [codexModelsState.models, model])
    const codexSupportedReasoningEfforts = useMemo(
        () => getCodexModelReasoningEfforts(codexModelsState.models, model),
        [codexModelsState.models, model]
    )
    const codexReasoningEffortOptions = useMemo(
        () => codexSupportedReasoningEfforts?.map((value) => ({ value })),
        [codexSupportedReasoningEfforts]
    )

    useEffect(() => {
        if (
            agent !== 'codex'
            || modelReasoningEffort === 'default'
            || !codexSupportedReasoningEfforts
            || codexSupportedReasoningEfforts.includes(modelReasoningEffort)
        ) {
            return
        }
        setModelReasoningEffort('default')
    }, [agent, codexSupportedReasoningEfforts, modelReasoningEffort])
    const cursorModelsState = useCursorModelsForMachine({
        api: props.api,
        machineId,
        enabled: agent === 'cursor' && Boolean(machineId)
    })
    const cursorPicker = useMemo(
        () => buildNewSessionCursorPickerState(
            cursorModelsState.availableModels,
            model,
            cursorModelsState.cliModelSkus
        ),
        [cursorModelsState.availableModels, cursorModelsState.cliModelSkus, model]
    )

    const cursorBaseSelectValue = useMemo(
        () => resolveNewSessionCursorBaseSelectValue(cursorPicker, cursorSelectedBase),
        [cursorPicker, cursorSelectedBase]
    )

    const cursorVariantOptions = useMemo(() => {
        if (cursorPicker.mode !== 'dual') {
            return cursorPicker.effortOptions
        }
        const baseKey = cursorBaseSelectValue !== 'auto'
            ? cursorBaseSelectValue
            : cursorPicker.baseKey
        return buildCursorEffortPickerOptions(resolveCursorVariantOptions(baseKey ?? null, cursorPicker.catalog))
    }, [cursorPicker, cursorBaseSelectValue])

    const cursorVariantSelectOptions = useMemo(() => {
        if (cursorVariantOptions.length === 0) {
            return []
        }
        return [
            { value: 'auto', label: t('newSession.model.selectVariant') },
            ...cursorVariantOptions
        ]
    }, [cursorVariantOptions, t])

    const cursorEffortSelectValue = useMemo(
        () => resolveNewSessionCursorEffortSelectValue(model, cursorVariantOptions),
        [model, cursorVariantOptions]
    )

    useEffect(() => {
        if (agent !== 'cursor' || cursorModelsState.isLoading) {
            return
        }
        if (model === 'auto' && cursorSelectedBase !== 'auto') {
            return
        }
        if (model === 'auto') {
            return
        }
        const base = resolveCursorBaseFromWire(model, cursorPicker.catalog)
        if (cursorSelectedBase === base) {
            return
        }
        setCursorSelectedBase(base)
    }, [
        agent,
        model,
        cursorModelsState.isLoading,
        cursorPicker.catalog,
        cursorSelectedBase
    ])

    const showCursorVariantPicker = cursorPicker.mode === 'dual' && cursorVariantOptions.length > 1

    useEffect(() => {
        if (agent !== 'cursor' || cursorModelsState.isLoading) {
            return
        }
        const pendingBase = pendingCursorBaseRef.current
        if (!pendingBase) {
            return
        }
        if (cursorPicker.catalog.variantsByBase.size === 0) {
            return
        }
        pendingCursorBaseRef.current = null
        if (pendingBase === 'auto') {
            setModel('auto')
            return
        }
        setModel(resolveWireIdForBaseChange(pendingBase, cursorPicker.catalog, model) ?? 'auto')
    }, [
        agent,
        cursorModelsState.isLoading,
        cursorPicker.catalog,
        model
    ])
    const cursorModelPickersDisabled = isFormDisabled
        || Boolean(cursorModelsState.error)
        || cursorModelsState.isLoading
        || !machineId
    const cursorModelsUnavailable = shouldShowCursorModelsUnavailable({
        agent,
        isLoading: cursorModelsState.isLoading,
        error: cursorModelsState.error,
        availableModels: cursorModelsState.availableModels
    })

    const recentPaths = useMemo(
        () => getRecentPaths(machineId),
        [getRecentPaths, machineId]
    )

    const trimmedDirectory = directory.trim()
    const deferredDirectory = useDeferredValue(trimmedDirectory)
    const allPaths = useDirectorySuggestions(machineId, sessions, recentPaths)

    const pathsToCheck = useMemo(
        () => Array.from(new Set([
            ...(deferredDirectory ? [deferredDirectory] : []),
            ...allPaths
        ])).slice(0, 1000),
        [allPaths, deferredDirectory]
    )

    const { pathExistence, checkPathsExists } = useMachinePathsExists(props.api, machineId, pathsToCheck)

    const verifiedPaths = useMemo(
        () => allPaths.filter((path) => pathExistence[path]),
        [allPaths, pathExistence]
    )

    const deferredDirectoryExists = deferredDirectory
        ? pathExistence[deferredDirectory]
        : undefined
    const opencodeModelsState = useOpencodeModelsForCwd({
        api: props.api,
        machineId,
        cwd: deferredDirectory,
        // Gate on positive existence: typing partial paths must not spawn an
        // expensive `opencode acp` probe for a non-existent cwd while the
        // existence check is in flight.
        enabled: shouldEnableOpencodeModelDiscovery({
            agent,
            machineId,
            cwd: deferredDirectory,
            cwdExists: deferredDirectoryExists,
        })
    })
    const grokModelsState = useGrokModelsForCwd({
        api: props.api,
        machineId,
        cwd: deferredDirectory,
        enabled: shouldEnableGrokModelDiscovery({
            agent,
            machineId,
            cwd: deferredDirectory,
            cwdExists: deferredDirectoryExists,
        })
    })
    const grokModelOptions = useMemo(
        () => buildGrokModelOptions(grokModelsState.availableModels),
        [grokModelsState.availableModels]
    )
    const grokEffortOptions = useMemo(
        () => buildGrokEffortOptions(
            grokModelsState.availableModels,
            model,
            grokModelsState.currentModelId
        ),
        [grokModelsState.availableModels, grokModelsState.currentModelId, model]
    )
    useEffect(() => {
        if (
            agent === 'grok'
            && grokPermissionMode === 'auto'
            && grokModelsState.autoPermissionModeSupported === false
        ) {
            setGrokPermissionMode('default')
        }
    }, [agent, grokPermissionMode, grokModelsState.autoPermissionModeSupported])
    useEffect(() => {
        // Auto-pick the OpenCode default model when discovery finishes, so the
        // form has a sensible value if the user hits Enter without scrolling.
        if (agent !== 'opencode') return
        if (opencodeSelectedModel !== null) return
        const fallback = opencodeModelsState.currentModelId
            ?? opencodeModelsState.availableModels[0]?.modelId
            ?? null
        if (fallback) {
            setOpencodeSelectedModel(fallback)
        }
    }, [agent, opencodeSelectedModel, opencodeModelsState.currentModelId, opencodeModelsState.availableModels])
    useEffect(() => {
        // Reset selection when agent / machine / directory changes; new probe = new defaults.
        setOpencodeSelectedModel(null)
    }, [agent, machineId, deferredDirectory])

    const currentDirectoryExists = trimmedDirectory ? pathExistence[trimmedDirectory] : undefined
    const needsDirectoryCreationWarning = sessionType === 'simple' && trimmedDirectory !== '' && currentDirectoryExists === false
    const missingWorktreeDirectory = sessionType === 'worktree' && trimmedDirectory !== '' && currentDirectoryExists === false
    const directoryStatusMessage = missingWorktreeDirectory
        ? t('session.directoryMissingWorktree')
        : needsDirectoryCreationWarning
            ? (
                directoryCreationConfirmed
                    ? t('session.directoryMissingSimpleConfirm')
                    : t('session.directoryMissingSimple')
            )
            : null
    const directoryStatusTone = missingWorktreeDirectory ? 'error' : needsDirectoryCreationWarning ? 'warning' : null
    const createLabel = needsDirectoryCreationWarning && directoryCreationConfirmed
        ? t('session.createAndCreateDirectory')
        : undefined

    useEffect(() => {
        setDirectoryCreationConfirmed(false)
    }, [machineId, sessionType, trimmedDirectory])

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



    const handleArchiveCodexImportSession = useCallback(async (session: CodexLocalSessionSummary) => {
        if (!props.api) return
        const result = await props.api.archiveCodexSession(session.id, codexImportMachineId ?? machineId)
        if (!result.success) {
            throw new Error(result.error)
        }
        setCodexImportSessions((current) => current.filter((item) => item.id !== session.id))
        if (selectedCodexImportSessionId === session.id) {
            setSelectedCodexImportSessionId(null)
        }
    }, [codexImportMachineId, machineId, props.api, selectedCodexImportSessionId])

    const loadCodexImportSessions = useCallback(async () => {
        if (agent !== 'codex' || !machineId) return
        setIsLoadingCodexImportSessions(true)
        setCodexImportError(null)
        try {
            const result = await props.api.getCodexSessions(trimmedDirectory || null, machineId)
            setCodexImportSessions(result.sessions)
            setCodexImportMachineId(result.machineId ?? machineId)
            setSelectedCodexImportSessionId((current) => current && result.sessions.some((session) => session.id === current) ? current : null)
        } catch (e) {
            setCodexImportSessions([])
            setCodexImportMachineId(null)
            setSelectedCodexImportSessionId(null)
            setCodexImportError(e instanceof Error ? e.message : t('codexSync.failed.body'))
        } finally {
            setIsLoadingCodexImportSessions(false)
        }
    }, [agent, machineId, props.api, trimmedDirectory, t])

    const selectedCodexImportSession = useMemo(
        () => codexImportSessions.find((session) => session.id === selectedCodexImportSessionId) ?? null,
        [codexImportSessions, selectedCodexImportSessionId]
    )

    const handleMachineChange = useCallback((newMachineId: string) => {
        setMachineId(newMachineId)
        setModel('auto')
        setCursorSelectedBase('auto')
        setSelectedCodexImportSessionId(null)
        setCodexImportSessions([])
        setCodexImportMachineId(null)
        const paths = getRecentPaths(newMachineId)
        if (paths[0]) {
            setDirectory(paths[0])
        } else {
            setDirectory('')
        }
    }, [getRecentPaths])

    const handleCursorBaseChange = useCallback((baseKey: string) => {
        if (baseKey === 'auto') {
            pendingCursorBaseRef.current = null
            setCursorSelectedBase('auto')
            setModel('auto')
            return
        }
        setCursorSelectedBase(baseKey)
        if (cursorModelsState.isLoading || cursorPicker.catalog.variantsByBase.size === 0) {
            pendingCursorBaseRef.current = baseKey
            return
        }
        pendingCursorBaseRef.current = null
        setModel(resolveWireIdForBaseChange(baseKey, cursorPicker.catalog, model) ?? 'auto')
    }, [cursorModelsState.isLoading, cursorPicker.catalog, model])

    const handleCursorEffortChange = useCallback((wireId: string) => {
        if (wireId === 'auto') {
            setModel('auto')
            return
        }
        const baseKey = cursorSelectedBase !== 'auto'
            ? cursorSelectedBase
            : cursorPicker.baseKey
        if (baseKey && !isCursorEffortWireAllowed(wireId, cursorPicker.catalog, baseKey)) {
            return
        }
        setModel(wireId)
    }, [cursorPicker.catalog, cursorPicker.baseKey, cursorSelectedBase])

    const handleChooseFolderClick = useCallback(() => {
        if (!props.onChooseFolder) {
            return
        }
        saveNewSessionFormDraft({
            agent,
            model,
            cursorSelectedBase,
            machineId,
            effort,
            modelReasoningEffort,
            yoloMode,
            grokPermissionMode,
            sessionType,
            worktreeName
        })
        props.onChooseFolder({ machineId, directory: trimmedDirectory })
    }, [
        props.onChooseFolder,
        agent,
        model,
        cursorSelectedBase,
        machineId,
        effort,
        modelReasoningEffort,
        yoloMode,
        grokPermissionMode,
        sessionType,
        worktreeName,
        trimmedDirectory
    ])

    const handleSelectCodexImportSession = useCallback((session: CodexLocalSessionSummary) => {
        setSelectedCodexImportSessionId(session.id)
        if (session.cwd?.trim()) {
            setDirectory(session.cwd.trim())
        }
    }, [])

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
        if (!machineId || !trimmedDirectory) return

        setError(null)
        try {
            const existsResult = await checkPathsExists([trimmedDirectory])
            const directoryExists = existsResult[trimmedDirectory]

            if (sessionType === 'worktree' && directoryExists === false) {
                haptic.notification('error')
                setError(t('session.directoryMissingWorktree'))
                return
            }

            if (sessionType === 'simple' && directoryExists === false && !directoryCreationConfirmed) {
                setDirectoryCreationConfirmed(true)
                return
            }

            if (
                agent === 'cursor'
                && cursorPicker.mode === 'dual'
                && cursorBaseSelectValue !== 'auto'
                && cursorVariantOptions.length > 1
                && !cursorVariantOptions.some((option) => option.value === model)
            ) {
                haptic.notification('error')
                setError(t('newSession.model.selectVariant'))
                return
            }

            const resolvedModel = agent === 'opencode'
                ? (opencodeSelectedModel ?? undefined)
                : (model !== 'auto' ? model : undefined)
            const resolvedEffort = (agent === 'claude' || agent === 'grok') && effort !== 'auto'
                ? effort
                : undefined
            const resolvedModelReasoningEffort = (agent === 'codex' || agent === 'opencode') && modelReasoningEffort !== 'default'
                ? modelReasoningEffort
                : undefined

            if (agent === 'codex' && selectedCodexImportSession) {
                setIsImportingCodexSession(true)
                const result = await props.api.syncCodexSession({
                    sessionIds: [selectedCodexImportSession.id],
                    cwd: selectedCodexImportSession.cwd ?? trimmedDirectory,
                    machineId: codexImportMachineId ?? machineId,
                    model: resolvedModel ?? null,
                    modelReasoningEffort: resolvedModelReasoningEffort ?? null,
                    yolo: yoloMode
                })
                if (result.success) {
                    const importedSessionId = result.hapiSessionIds?.[0]
                    if (!importedSessionId) {
                        throw new Error('Imported session id missing')
                    }
                    // 中文注释：Codex transcript 导入只会创建 Hapi 记录，不会自动启动 agent。
                    // 这里立刻 resume，避免进入会话页时先看到离线，等首条消息才触发启动。
                    const resumedSessionId = await props.api.resumeSession(
                        importedSessionId,
                        yoloMode ? { permissionMode: 'yolo' } : undefined
                    )
                    haptic.notification('success')
                    markCodexSessionsImported([selectedCodexImportSession.id])
                    clearNewSessionFormDraft()
                    setLastUsedMachineId(machineId)
                    addRecentPath(machineId, trimmedDirectory)
                    props.onSuccess(resumedSessionId)
                    return
                }
                setIsImportingCodexSession(false)
                haptic.notification('error')
                setError(result.error || result.message || t('codexSync.failed.body'))
                return
            }

            const result = await spawnSession({
                machineId,
                directory: trimmedDirectory,
                agent,
                model: resolvedModel,
                effort: resolvedEffort,
                modelReasoningEffort: resolvedModelReasoningEffort,
                yolo: agent === 'grok' ? undefined : yoloMode,
                permissionMode: agent === 'grok' ? grokPermissionMode : undefined,
                sessionType,
                worktreeName: sessionType === 'worktree' ? (worktreeName.trim() || undefined) : undefined
            })

            if (result.type === 'success') {
                haptic.notification('success')
                clearNewSessionFormDraft()
                setLastUsedMachineId(machineId)
                addRecentPath(machineId, trimmedDirectory)
                props.onSuccess(result.sessionId)
                return
            }

            haptic.notification('error')
            setError(result.message)
        } catch (e) {
            setIsImportingCodexSession(false)
            haptic.notification('error')
            setError(e instanceof Error ? e.message : 'Failed to create session')
        }
    }

    const canCreate = Boolean(machineId && trimmedDirectory && !isFormDisabled && !missingWorktreeDirectory)

    return (
        <div className="flex flex-col divide-y divide-[var(--app-divider)]">
            <MachineSelector
                machines={props.machines}
                machineId={machineId}
                isLoading={props.isLoading}
                isDisabled={isFormDisabled}
                onChange={handleMachineChange}
            />
            {runnerSpawnError ? (
                <div className="px-3 py-2 text-xs text-red-600">
                    Runner last spawn error: {runnerSpawnError}
                </div>
            ) : null}
            <DirectorySection
                directory={directory}
                suggestions={suggestions}
                selectedIndex={selectedIndex}
                isDisabled={isFormDisabled}
                recentPaths={recentPaths}
                statusMessage={directoryStatusMessage}
                statusTone={directoryStatusTone}
                onDirectoryChange={handleDirectoryChange}
                onDirectoryFocus={handleDirectoryFocus}
                onDirectoryBlur={handleDirectoryBlur}
                onDirectoryKeyDown={handleDirectoryKeyDown}
                onSuggestionSelect={handleSuggestionSelect}
                onPathClick={handlePathClick}
                onChooseFolder={props.onChooseFolder ? handleChooseFolderClick : undefined}
            />
            <SessionTypeSelector
                sessionType={sessionType}
                worktreeName={worktreeName}
                worktreeInputRef={worktreeInputRef}
                isDisabled={isFormDisabled}
                onSessionTypeChange={setSessionType}
                onWorktreeNameChange={setWorktreeName}
            />
            <AgentSelector
                agent={agent}
                isDisabled={isFormDisabled}
                onAgentChange={setAgent}
            />
            {agent === 'codex' ? (
                <CodexImportSelectButton
                    selectedSession={selectedCodexImportSession}
                    isLoading={isLoadingCodexImportSessions}
                    isDisabled={isFormDisabled}
                    error={codexImportError}
                    onOpen={() => {
                        setIsCodexImportDialogOpen(true)
                        void loadCodexImportSessions()
                    }}
                    onClear={() => setSelectedCodexImportSessionId(null)}
                />
            ) : null}
            {agent === 'opencode' ? (
                <OpencodeModelSelector
                    cwd={deferredDirectory}
                    machineId={machineId}
                    isLoading={opencodeModelsState.isLoading}
                    error={opencodeModelsState.error}
                    availableModels={opencodeModelsState.availableModels}
                    currentModelId={opencodeModelsState.currentModelId}
                    selectedModel={opencodeSelectedModel}
                    onModelChange={setOpencodeSelectedModel}
                    onRetry={opencodeModelsState.refetch}
                />
            ) : (
                agent === 'cursor' ? (
                    <>
                        <ModelSelector
                            agent={agent}
                            model={cursorPicker.mode === 'dual' ? cursorBaseSelectValue : model}
                            options={cursorPicker.modelOptions}
                            isDisabled={cursorModelPickersDisabled}
                            isLoading={cursorModelsState.isLoading}
                            error={cursorModelsState.error
                                ? `${t('newSession.model.loadFailed')}: ${cursorModelsState.error}`
                                : null}
                            onModelChange={(value) => {
                                if (cursorPicker.mode === 'dual') {
                                    handleCursorBaseChange(value)
                                    return
                                }
                                setModel(value)
                                setCursorSelectedBase(
                                    value === 'auto' ? 'auto' : resolveCursorBaseFromWire(value, cursorPicker.catalog)
                                )
                            }}
                        />
                        {showCursorVariantPicker ? (
                            <ModelSelector
                                agent={agent}
                                model={cursorEffortSelectValue}
                                label={t('misc.variant')}
                                options={cursorVariantSelectOptions}
                                isDisabled={cursorModelPickersDisabled}
                                isLoading={cursorModelsState.isLoading}
                                onModelChange={handleCursorEffortChange}
                            />
                        ) : null}
                        {cursorModelsUnavailable ? (
                            <div className="px-3 pb-3 text-xs text-[var(--app-hint)]">
                                {t('newSession.model.cursorUnavailable')}
                            </div>
                        ) : null}
                    </>
                ) : (
                    <ModelSelector
                        agent={agent}
                        model={model}
                        options={
                            agent === 'codex'
                                ? codexModelOptions
                                : agent === 'grok'
                                    ? grokModelOptions
                                : undefined
                        }
                        isDisabled={
                            isFormDisabled
                            || (agent === 'codex' && Boolean(codexModelsState.error))
                            || (agent === 'grok' && Boolean(grokModelsState.error))
                        }
                        isLoading={(agent === 'codex' && codexModelsState.isLoading)
                            || (agent === 'grok' && grokModelsState.isLoading)}
                        error={agent === 'codex' && codexModelsState.error
                            ? `${t('newSession.model.loadFailed')}: ${codexModelsState.error}`
                            : agent === 'grok' && grokModelsState.error
                                ? `${t('newSession.model.loadFailed')}: ${grokModelsState.error}`
                                : null}
                        onModelChange={setModel}
                    />
                )
            )}
            <LaunchEffortSelector
                agent={agent}
                effort={effort}
                isDisabled={isFormDisabled}
                onEffortChange={setEffort}
                grokOptions={agent === 'grok' ? grokEffortOptions : undefined}
            />
            <ReasoningEffortSelector
                agent={agent}
                value={modelReasoningEffort}
                availableOptions={agent === 'codex' ? codexReasoningEffortOptions : undefined}
                isDisabled={isFormDisabled || (agent === 'codex' && codexModelsState.isLoading)}
                onChange={setModelReasoningEffort}
            />
            <GrokPermissionModeSelector
                agent={agent}
                value={grokPermissionMode}
                autoPermissionModeSupported={grokModelsState.autoPermissionModeSupported}
                isDisabled={isFormDisabled}
                onChange={setGrokPermissionMode}
            />
            {agent !== 'grok' ? (
                <YoloToggle
                    yoloMode={yoloMode}
                    isDisabled={isFormDisabled}
                    onToggle={setYoloMode}
                />
            ) : null}

            {(error ?? spawnError) ? (
                <div className="px-3 py-2 text-sm text-red-600">
                    {error ?? spawnError}
                </div>
            ) : null}

            <ActionButtons
                isPending={isPending || isImportingCodexSession}
                canCreate={canCreate}
                isDisabled={isFormDisabled}
                createLabel={createLabel}
                onCancel={props.onCancel}
                onCreate={handleCreate}
            />
            <CodexSessionSyncDialog
                isOpen={isCodexImportDialogOpen}
                onClose={() => setIsCodexImportDialogOpen(false)}
                sessions={codexImportSessions}
                currentCodexSessionId={selectedCodexImportSessionId}
                currentWorkDirectory={trimmedDirectory}
                selectionMode="single"
                onSelectOnly={(session) => {
                    handleSelectCodexImportSession(session)
                    setIsCodexImportDialogOpen(false)
                }}
                onConfirm={async () => {}}
                onRestartCodexDesktop={async () => { await loadCodexImportSessions() }}
                onArchiveSession={handleArchiveCodexImportSession}
                isPending={false}
                isRestartingCodexDesktop={false}
                isLoading={isLoadingCodexImportSessions}
            />
        </div>
    )
}
