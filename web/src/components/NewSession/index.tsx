import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { usePlatform } from '@/hooks/usePlatform'
import { useMachinePathsExists } from '@/hooks/useMachinePathsExists'
import { useSpawnSession } from '@/hooks/mutations/useSpawnSession'
import { useCodexModels } from '@/hooks/queries/useCodexModels'
import { useOpencodeModelsForCwd } from '@/hooks/queries/useOpencodeModelsForCwd'
import { useSessions } from '@/hooks/queries/useSessions'
import { useActiveSuggestions, type Suggestion } from '@/hooks/useActiveSuggestions'
import { useDirectorySuggestions } from '@/hooks/useDirectorySuggestions'
import { useRecentPaths } from '@/hooks/useRecentPaths'
import { useTranslation, type Locale } from '@/lib/use-translation'
import { agentSupportsYolo, type AgentType, type ClaudeEffort, type CodexReasoningEffort, type SessionType } from './types'
import { ActionButtons } from './ActionButtons'
import { AgentSelector } from './AgentSelector'
import { DirectorySection } from './DirectorySection'
import { MachineSelector } from './MachineSelector'
import { ModelSelector } from './ModelSelector'
import { OpencodeModelSelector } from './OpencodeModelSelector'
import { ClaudeEffortSelector } from './ClaudeEffortSelector'
import { shouldEnableOpencodeModelDiscovery } from './opencodeModelsGate'
import { ReasoningEffortSelector } from './ReasoningEffortSelector'
import {
    loadPreferredAgent,
    loadPreferredYoloMode,
    savePreferredAgent,
    savePreferredYoloMode,
} from './preferences'
import { SessionTypeSelector } from './SessionTypeSelector'
import { YoloToggle } from './YoloToggle'
import { formatRunnerSpawnError } from '../../utils/formatRunnerSpawnError'
import { builtinAgentDescriptors, localizeWebText } from '@hapi/protocol/plugins'
import type { AgentCapabilityProviderSnapshot } from '@hapi/protocol/plugins'
import {
    buildNewSessionPluginFieldPayload,
    collectNewSessionPluginFields,
    newSessionPluginFieldStorageKey,
    validateNewSessionPluginFieldValues,
    type NewSessionPluginField
} from './pluginFields'

type SpawnOptionsPreviewNotice = {
    sources: string[]
    applied: Array<{ key: string; value: string }>
    manual: string[]
}

type TranslationFn = (key: string, params?: Record<string, string | number>) => string

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
    const { t, locale } = useTranslation()
    const { spawnSession, isPending, error: spawnError } = useSpawnSession(props.api)
    const { sessions } = useSessions(props.api)
    const isFormDisabled = Boolean(isPending || props.isLoading)
    const { getRecentPaths, addRecentPath, getLastUsedMachineId, setLastUsedMachineId } = useRecentPaths()

    const [machineId, setMachineId] = useState<string | null>(props.initialMachineId ?? null)
    const [directory, setDirectory] = useState(props.initialDirectory ?? '')
    const [suppressSuggestions, setSuppressSuggestions] = useState(false)
    const [isDirectoryFocused, setIsDirectoryFocused] = useState(false)
    const [agent, setAgent] = useState<AgentType>(loadPreferredAgent)
    const [model, setModel] = useState('auto')
    const [effort, setEffort] = useState<ClaudeEffort>('auto')
    const [modelReasoningEffort, setModelReasoningEffort] = useState<CodexReasoningEffort>('default')
    const [yoloMode, setYoloMode] = useState(loadPreferredYoloMode)
    const [permissionMode, setPermissionMode] = useState<string | undefined>(undefined)
    const [manualSpawnFields, setManualSpawnFields] = useState<string[]>([])
    const [spawnOptionsPreviewNotice, setSpawnOptionsPreviewNotice] = useState<SpawnOptionsPreviewNotice | null>(null)
    const [sessionType, setSessionType] = useState<SessionType>('simple')
    const [worktreeName, setWorktreeName] = useState('')
    const [pluginFieldValues, setPluginFieldValues] = useState<Record<string, unknown>>({})
    const [directoryCreationConfirmed, setDirectoryCreationConfirmed] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const worktreeInputRef = useRef<HTMLInputElement>(null)
    const yoloModeFromPresetRef = useRef(false)

    useEffect(() => {
        if (sessionType === 'worktree') {
            worktreeInputRef.current?.focus()
        }
    }, [sessionType])

    const markSpawnFieldManual = useCallback((field: string) => {
        setManualSpawnFields((current) => current.includes(field) ? current : [...current, field])
    }, [])

    useEffect(() => {
        setModel('auto')
        setEffort('auto')
        setModelReasoningEffort('default')
        setPermissionMode(undefined)
        setManualSpawnFields([])
    }, [agent])

    useEffect(() => {
        savePreferredAgent(agent)
    }, [agent])

    useEffect(() => {
        if (yoloModeFromPresetRef.current) {
            yoloModeFromPresetRef.current = false
            return
        }
        savePreferredYoloMode(yoloMode)
    }, [yoloMode])

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
    const agentDescriptors = useMemo(() => {
        const descriptors = selectedMachine?.runnerState?.agentDescriptors
        return descriptors && descriptors.length > 0 ? descriptors : builtinAgentDescriptors()
    }, [selectedMachine])
    const selectedAgentDescriptor = useMemo(
        () => agentDescriptors.find((descriptor) => descriptor.id === agent) ?? null,
        [agentDescriptors, agent]
    )
    const selectedAgentCapabilities = useMemo(
        () => (selectedMachine?.runnerState?.agentCapabilities ?? []).filter((snapshot) => snapshot.agentId === agent),
        [agent, selectedMachine]
    )
    const selectedAgentSupportsYolo = agentSupportsYolo(selectedAgentDescriptor)
    const newSessionPluginFields = useMemo(
        () => collectNewSessionPluginFields(selectedMachine?.runnerState?.pluginInventory?.webContributions, agent),
        [agent, selectedMachine]
    )
    const newSessionPluginFieldErrors = useMemo(
        () => validateNewSessionPluginFieldValues(newSessionPluginFields, pluginFieldValues, locale),
        [newSessionPluginFields, pluginFieldValues, locale]
    )
    const newSessionPluginFieldPayload = useMemo(
        () => buildNewSessionPluginFieldPayload(newSessionPluginFields, pluginFieldValues),
        [newSessionPluginFields, pluginFieldValues]
    )
    const spawnPluginFields = useMemo(
        () => newSessionPluginFieldPayload,
        [newSessionPluginFieldPayload]
    )
    useEffect(() => {
        if (agentDescriptors.some((descriptor) => descriptor.id === agent && descriptor.available !== false)) {
            return
        }
        const fallback = agentDescriptors.find((descriptor) => descriptor.available !== false)?.id ?? 'claude'
        setAgent(fallback)
    }, [agent, agentDescriptors])
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
    const descriptorModelOptions = useMemo(() => {
        const descriptorModels = selectedAgentDescriptor?.capabilities.models ?? []
        if (descriptorModels.length === 0) {
            return undefined
        }
        const options = [
            { value: 'auto', label: 'Default' },
            ...descriptorModels.map((modelId) => ({ value: modelId, label: modelId }))
        ]
        if (model !== 'auto' && !options.some((option) => option.value === model)) {
            options.splice(1, 0, { value: model, label: model })
        }
        return options
    }, [model, selectedAgentDescriptor])
    const providerModelOptions = useMemo(() => {
        const models = selectedAgentCapabilities.flatMap((snapshot) => snapshot.capabilities.models ?? [])
        if (models.length === 0) {
            return undefined
        }
        const options = [{ value: 'auto', label: 'Default' }]
        const seen = new Set(['auto'])
        for (const providerModel of models) {
            if (seen.has(providerModel.id)) continue
            seen.add(providerModel.id)
            options.push({
                value: providerModel.id,
                label: providerModel.displayName ?? providerModel.id
            })
        }
        if (model !== 'auto' && !seen.has(model)) {
            options.splice(1, 0, { value: model, label: model })
        }
        return options
    }, [model, selectedAgentCapabilities])

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
    useEffect(() => {
        if (!props.api || !machineId || !deferredDirectory) {
            setSpawnOptionsPreviewNotice(null)
            return
        }
        let cancelled = false
        const manual = new Set(manualSpawnFields)
        void props.api.previewRunnerSpawnOptions(machineId, {
            directory: deferredDirectory,
            agent,
            model: manual.has('model')
                ? agent === 'opencode'
                    ? (opencodeSelectedModel ?? undefined)
                    : (model !== 'auto' ? model : undefined)
                : undefined,
            effort: manual.has('effort') && effort !== 'auto' ? effort : undefined,
            modelReasoningEffort: manual.has('modelReasoningEffort') && modelReasoningEffort !== 'default' ? modelReasoningEffort : undefined,
            permissionMode: manual.has('permissionMode') ? permissionMode : undefined,
            yolo: manual.has('yolo') || manual.has('permissionMode') ? yoloMode : undefined,
            manualFields: manualSpawnFields,
            sessionType,
            pluginFields: spawnPluginFields
        }).then((result) => {
            if (cancelled) return
            const options = result.options ?? {}
            if (options.model && !manual.has('model')) {
                if (agent === 'opencode') {
                    setOpencodeSelectedModel(options.model)
                } else {
                    setModel(options.model)
                }
            }
            if (options.effort && !manual.has('effort')) {
                setEffort(options.effort as ClaudeEffort)
            }
            if (options.modelReasoningEffort && !manual.has('modelReasoningEffort')) {
                setModelReasoningEffort(options.modelReasoningEffort as CodexReasoningEffort)
            }
            if (options.permissionMode && !manual.has('permissionMode')) {
                setPermissionMode(options.permissionMode)
                yoloModeFromPresetRef.current = true
                setYoloMode(options.permissionMode === 'yolo' || options.permissionMode === 'bypassPermissions')
            }
            if (typeof options.yolo === 'boolean' && !manual.has('yolo') && !manual.has('permissionMode')) {
                yoloModeFromPresetRef.current = true
                setYoloMode(options.yolo)
            }
            const sources = result.applied.map((entry) => entry.label ?? `${entry.pluginId}:${entry.contributionId}`)
            const applied = Object.entries(options)
                .filter(([, value]) => value !== undefined)
                .map(([key, value]) => ({ key, value: String(value) }))
            setSpawnOptionsPreviewNotice(sources.length > 0 ? {
                sources,
                applied,
                manual: manualSpawnFields
            } : null)
        }).catch(() => {
            if (!cancelled) setSpawnOptionsPreviewNotice(null)
        })
        return () => {
            cancelled = true
        }
    }, [
        props.api,
        machineId,
        deferredDirectory,
        agent,
        model,
        opencodeSelectedModel,
        effort,
        modelReasoningEffort,
        permissionMode,
        yoloMode,
        sessionType,
        manualSpawnFields,
        spawnPluginFields
    ])
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

    const handleMachineChange = useCallback((newMachineId: string) => {
        setMachineId(newMachineId)
        setManualSpawnFields([])
        setPermissionMode(undefined)
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

    const chooseFolderCallback = props.onChooseFolder
    const workspaceRootsAvailable = Boolean(selectedMachine?.metadata?.workspaceRoots?.length)
    const handleChooseFolder = useMemo(() => {
        if (!chooseFolderCallback || !workspaceRootsAvailable) return undefined
        return () => chooseFolderCallback({ machineId, directory: trimmedDirectory })
    }, [chooseFolderCallback, workspaceRootsAvailable, machineId, trimmedDirectory])

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

            const resolvedModel = agent === 'opencode'
                ? (opencodeSelectedModel ?? undefined)
                : (model !== 'auto' ? model : undefined)
            const resolvedEffort = agent === 'claude' && effort !== 'auto' ? effort : undefined
            const resolvedModelReasoningEffort = agent === 'codex' && modelReasoningEffort !== 'default'
                ? modelReasoningEffort
                : undefined
            const resolvedYolo = selectedAgentSupportsYolo
                ? permissionMode
                    ? permissionMode === 'yolo' || permissionMode === 'bypassPermissions'
                    : yoloMode
                : false
            const result = await spawnSession({
                machineId,
                directory: trimmedDirectory,
                agent,
                model: resolvedModel,
                effort: resolvedEffort,
                modelReasoningEffort: resolvedModelReasoningEffort,
                permissionMode,
                yolo: resolvedYolo,
                manualFields: manualSpawnFields,
                sessionType,
                worktreeName: sessionType === 'worktree' ? (worktreeName.trim() || undefined) : undefined,
                pluginFields: spawnPluginFields
            })

            if (result.type === 'success') {
                haptic.notification('success')
                setLastUsedMachineId(machineId)
                addRecentPath(machineId, trimmedDirectory)
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

    const canCreate = Boolean(machineId && trimmedDirectory && !isFormDisabled && !missingWorktreeDirectory && newSessionPluginFieldErrors.length === 0)

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
            {spawnOptionsPreviewNotice ? (
                <SpawnOptionsPreviewNoticeCard notice={spawnOptionsPreviewNotice} t={t} />
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
                onChooseFolder={handleChooseFolder}
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
                agents={agentDescriptors}
                isDisabled={isFormDisabled}
                onAgentChange={(nextAgent) => {
                    setManualSpawnFields([])
                    setPermissionMode(undefined)
                    setAgent(nextAgent)
                }}
            />
            <AgentCapabilitiesSummary
                api={props.api}
                machineId={machineId}
                agentId={agent}
                snapshots={selectedAgentCapabilities}
                t={t}
            />
            <NewSessionPluginFields
                fields={newSessionPluginFields}
                values={pluginFieldValues}
                errors={newSessionPluginFieldErrors}
                isDisabled={isFormDisabled}
                locale={locale}
                t={t}
                onChange={(key, value) => setPluginFieldValues((current) => ({ ...current, [key]: value }))}
            />
            {agent === 'opencode' ? (
                <OpencodeModelSelector
                    cwd={deferredDirectory}
                    machineId={machineId}
                    isLoading={opencodeModelsState.isLoading}
                    error={opencodeModelsState.error}
                    availableModels={opencodeModelsState.availableModels}
                    currentModelId={opencodeModelsState.currentModelId}
                    selectedModel={opencodeSelectedModel}
                    onModelChange={(value) => {
                        markSpawnFieldManual('model')
                        setOpencodeSelectedModel(value)
                    }}
                    onRetry={opencodeModelsState.refetch}
                />
            ) : (
                <ModelSelector
                    agent={agent}
                    model={model}
                    options={agent === 'codex' ? codexModelOptions : providerModelOptions ?? descriptorModelOptions}
                    isDisabled={isFormDisabled || (agent === 'codex' && Boolean(codexModelsState.error))}
                    isLoading={agent === 'codex' && codexModelsState.isLoading}
                    error={agent === 'codex' && codexModelsState.error
                        ? `${t('newSession.model.loadFailed')}: ${codexModelsState.error}`
                        : null}
                    onModelChange={(value) => {
                        markSpawnFieldManual('model')
                        setModel(value)
                    }}
                />
            )}
            <ClaudeEffortSelector
                agent={agent}
                effort={effort}
                isDisabled={isFormDisabled}
                onEffortChange={(value) => {
                    markSpawnFieldManual('effort')
                    setEffort(value)
                }}
            />
            <ReasoningEffortSelector
                agent={agent}
                value={modelReasoningEffort}
                isDisabled={isFormDisabled}
                onChange={(value) => {
                    markSpawnFieldManual('modelReasoningEffort')
                    setModelReasoningEffort(value)
                }}
            />
            <YoloToggle
                yoloMode={yoloMode}
                isDisabled={isFormDisabled || !selectedAgentSupportsYolo}
                onToggle={(value) => {
                    markSpawnFieldManual('permissionMode')
                    markSpawnFieldManual('yolo')
                    setPermissionMode(undefined)
                    setYoloMode(value)
                }}
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
                createLabel={createLabel}
                onCancel={props.onCancel}
                onCreate={handleCreate}
            />
        </div>
    )
}

function spawnOptionFieldLabel(field: string, t: TranslationFn): string {
    if (field === 'model') return t('newSession.pluginDefaults.field.model')
    if (field === 'effort') return t('newSession.pluginDefaults.field.effort')
    if (field === 'modelReasoningEffort') return t('newSession.pluginDefaults.field.reasoning')
    if (field === 'permissionMode' || field === 'yolo') return t('newSession.pluginDefaults.field.permission')
    return field
}

function SpawnOptionsPreviewNoticeCard(props: { notice: SpawnOptionsPreviewNotice; t: TranslationFn }) {
    const applied = props.notice.applied
    const manual = Array.from(new Set(props.notice.manual.map((field) => spawnOptionFieldLabel(field, props.t))))
    return (
        <div className="px-3 py-2">
            <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2 text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded-full bg-[var(--app-bg)] px-2 py-0.5 font-medium text-[var(--app-link)]">{props.t('newSession.pluginDefaults.title')}</span>
                    <span className="min-w-0 break-words text-[var(--app-fg)]">{props.notice.sources.join(', ')}</span>
                </div>
                {applied.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                        {applied.map((entry) => (
                            <span key={`${entry.key}-${entry.value}`} className="rounded-full bg-[var(--app-bg)] px-2 py-0.5 text-[var(--app-fg)]">
                                {spawnOptionFieldLabel(entry.key, props.t)}={entry.value}
                            </span>
                        ))}
                    </div>
                ) : (
                    <div className="mt-1 text-[var(--app-hint)]">{props.t('newSession.pluginDefaults.noNewDefaults')}</div>
                )}
                {manual.length > 0 ? <div className="mt-1 text-[var(--app-hint)]">{props.t('newSession.pluginDefaults.manualOverride', { fields: manual.join(', ') })}</div> : null}
            </div>
        </div>
    )
}

function NewSessionPluginFields(props: {
    fields: NewSessionPluginField[]
    values: Record<string, unknown>
    errors: Array<{ key: string; message: string }>
    isDisabled: boolean
    locale: Locale
    t: TranslationFn
    onChange: (key: string, value: unknown) => void
}) {
    if (props.fields.length === 0) {
        return null
    }
    const errorByKey = new Map(props.errors.map((error) => [error.key, error.message]))
    return (
        <div className="space-y-3 px-3 py-3">
            <div>
                <div className="text-xs font-medium text-[var(--app-hint)]">{props.t('newSession.pluginFields.title')}</div>
                <div className="mt-1 text-xs text-[var(--app-hint)]">{props.t('newSession.pluginFields.description')}</div>
            </div>
            {props.fields.map((field) => {
                const key = newSessionPluginFieldStorageKey(field)
                const value = props.values[key] ?? field.defaultValue ?? (field.type === 'boolean' ? false : '')
                const label = localizeWebText(field.label, props.locale)
                const description = field.description ? localizeWebText(field.description, props.locale) : ''
                const error = errorByKey.get(key)
                return (
                    <label key={`${field.pluginId}-${field.id}`} className="block space-y-1 text-sm">
                        <span className="font-medium">{label}{field.required ? ' *' : ''}</span>
                        <span className="ml-1 text-xs text-[var(--app-hint)]">{field.pluginName ?? field.pluginId}</span>
                        {description ? <span className="block text-xs text-[var(--app-hint)]">{description}</span> : null}
                        {field.type === 'boolean' ? (
                            <input
                                type="checkbox"
                                checked={value === true}
                                disabled={props.isDisabled}
                                onChange={(event) => props.onChange(key, event.target.checked)}
                                className="accent-[var(--app-link)]"
                            />
                        ) : field.type === 'select' ? (
                            <select
                                value={typeof value === 'string' ? value : ''}
                                disabled={props.isDisabled}
                                onChange={(event) => props.onChange(key, event.target.value)}
                                className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)]"
                            >
                                <option value="">{props.t('newSession.pluginFields.selectPlaceholder')}</option>
                                {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label ? localizeWebText(option.label, props.locale) : option.value}</option>)}
                            </select>
                        ) : (
                            <input
                                type={field.type === 'number' ? 'number' : 'text'}
                                value={typeof value === 'string' || typeof value === 'number' ? value : ''}
                                disabled={props.isDisabled}
                                onChange={(event) => props.onChange(key, event.target.value)}
                                className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)]"
                            />
                        )}
                        {error ? <span className="block text-xs text-red-600">{error}</span> : null}
                    </label>
                )
            })}
        </div>
    )
}

function AgentCapabilitiesSummary(props: {
    api: ApiClient
    machineId: string | null
    agentId: string
    snapshots: AgentCapabilityProviderSnapshot[]
    t: TranslationFn
}) {
    const [importResult, setImportResult] = useState<{
        nativeSessionId: string
        message: string
        error?: boolean
    } | null>(null)
    const models = props.snapshots.flatMap((snapshot) => snapshot.capabilities.models ?? [])
    const permissionModes = props.snapshots.flatMap((snapshot) => snapshot.capabilities.permissionModes ?? [])
    const profiles = props.snapshots.flatMap((snapshot) => snapshot.capabilities.profiles ?? [])
    const sessions = props.snapshots.flatMap((snapshot) => snapshot.capabilities.sessions ?? [])
    const usage = props.snapshots.flatMap((snapshot) => snapshot.capabilities.usage ?? [])
    const skills = props.snapshots.flatMap((snapshot) => snapshot.capabilities.skills ?? [])
    const slashCommands = props.snapshots.flatMap((snapshot) => snapshot.capabilities.slashCommands ?? [])
    const diagnostics = props.snapshots.flatMap((snapshot) => snapshot.diagnostics)
    const [pendingImportId, setPendingImportId] = useState<string | null>(null)

    const handleImportHistory = async (snapshot: AgentCapabilityProviderSnapshot, nativeSessionId: string) => {
        if (!props.machineId) {
            return
        }
        setPendingImportId(nativeSessionId)
        setImportResult(null)
        try {
            const result = await props.api.importAgentHistory(
                props.machineId,
                props.agentId,
                nativeSessionId,
                snapshot.contributionId
            )
            setImportResult({
                nativeSessionId,
                message: props.t('newSession.agentCapabilities.imported', { count: result.messages.length })
            })
        } catch (error) {
            setImportResult({
                nativeSessionId,
                message: error instanceof Error ? error.message : props.t('newSession.agentCapabilities.importFailed'),
                error: true
            })
        } finally {
            setPendingImportId(null)
        }
    }

    const hasContent = models.length > 0
        || permissionModes.length > 0
        || profiles.length > 0
        || sessions.length > 0
        || usage.length > 0
        || skills.length > 0
        || slashCommands.length > 0
        || diagnostics.length > 0
    if (!hasContent) {
        return null
    }

    const uniqueLabels = (values: string[]) => Array.from(new Set(values)).slice(0, 6)
    const usageLabels = usage.slice(0, 3).map((entry) => {
        const parts = [
            entry.totalTokens !== undefined ? `${entry.totalTokens} tokens` : null,
            entry.costUsd !== undefined ? `$${entry.costUsd.toFixed(4)}` : null,
            entry.limitLabel ?? null
        ].filter(Boolean)
        return parts.join(' · ') || entry.scope
    })

    return (
        <div className="flex flex-col gap-2 px-3 py-3 text-xs text-[var(--app-hint)]">
            <div className="font-medium text-[var(--app-text)]">{props.t('newSession.agentCapabilities.title')}</div>
            <div className="flex flex-wrap gap-1.5">
                {uniqueLabels(models.map((entry) => entry.displayName ?? entry.id)).map((label) => (
                    <span key={`model-${label}`} className="rounded-full bg-[var(--app-secondary-bg)] px-2 py-1">{props.t('newSession.agentCapabilities.modelPrefix')}: {label}</span>
                ))}
                {uniqueLabels(permissionModes.map((entry) => entry.label ?? entry.mode)).map((label) => (
                    <span key={`permission-${label}`} className="rounded-full bg-[var(--app-secondary-bg)] px-2 py-1">{props.t('newSession.agentCapabilities.permissionPrefix')}: {label}</span>
                ))}
                {uniqueLabels(profiles.map((entry) => entry.displayName)).map((label) => (
                    <span key={`profile-${label}`} className="rounded-full bg-[var(--app-secondary-bg)] px-2 py-1">{props.t('newSession.agentCapabilities.profilePrefix')}: {label}</span>
                ))}
                {uniqueLabels(skills.map((entry) => entry.name)).map((label) => (
                    <span key={`skill-${label}`} className="rounded-full bg-[var(--app-secondary-bg)] px-2 py-1">{props.t('newSession.agentCapabilities.skillPrefix')}: {label}</span>
                ))}
                {uniqueLabels(slashCommands.map((entry) => entry.name)).map((label) => (
                    <span key={`slash-${label}`} className="rounded-full bg-[var(--app-secondary-bg)] px-2 py-1">/{label}</span>
                ))}
            </div>
            {sessions.length > 0 ? (
                <div className="space-y-1">
                    <div className="font-medium text-[var(--app-text)]">{props.t('newSession.agentCapabilities.nativeHistory')}</div>
                    {props.snapshots.flatMap((snapshot) =>
                        (snapshot.capabilities.sessions ?? []).slice(0, 3).map((session) => (
                            <div key={`${snapshot.contributionId}-${session.id}`} className="flex items-center justify-between gap-2 rounded-lg bg-[var(--app-secondary-bg)] px-2 py-1">
                                <span className="min-w-0 truncate">
                                    {session.title ?? session.id}{session.cwd ? ` · ${session.cwd}` : ''}
                                </span>
                                {session.importable !== false ? (
                                    <button
                                        type="button"
                                        className="shrink-0 text-[var(--app-link)] disabled:opacity-50"
                                        disabled={!props.machineId || pendingImportId === session.id}
                                        onClick={() => { void handleImportHistory(snapshot, session.id) }}
                                    >
                                        {pendingImportId === session.id ? props.t('newSession.agentCapabilities.importing') : props.t('newSession.agentCapabilities.import')}
                                    </button>
                                ) : null}
                            </div>
                        ))
                    )}
                    {importResult ? (
                        <div className={`rounded-lg px-2 py-1 ${importResult.error ? 'bg-red-50 text-red-600' : 'bg-[var(--app-secondary-bg)] text-[var(--app-text)]'}`}>
                            {importResult.message}
                        </div>
                    ) : null}
                </div>
            ) : null}
            {usageLabels.length > 0 ? (
                <div className="space-y-1">
                    <div className="font-medium text-[var(--app-text)]">{props.t('newSession.agentCapabilities.usage')}</div>
                    {usageLabels.map((label, index) => (
                        <div key={`${label}-${index}`} className="truncate rounded-lg bg-[var(--app-secondary-bg)] px-2 py-1">{label}</div>
                    ))}
                </div>
            ) : null}
            {diagnostics.length > 0 ? (
                <div className="space-y-1">
                    {diagnostics.slice(0, 3).map((diagnostic, index) => (
                        <div key={`${diagnostic.code}-${index}`} className="rounded-lg bg-[var(--app-secondary-bg)] px-2 py-1 text-amber-600">
                            {diagnostic.code}: {diagnostic.message}
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    )
}
