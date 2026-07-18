import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ApiClient } from '@/api/client'
import type { Machine, PermissionMode } from '@/types/api'
import { usePlatform } from '@/hooks/usePlatform'
import { useMachinePathsExists } from '@/hooks/useMachinePathsExists'
import { useSpawnSession } from '@/hooks/mutations/useSpawnSession'
import { useSessions } from '@/hooks/queries/useSessions'
import { useActiveSuggestions, type Suggestion } from '@/hooks/useActiveSuggestions'
import { useDirectorySuggestions } from '@/hooks/useDirectorySuggestions'
import { useRecentPaths } from '@/hooks/useRecentPaths'
import { useTranslation } from '@/lib/use-translation'
import {
    MODEL_OPTIONS,
    type AgentType,
    type ClaudeEffort,
    type CodexReasoningEffort,
    type CodexServiceTier,
    type SessionType
} from './types'
import { ActionButtons } from './ActionButtons'
import { AGENT_OPTIONS, AgentSelector } from './AgentSelector'
import { DirectorySection } from './DirectorySection'
import { MachineSelector } from './MachineSelector'
import { ModelSelector } from './ModelSelector'
import { ClaudeEffortSelector } from './ClaudeEffortSelector'
import { ReasoningEffortSelector } from './ReasoningEffortSelector'
import { ServiceTierSelector } from './ServiceTierSelector'
import { PermissionModeSelector } from './PermissionModeSelector'
import {
    loadPreferredAgent,
    loadPreferredYoloMode,
    savePreferredAgent,
    savePreferredYoloMode,
} from './preferences'
import { SessionTypeSelector } from './SessionTypeSelector'
import { YoloToggle } from './YoloToggle'
import { formatRunnerSpawnError } from '../../utils/formatRunnerSpawnError'
import { getDefaultModelForAgent, resolveSpawnModelConfig, resolveSpawnPermissionConfig } from './sessionConfig'
import { isCodexReasoningEffortAllowedForModel } from './types'
import { isCcApiEffortAllowedForModel, isClaudeDeepSeekEffortAllowedForModel } from '@hapi/protocol'
import {
    formatProviderIssue,
    getNewSessionProviderIssue,
    getProviderEfforts,
    getProviderState,
    intersectReportedValues,
    reconcileReportedValue,
    resolveReadyAgent
} from './providerAvailability'
import { guardProviderSelectionAcrossAsyncCheck } from './createProviderGuard'
import { useSubmissionLock } from './useSubmissionLock'

export function NewSession(props: {
    api: ApiClient
    machines: Machine[]
    knownMachinesCount?: number
    offlineMachinesCount?: number
    serverTimeOffsetMs?: number
    isLoading?: boolean
    onSuccess: (sessionId: string) => void
    onCancel: () => void
}) {
    const { haptic } = usePlatform()
    const { t } = useTranslation()
    const { spawnSession, isPending, error: spawnError } = useSpawnSession(props.api)
    const { sessions } = useSessions(props.api)
    const { isLocked: isPreflightPending, run: runWithSubmissionLock } = useSubmissionLock()
    const isFormDisabled = Boolean(isPending || isPreflightPending || props.isLoading)
    const { getRecentPaths, addRecentPath, getLastUsedMachineId, setLastUsedMachineId } = useRecentPaths()

    const [machineId, setMachineId] = useState<string | null>(null)
    const [directory, setDirectory] = useState('')
    const [suppressSuggestions, setSuppressSuggestions] = useState(false)
    const [isDirectoryFocused, setIsDirectoryFocused] = useState(false)
    const [agent, setAgent] = useState<AgentType>(loadPreferredAgent)
    const [model, setModel] = useState('auto')
    const [effort, setEffort] = useState<ClaudeEffort>('auto')
    const [modelReasoningEffort, setModelReasoningEffort] = useState<CodexReasoningEffort>('default')
    const [serviceTier, setServiceTier] = useState<CodexServiceTier>('default')
    const [yoloMode, setYoloMode] = useState(loadPreferredYoloMode)
    const [agentPermissionMode, setAgentPermissionMode] = useState<PermissionMode>('default')
    const [sessionType, setSessionType] = useState<SessionType>('simple')
    const [worktreeName, setWorktreeName] = useState('')
    const [directoryCreationConfirmed, setDirectoryCreationConfirmed] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const serverTimeOffsetMs = props.serverTimeOffsetMs ?? 0
    const [readinessNow, setReadinessNow] = useState(() => Date.now() + serverTimeOffsetMs)
    const worktreeInputRef = useRef<HTMLInputElement>(null)
    const machinesRef = useRef(props.machines)
    const serverTimeOffsetMsRef = useRef(serverTimeOffsetMs)
    machinesRef.current = props.machines
    serverTimeOffsetMsRef.current = serverTimeOffsetMs

    useEffect(() => {
        setReadinessNow(Date.now() + serverTimeOffsetMs)
        const timer = window.setInterval(() => setReadinessNow(Date.now() + serverTimeOffsetMs), 30_000)
        return () => window.clearInterval(timer)
    }, [serverTimeOffsetMs])

    useEffect(() => {
        if (sessionType === 'worktree') {
            worktreeInputRef.current?.focus()
        }
    }, [sessionType])

    useEffect(() => {
        setModel(getDefaultModelForAgent(agent))
        setEffort(agent === 'claude-deepseek' ? 'max' : 'auto')
        setModelReasoningEffort('default')
        setServiceTier('default')
        setAgentPermissionMode('default')
    }, [agent])

    useEffect(() => {
        if (agent === 'cc-api' && !isCcApiEffortAllowedForModel(model, effort)) {
            setEffort('auto')
        }
        if (agent === 'claude-deepseek' && !isClaudeDeepSeekEffortAllowedForModel(model, effort)) {
            setEffort('auto')
        }
    }, [agent, model, effort])

    useEffect(() => {
        if (agent === 'codex' && !isCodexReasoningEffortAllowedForModel(model, modelReasoningEffort)) {
            setModelReasoningEffort('default')
        }
    }, [agent, model, modelReasoningEffort])

    useEffect(() => {
        savePreferredAgent(agent)
    }, [agent])

    useEffect(() => {
        savePreferredYoloMode(yoloMode)
    }, [yoloMode])

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
        () => (machineId ? props.machines.find((machine) => machine.id === machineId) ?? null : null),
        [machineId, props.machines]
    )
    const providerReadiness = selectedMachine?.metadata?.providerReadiness
    const selectedProviderState = useMemo(
        () => getProviderState(providerReadiness, agent, readinessNow),
        [agent, providerReadiness, readinessNow]
    )
    const selectedProviderEntry = selectedProviderState.ready ? selectedProviderState.entry : null
    const allowedModels = useMemo(
        () => intersectReportedValues(
            MODEL_OPTIONS[agent].map((option) => option.value),
            selectedProviderEntry?.models ?? []
        ),
        [agent, selectedProviderEntry]
    )
    const allowedEfforts = useMemo(
        () => getProviderEfforts(selectedProviderEntry, model),
        [model, selectedProviderEntry]
    )
    const allowedModes = useMemo(
        () => selectedProviderEntry?.modes ?? [],
        [selectedProviderEntry]
    )

    useEffect(() => {
        if (!selectedMachine) return
        const resolved = resolveReadyAgent(providerReadiness, agent, readinessNow)
        if (resolved !== agent) setAgent(resolved)
    }, [agent, providerReadiness, readinessNow, selectedMachine])

    useEffect(() => {
        const configuredModels = MODEL_OPTIONS[agent].map((option) => option.value)
        if (!selectedProviderEntry || configuredModels.length === 0) return
        const fallback = allowedModels[0] ?? getDefaultModelForAgent(agent)
        const resolved = reconcileReportedValue(model, allowedModels, fallback)
        if (resolved !== model) setModel(resolved)
    }, [agent, allowedModels, model, selectedProviderEntry])

    useEffect(() => {
        const usesEffort = agent === 'claude' || agent === 'claude-deepseek' || agent === 'claude-ark' || agent === 'cc-api' || agent === 'grok'
        if (!selectedProviderEntry || !usesEffort || allowedEfforts.length === 0) return
        const resolved = reconcileReportedValue(effort, allowedEfforts as ClaudeEffort[], 'auto')
        if (resolved !== effort) setEffort(resolved)
    }, [agent, allowedEfforts, effort, selectedProviderEntry])

    useEffect(() => {
        if (!selectedProviderEntry || agent !== 'codex' || allowedEfforts.length === 0) return
        const resolved = reconcileReportedValue(
            modelReasoningEffort,
            allowedEfforts as CodexReasoningEffort[],
            'default'
        )
        if (resolved !== modelReasoningEffort) setModelReasoningEffort(resolved)
    }, [agent, allowedEfforts, modelReasoningEffort, selectedProviderEntry])

    useEffect(() => {
        const usesSelector = agent === 'agy' || agent === 'grok' || agent === 'hermes-moa'
        if (!selectedProviderEntry || !usesSelector || allowedModes.length === 0) return
        const resolved = reconcileReportedValue(
            agentPermissionMode,
            allowedModes,
            'default'
        )
        if (resolved !== agentPermissionMode) setAgentPermissionMode(resolved)
    }, [agent, agentPermissionMode, allowedModes, selectedProviderEntry])

    const providerSelectionIssue = useMemo(() => {
        const resolvedModel = resolveSpawnModelConfig({ agent, model, effort })
        const usesPermissionSelector = agent === 'agy' || agent === 'grok' || agent === 'hermes-moa'
        return getNewSessionProviderIssue(providerReadiness, agent, {
            model: resolvedModel.model,
            effort: agent === 'codex'
                ? (modelReasoningEffort === 'default' ? undefined : modelReasoningEffort)
                : resolvedModel.effort,
            mode: usesPermissionSelector ? agentPermissionMode : undefined,
            yolo: usesPermissionSelector ? undefined : yoloMode
        }, readinessNow)
    }, [agent, agentPermissionMode, effort, model, modelReasoningEffort, providerReadiness, readinessNow, yoloMode])
    const providerIssueText = useMemo(() => {
        if (!providerSelectionIssue) return null
        const label = AGENT_OPTIONS.find((option) => option.value === agent)?.label ?? agent
        return formatProviderIssue(providerSelectionIssue, label, t)
    }, [agent, providerSelectionIssue, t])
    const providerControlsDisabled = isFormDisabled || !selectedProviderState.ready
    const runnerSpawnError = useMemo(
        () => formatRunnerSpawnError(selectedMachine),
        [selectedMachine]
    )

    const recentPaths = useMemo(
        () => getRecentPaths(machineId),
        [getRecentPaths, machineId]
    )

    const trimmedDirectory = directory.trim()
    const launchSelectionKey = JSON.stringify([
        machineId,
        trimmedDirectory,
        agent,
        model,
        effort,
        modelReasoningEffort,
        serviceTier,
        yoloMode,
        agentPermissionMode,
        sessionType,
        worktreeName.trim(),
    ])
    const launchSelectionKeyRef = useRef(launchSelectionKey)
    launchSelectionKeyRef.current = launchSelectionKey
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
        if (!machineId || !trimmedDirectory) return

        await runWithSubmissionLock(async () => {
            setError(null)
            try {
                const { model: resolvedModel, effort: resolvedEffort } = resolveSpawnModelConfig({ agent, model, effort })
                const resolvedModelReasoningEffort = agent === 'codex' && modelReasoningEffort !== 'default'
                    ? modelReasoningEffort
                    : undefined
                const resolvedServiceTier = agent === 'codex' && serviceTier !== 'default'
                    ? serviceTier
                    : undefined
                const permissionConfig = resolveSpawnPermissionConfig(agent, agentPermissionMode, yoloMode)
                const getLiveProviderIssue = () => {
                    const latestMachine = machinesRef.current.find((machine) => machine.id === machineId)
                    return getNewSessionProviderIssue(
                        latestMachine?.metadata?.providerReadiness,
                        agent,
                        {
                            model: resolvedModel,
                            effort: agent === 'codex' ? resolvedModelReasoningEffort : resolvedEffort,
                            mode: permissionConfig.permissionMode,
                            yolo: permissionConfig.yolo
                        },
                        Date.now() + serverTimeOffsetMsRef.current
                    )
                }
                const guardedPaths = await guardProviderSelectionAcrossAsyncCheck(
                    getLiveProviderIssue,
                    async () => await checkPathsExists([trimmedDirectory]),
                    () => launchSelectionKeyRef.current
                )
                if (!guardedPaths.ok) {
                    haptic.notification('error')
                    if ('issue' in guardedPaths) {
                        const label = AGENT_OPTIONS.find((option) => option.value === agent)?.label ?? agent
                        setError(formatProviderIssue(guardedPaths.issue, label, t))
                    } else {
                        setError(t('session.selectionChangedDuringCreate'))
                    }
                    return
                }
                const existsResult = guardedPaths.value
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

                const result = await spawnSession({
                    machineId,
                    directory: trimmedDirectory,
                    agent,
                    model: resolvedModel,
                    effort: resolvedEffort,
                    modelReasoningEffort: resolvedModelReasoningEffort,
                    serviceTier: resolvedServiceTier,
                    yolo: permissionConfig.yolo,
                    permissionMode: permissionConfig.permissionMode,
                    sessionType,
                    worktreeName: sessionType === 'worktree' ? (worktreeName.trim() || undefined) : undefined
                })

                if (result.type === 'success') {
                    haptic.notification('success')
                    setLastUsedMachineId(machineId)
                    addRecentPath(machineId, trimmedDirectory)
                    props.onSuccess(result.sessionId)
                    return
                }

                haptic.notification('error')
                if (result.code) {
                    const label = AGENT_OPTIONS.find((option) => option.value === agent)?.label ?? agent
                    setError(formatProviderIssue({
                        ok: false,
                        code: result.code,
                        message: result.message,
                        ...(result.recoveryCommand ? { recoveryCommand: result.recoveryCommand } : {})
                    }, label, t))
                } else {
                    setError(result.message)
                }
            } catch (e) {
                haptic.notification('error')
                setError(e instanceof Error ? e.message : 'Failed to create session')
            }
        })
    }

    const canCreate = Boolean(
        machineId
        && trimmedDirectory
        && !isFormDisabled
        && !missingWorktreeDirectory
        && !providerSelectionIssue
    )

    return (
        <div className="flex flex-col divide-y divide-[var(--app-divider)]">
            <MachineSelector
                machines={props.machines}
                knownMachinesCount={props.knownMachinesCount}
                offlineMachinesCount={props.offlineMachinesCount}
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
                providerReadiness={providerReadiness}
                now={readinessNow}
                onAgentChange={setAgent}
            />
            {providerIssueText ? (
                <div className="px-3 py-2 text-xs text-amber-700">
                    {providerIssueText}
                </div>
            ) : null}
            <ModelSelector
                agent={agent}
                model={model}
                isDisabled={providerControlsDisabled}
                allowedModels={allowedModels}
                onModelChange={setModel}
            />
            <ClaudeEffortSelector
                agent={agent}
                model={model}
                effort={effort}
                isDisabled={providerControlsDisabled}
                allowedEfforts={allowedEfforts}
                onEffortChange={setEffort}
            />
            <ReasoningEffortSelector
                agent={agent}
                model={model}
                value={modelReasoningEffort}
                isDisabled={providerControlsDisabled}
                allowedEfforts={allowedEfforts}
                onChange={setModelReasoningEffort}
            />
            <ServiceTierSelector
                agent={agent}
                value={serviceTier}
                isDisabled={isFormDisabled}
                onChange={setServiceTier}
            />
            {agent === 'agy' || agent === 'grok' || agent === 'hermes-moa' ? (
                <PermissionModeSelector
                    agent={agent}
                    mode={agentPermissionMode}
                    isDisabled={providerControlsDisabled}
                    allowedModes={allowedModes}
                    onChange={setAgentPermissionMode}
                />
            ) : (
                <YoloToggle
                    yoloMode={yoloMode}
                    isDisabled={isFormDisabled}
                    onToggle={setYoloMode}
                />
            )}

            {(error ?? spawnError) ? (
                <div className="px-3 py-2 text-sm text-red-600">
                    {error ?? spawnError}
                </div>
            ) : null}

            <ActionButtons
                isPending={isPending || isPreflightPending}
                canCreate={canCreate}
                isDisabled={isFormDisabled}
                createLabel={createLabel}
                onCancel={props.onCancel}
                onCreate={handleCreate}
            />
        </div>
    )
}
