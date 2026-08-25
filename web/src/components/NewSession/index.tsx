import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ApiClient } from '@/api/client'
import type { CodexDuplicateSessionGroup, CodexLocalSessionSummary, Machine, PiLocalSessionSummary } from '@/types/api'
import type { CodexCollaborationMode, GrokPermissionMode, PermissionMode, CopilotAgentMode } from '@hapi/protocol'
import { codexModelAdvertisesFastTier } from '@/components/AssistantChat/codexFastMode'
import { usePlatform } from '@/hooks/usePlatform'
import { useMachinePathsExists } from '@/hooks/useMachinePathsExists'
import { useSpawnSession } from '@/hooks/mutations/useSpawnSession'
import { useCodexModels } from '@/hooks/queries/useCodexModels'
import { useCursorModelsForMachine } from '@/hooks/queries/useCursorModelsForMachine'
import { useAgyModels } from '@/hooks/queries/useAgyModels'
import { useOpencodeModelsForCwd } from '@/hooks/queries/useOpencodeModelsForCwd'
import { useGrokModelsForCwd } from '@/hooks/queries/useGrokModelsForCwd'
import { useCopilotModelsForCwd } from '@/hooks/queries/useCopilotModelsForCwd'
import { usePiModelsForMachine } from '@/hooks/queries/usePiModelsForMachine'
import { useAgentAvailability } from '@/hooks/queries/useAgentAvailability'
import { useSessions } from '@/hooks/queries/useSessions'
import { useActiveSuggestions, type Suggestion } from '@/hooks/useActiveSuggestions'
import { useDirectorySuggestions } from '@/hooks/useDirectorySuggestions'
import { useRecentPaths } from '@/hooks/useRecentPaths'
import { useTranslation } from '@/lib/use-translation'
import { getCodexModelReasoningEfforts } from '@/lib/codexModelCapabilities'
import {
    buildNewSessionCursorModelCatalog,
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
import type { AgentType, LaunchEffort, CodexReasoningEffort, NewSessionServiceTier, SessionType } from './types'
import { ActionButtons } from './ActionButtons'
import { AgentSelector } from './AgentSelector'
import { CollaborationModeSelector } from './CollaborationModeSelector'
import { CodexImportActions } from './CodexImportActions'
import { PiImportActions } from './PiImportActions'
import { clearBatchImportedCodexSelection, resolveCodexImportRedirectSessionId } from './codexImportMerge'
import { AgyModelSelector } from './AgyModelSelector'
import { DirectorySection } from './DirectorySection'
import { CopilotAgentModeSelector } from './CopilotAgentModeSelector'
import { FastModeSelector } from './FastModeSelector'
import { MachineSelector } from './MachineSelector'
import { ModelSelector } from './ModelSelector'
import { OpencodeModelSelector } from './OpencodeModelSelector'
import { EffortField } from './EffortField'
import { shouldEnableOpencodeModelDiscovery } from './opencodeModelsGate'
import { buildGrokEffortOptions, buildGrokModelOptions, shouldEnableGrokModelDiscovery } from './grokModels'
import { groupModelsByProvider } from '@/components/AssistantChat/piModelGroups'
import { isThinkingLevelSupported } from '@/components/AssistantChat/piThinkingLevelOptions'
import {
    loadPreferredAgent,
    loadPreferredLaunchSettings,
    loadPreferredYoloMode,
    resolvePreferredLaunchSettings,
    savePreferredAgent,
    savePreferredLaunchSettings,
    savePreferredYoloMode,
} from './preferences'
import { SessionTypeSelector } from './SessionTypeSelector'
import { PermissionField } from './PermissionField'
import { usesCodexFamilyPermissionModes } from '@/lib/codexFamilyPermissionAgents'
import { CodexSessionSyncDialog } from '@/components/CodexSessionSyncDialog'
import { PiSessionImportDialog } from '@/components/PiSessionImportDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { formatRunnerSpawnError } from '../../utils/formatRunnerSpawnError'
import { markCodexSessionsImported } from '@/lib/codexImportedSessions'
import { useToast } from '@/lib/toast-context'




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
    const { addToast } = useToast()
    const { spawnSession, isPending, error: spawnError } = useSpawnSession(props.api)
    const { sessions, refetch: refetchSessions } = useSessions(props.api)
    const { getRecentPaths, addRecentPath, getLastUsedMachineId, setLastUsedMachineId } = useRecentPaths()

    const [machineId, setMachineId] = useState<string | null>(props.initialMachineId ?? null)
    const [directory, setDirectory] = useState(props.initialDirectory ?? '')
    const [suppressSuggestions, setSuppressSuggestions] = useState(false)
    const [isDirectoryFocused, setIsDirectoryFocused] = useState(false)
    const [agent, setAgent] = useState<AgentType>(loadPreferredAgent)
    const [legacyCodexYolo] = useState(
        () => loadPreferredAgent() === 'codex' && loadPreferredYoloMode()
    )
    const [model, setModel] = useState('auto')
    const [cursorSelectedBase, setCursorSelectedBase] = useState('auto')
    const pendingCursorBaseRef = useRef<string | null>(null)
    const [effort, setEffort] = useState<LaunchEffort>('auto')
    const [modelReasoningEffort, setModelReasoningEffort] = useState<CodexReasoningEffort>('default')
    const [opencodeSelectedModel, setOpencodeSelectedModel] = useState<string | null | undefined>(undefined)
    const [serviceTier, setServiceTier] = useState<NewSessionServiceTier>('standard')
    const [collaborationMode, setCollaborationMode] = useState<CodexCollaborationMode>('default')
    const [copilotAgentMode, setCopilotAgentMode] = useState<CopilotAgentMode>('interactive')
    const [yoloMode, setYoloMode] = useState(loadPreferredYoloMode)
    const [codexFamilyPermissionMode, setCodexFamilyPermissionMode] = useState<PermissionMode>('default')
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
    const [piImportSessions, setPiImportSessions] = useState<PiLocalSessionSummary[]>([])
    const [selectedPiImportSessionId, setSelectedPiImportSessionId] = useState<string | null>(null)
    const [piImportMachineId, setPiImportMachineId] = useState<string | null>(null)
    const [isLoadingPiImportSessions, setIsLoadingPiImportSessions] = useState(false)
    const [piImportError, setPiImportError] = useState<string | null>(null)
    const [isImportingPiSession, setIsImportingPiSession] = useState(false)
    const [isBulkImportingPiSessions, setIsBulkImportingPiSessions] = useState(false)
    const [isPiImportDialogOpen, setIsPiImportDialogOpen] = useState(false)
    const piLoadGenerationRef = useRef(0)
    const [isCreating, setIsCreating] = useState(false)
    const createInFlightRef = useRef(false)
    const [isBulkImportingCodexSessions, setIsBulkImportingCodexSessions] = useState(false)
    const [isRestartingCodexDesktop, setIsRestartingCodexDesktop] = useState(false)
    const [pendingDuplicateSessionIds, setPendingDuplicateSessionIds] = useState<string[]>([])
    const [pendingDuplicateHapiSessionIds, setPendingDuplicateHapiSessionIds] = useState<string[]>([])
    const [duplicateSessionGroups, setDuplicateSessionGroups] = useState<CodexDuplicateSessionGroup[]>([])
    const [isDuplicateMergeConfirmOpen, setIsDuplicateMergeConfirmOpen] = useState(false)
    const [isMergingDuplicateSessions, setIsMergingDuplicateSessions] = useState(false)
    const isFormDisabled = Boolean(
        isCreating
        || isPending
        || props.isLoading
        || isImportingCodexSession
        || isBulkImportingCodexSessions
        || isImportingPiSession
        || isBulkImportingPiSessions
    )
    const worktreeInputRef = useRef<HTMLInputElement>(null)
    const preserveRestoredDraftRef = useRef(false)

    useEffect(() => {
        if (sessionType === 'worktree') {
            worktreeInputRef.current?.focus()
        }
    }, [sessionType])

    useEffect(() => {
        if (preserveRestoredDraftRef.current) {
            return
        }
        setEffort('auto')
        setModelReasoningEffort('default')
        setGrokPermissionMode('default')
        setCodexFamilyPermissionMode('default')
        setServiceTier('standard')
        setCollaborationMode('default')
        setCopilotAgentMode('interactive')
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
        preserveRestoredDraftRef.current = true
        setAgent(draft.agent)
        setModel(draft.model)
        setCursorSelectedBase(draft.cursorSelectedBase)
        setEffort(draft.effort)
        setModelReasoningEffort(draft.modelReasoningEffort)
        setOpencodeSelectedModel(
            draft.agent === 'opencode' && draft.model !== 'auto' ? draft.model : null
        )
        setAgySelectedModel(
            draft.agent === 'agy' && draft.model !== 'auto' ? draft.model : null
        )
        setServiceTier(draft.serviceTier)
        setCollaborationMode(draft.collaborationMode)
        setCopilotAgentMode(draft.copilotAgentMode)
        setYoloMode(draft.yoloMode)
        setCodexFamilyPermissionMode(draft.codexFamilyPermissionMode)
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
    const agentAvailability = useAgentAvailability({
        api: props.api,
        machineId,
    })
    const availableAgents = useMemo(
        () => agentAvailability.agents
            .filter((entry) => entry.available && entry.agent !== 'gemini')
            .map((entry) => entry.agent as AgentType),
        [agentAvailability.agents]
    )
    const selectedAgentAvailable = availableAgents.includes(agent)

    useEffect(() => {
        if (agentAvailability.isLoading || agentAvailability.error || availableAgents.length === 0) return
        if (availableAgents.includes(agent)) return
        preserveRestoredDraftRef.current = false
        setAgent(availableAgents[0]!)
    }, [agent, agentAvailability.error, agentAvailability.isLoading, availableAgents])
    const codexModelsState = useCodexModels({
        api: props.api,
        machineId,
        enabled: agent === 'codex' && Boolean(machineId)
    })
    const [agySelectedModel, setAgySelectedModel] = useState<string | null>(null)
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

    useEffect(() => {
        if (
            agent !== 'codex'
            || model === 'auto'
            || codexModelsState.isLoading
            || codexModelsState.error
        ) {
            return
        }
        if (!codexModelsState.models.some((candidate) => candidate.id === model)) {
            setModel('auto')
        }
    }, [agent, codexModelsState.error, codexModelsState.isLoading, codexModelsState.models, model])
    const showCodexFastMode = agent === 'codex'
        && !codexModelsState.error
        && codexModelAdvertisesFastTier(model === 'auto' ? null : model, codexModelsState.models)

    useEffect(() => {
        // Wait for the Codex model catalog to settle before clearing Fast;
        // otherwise Browse → remount restores serviceTier: 'fast' and this
        // effect would wipe it while models are still loading.
        if (agent === 'codex' && codexModelsState.isLoading) {
            return
        }
        if (!showCodexFastMode && serviceTier !== 'standard') {
            setServiceTier('standard')
        }
    }, [agent, codexModelsState.isLoading, showCodexFastMode, serviceTier])
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
    const availableCursorCatalog = useMemo(
        () => buildNewSessionCursorModelCatalog(
            cursorModelsState.availableModels,
            'auto',
            cursorModelsState.cliModelSkus
        ),
        [cursorModelsState.availableModels, cursorModelsState.cliModelSkus]
    )

    useEffect(() => {
        if (
            agent !== 'cursor'
            || cursorModelsState.isLoading
            || cursorModelsState.error
        ) {
            return
        }
        if (model !== 'auto' && !availableCursorCatalog.wireToBase.has(model)) {
            setModel('auto')
            setCursorSelectedBase('auto')
            return
        }
        if (
            cursorSelectedBase !== 'auto'
            && !availableCursorCatalog.variantsByBase.has(cursorSelectedBase)
        ) {
            setCursorSelectedBase('auto')
        }
    }, [
        agent,
        availableCursorCatalog,
        cursorModelsState.error,
        cursorModelsState.isLoading,
        cursorSelectedBase,
        model
    ])

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

    const { pathExistence, outsideWorkspaceRoots, checkPathsExists } = useMachinePathsExists(
        props.api,
        machineId,
        pathsToCheck
    )

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
    const copilotModelsState = useCopilotModelsForCwd({
        api: props.api,
        machineId,
        cwd: deferredDirectory,
        enabled: agent === 'copilot' && deferredDirectoryExists === true
    })
    const copilotModelOptions = useMemo(
        () => [
            { value: 'auto', label: 'Auto' },
            ...copilotModelsState.availableModels
                .filter((candidate) => candidate.modelId !== 'auto')
                .map((candidate) => ({
                    value: candidate.modelId,
                    label: candidate.name ?? candidate.modelId
                }))
        ],
        [copilotModelsState.availableModels]
    )
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
    const agyModelsState = useAgyModels({
        api: props.api,
        machineId,
        enabled: agent === 'agy' && Boolean(machineId)
    })
    const piModelsState = usePiModelsForMachine({
        api: props.api,
        machineId,
        enabled: agent === 'pi' && Boolean(machineId)
    })
    // Pi models are grouped by provider (optionSource: 'machine' in the agent
    // config descriptor). Option values are provider-qualified
    // (`provider/modelId`) so two providers sharing a modelId stay distinct;
    // the CLI startup match resolves the qualified id before applying set_model.
    const piModelOptions = useMemo(() => {
        const groups = groupModelsByProvider(piModelsState.availableModels)
        return [
            { value: 'auto', label: 'Default' },
            ...groups.flatMap((group) => group.models.map((model) => ({
                value: `${model.provider || 'unknown'}/${model.modelId}`,
                label: model.name ?? model.modelId,
                group: group.label,
            }))),
        ]
    }, [piModelsState.availableModels])
    const piSelectedModel = useMemo(() => {
        if (agent !== 'pi' || model === 'auto') return null
        const slash = model.indexOf('/')
        if (slash > 0) {
            const provider = model.slice(0, slash)
            const modelId = model.slice(slash + 1)
            return piModelsState.availableModels.find(
                (candidate) => candidate.provider === provider && candidate.modelId === modelId
            ) ?? null
        }
        return piModelsState.availableModels.find((candidate) => candidate.modelId === model) ?? null
    }, [agent, model, piModelsState.availableModels])
    useEffect(() => {
        // A non-reasoning Pi model must not carry a stale launch effort (the
        // CLI would reject it and fall back to Pi's default), and a level the
        // selected model's thinkingLevelMap marks unsupported must not survive
        // a model switch (mirrors the HappyComposer effort reconciliation).
        if (agent !== 'pi' || effort === 'auto') {
            return
        }
        if (piSelectedModel?.reasoning === false) {
            setEffort('auto')
            return
        }
        // Reset a level the current selection cannot offer, so a level the
        // field no longer renders can never be submitted. This covers:
        //   - a resolved model whose map excludes the level;
        //   - the Default selection (model === 'auto', no map, hides xhigh/max);
        //   - a failed catalog request, where a restored explicit model stays
        //     unresolved for good and creation is not blocked (only loading
        //     gates it), so waiting for a map that will never arrive would let
        //     the hidden level through.
        // While a concrete model is still resolving (no error yet) do not
        // reset — the map may still prove a restored xhigh/max valid.
        const piSelectionSettled = model === 'auto'
            || Boolean(piSelectedModel)
            || Boolean(piModelsState.error)
        if (
            piSelectionSettled
            && !isThinkingLevelSupported(effort, piSelectedModel?.thinkingLevelMap)
        ) {
            setEffort('auto')
        }
    }, [agent, model, piSelectedModel, piModelsState.error, effort])
    useEffect(() => {
        // Reconcile a restored Pi selection with the live machine catalog
        // (mirrors the Codex/Grok/Copilot validation effects). A model that
        // left the catalog must not stay in state: the native select would
        // visually fall back to Default while Create still sends the stale id.
        if (
            agent !== 'pi'
            || piModelsState.isLoading
            || piModelsState.error
            || model === 'auto'
        ) {
            return
        }
        if (!piModelOptions.some((option) => option.value === model)) {
            setModel('auto')
            setEffort('auto')
        }
    }, [agent, model, piModelOptions, piModelsState.error, piModelsState.isLoading])
    useEffect(() => {
        if (preserveRestoredDraftRef.current) {
            return
        }
        // Reset selection when agent / machine changes. The default is "Default"
        // (null → no --model → agy uses its own default); we intentionally do NOT
        // auto-pick the first model, so the user's explicit "Default" choice
        // sticks instead of snapping to the first option.
        setAgySelectedModel(null)
    }, [agent, machineId])

    useEffect(() => {
        if (
            agent !== 'agy'
            || agyModelsState.isLoading
            || agyModelsState.error
            || agySelectedModel === null
        ) {
            return
        }
        if (!agyModelsState.availableModels.some((candidate) => candidate.modelId === agySelectedModel)) {
            setAgySelectedModel(null)
        }
    }, [
        agent,
        agyModelsState.availableModels,
        agyModelsState.error,
        agyModelsState.isLoading,
        agySelectedModel
    ])

    useEffect(() => {
        // Restore a remembered model when it is still advertised for this cwd;
        // otherwise auto-pick the backend default.
        if (
            agent !== 'opencode'
            || deferredDirectoryExists !== true
            || opencodeModelsState.isLoading
            || opencodeModelsState.error
        ) {
            return
        }
        // null = explicit "Default" choice (or a restored Default preference) —
        // never overwrite it with a concrete model. Only `undefined` (no choice
        // made yet) triggers initialization.
        if (opencodeSelectedModel === null) {
            return
        }
        if (
            opencodeSelectedModel !== undefined
            && opencodeModelsState.availableModels.some(
                (candidate) => candidate.modelId === opencodeSelectedModel
            )
        ) {
            return
        }
        const rememberedModel = machineId
            ? loadPreferredLaunchSettings(machineId, 'opencode')?.model
            : null
        const rememberedModelAvailable = rememberedModel
            && rememberedModel !== 'auto'
            && opencodeModelsState.availableModels.some(
                (candidate) => candidate.modelId === rememberedModel
            )
        const fallback = (rememberedModelAvailable ? rememberedModel : null)
            ?? opencodeModelsState.currentModelId
            ?? opencodeModelsState.availableModels[0]?.modelId
            ?? null
        setOpencodeSelectedModel(fallback)
    }, [
        agent,
        deferredDirectoryExists,
        opencodeModelsState.availableModels,
        opencodeModelsState.currentModelId,
        opencodeModelsState.error,
        opencodeModelsState.isLoading,
        opencodeSelectedModel,
        machineId
    ])
    useEffect(() => {
        // Reset selection when agent / machine / directory changes; new probe = new defaults.
        // `undefined` = uninitialized (probe again); `null` = explicit Default choice.
        if (preserveRestoredDraftRef.current) {
            return
        }
        setOpencodeSelectedModel(undefined)
    }, [agent, machineId, deferredDirectory])

    useEffect(() => {
        if (!machineId || preserveRestoredDraftRef.current) {
            return
        }

        const preferred = resolvePreferredLaunchSettings(
            agent,
            loadPreferredLaunchSettings(machineId, agent),
            legacyCodexYolo
        )

        setModel(agent === 'opencode' ? 'auto' : preferred.model)
        setCursorSelectedBase(preferred.cursorSelectedBase)
        setEffort(preferred.effort)
        setModelReasoningEffort(preferred.modelReasoningEffort)
        if (usesCodexFamilyPermissionModes(agent)) {
            setCodexFamilyPermissionMode(preferred.permissionMode ?? 'default')
        }
        setOpencodeSelectedModel(
            agent === 'opencode' && preferred.model !== 'auto' ? preferred.model : null
        )
        setAgySelectedModel(
            agent === 'agy' && preferred.model !== 'auto' ? preferred.model : null
        )
    }, [agent, legacyCodexYolo, machineId])

    useEffect(() => {
        if (
            agent !== 'grok'
            || deferredDirectoryExists !== true
            || grokModelsState.isLoading
            || grokModelsState.error
        ) {
            return
        }
        if (
            model !== 'auto'
            && !grokModelsState.availableModels.some((candidate) => candidate.modelId === model)
        ) {
            setModel('auto')
        }
        if (
            effort !== 'auto'
            && !grokEffortOptions.some((option) => option.value === effort)
        ) {
            setEffort('auto')
        }
    }, [
        agent,
        deferredDirectoryExists,
        effort,
        grokEffortOptions,
        grokModelsState.availableModels,
        grokModelsState.error,
        grokModelsState.isLoading,
        model
    ])
    useEffect(() => {
        if (
            agent === 'copilot'
            && deferredDirectoryExists === true
            && !copilotModelsState.isLoading
            && !copilotModelsState.error
            && model !== 'auto'
            && !copilotModelsState.availableModels.some((candidate) => candidate.modelId === model)
        ) {
            setModel('auto')
        }
    }, [
        agent,
        copilotModelsState.availableModels,
        copilotModelsState.error,
        copilotModelsState.isLoading,
        deferredDirectoryExists,
        model
    ])

    const currentDirectoryExists = trimmedDirectory ? pathExistence[trimmedDirectory] : undefined
    const directoryOutsideWorkspaceRoots = trimmedDirectory
        ? outsideWorkspaceRoots.has(trimmedDirectory)
        : false
    const needsDirectoryCreationWarning = !directoryOutsideWorkspaceRoots
        && sessionType === 'simple'
        && trimmedDirectory !== ''
        && currentDirectoryExists === false
    const missingWorktreeDirectory = !directoryOutsideWorkspaceRoots
        && sessionType === 'worktree'
        && trimmedDirectory !== ''
        && currentDirectoryExists === false
    const directoryStatusMessage = directoryOutsideWorkspaceRoots
        ? t('newSession.directoryOutsideWorkspaceRoots')
        : missingWorktreeDirectory
        ? t('session.directoryMissingWorktree')
        : needsDirectoryCreationWarning
            ? (
                directoryCreationConfirmed
                    ? t('session.directoryMissingSimpleConfirm')
                    : t('session.directoryMissingSimple')
            )
            : null
    const directoryStatusTone = directoryOutsideWorkspaceRoots || missingWorktreeDirectory
        ? 'error'
        : needsDirectoryCreationWarning
            ? 'warning'
            : null
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

    useEffect(() => {
        piLoadGenerationRef.current += 1
        setIsLoadingPiImportSessions(false)
    }, [agent, machineId, trimmedDirectory])

    useEffect(() => () => {
        piLoadGenerationRef.current += 1
    }, [])

    const loadPiImportSessions = useCallback(async () => {
        if (agent !== 'pi' || !machineId) return
        const generation = ++piLoadGenerationRef.current
        setIsLoadingPiImportSessions(true)
        setPiImportError(null)
        try {
            const result = await props.api.getPiSessions(trimmedDirectory || null, machineId)
            if (generation !== piLoadGenerationRef.current) return
            if (!result.success) throw new Error(result.error)
            setPiImportSessions(result.sessions)
            setPiImportMachineId(result.machineId ?? machineId)
            setSelectedPiImportSessionId((current) => current && result.sessions.some((session) => session.id === current) ? current : null)
        } catch (loadError) {
            if (generation !== piLoadGenerationRef.current) return
            setPiImportSessions([])
            setPiImportMachineId(null)
            setSelectedPiImportSessionId(null)
            setPiImportError(loadError instanceof Error ? loadError.message : t('piImport.failed.body'))
        } finally {
            if (generation === piLoadGenerationRef.current) setIsLoadingPiImportSessions(false)
        }
    }, [agent, machineId, props.api, trimmedDirectory, t])

    const formatPiImportError = useCallback((code?: string, message?: string): string => {
        if (code === 'transcript_diverged') return t('piImport.error.diverged')
        if (code === 'session_active') return t('piImport.error.active')
        return message?.trim() || t('piImport.failed.body')
    }, [t])

    const normalizeCodexScriptError = useCallback((message: string | null | undefined, fallback: string): string => {
        const raw = (message ?? '').trim()
        if (!raw) return fallback
        if (/执行超时|timed\s*out|timeout/i.test(raw)) return t('codexSync.error.timeout')
        if (/当前会话仍处于活跃状态，请等待会话结束后重试|Active Hapi process already has this Codex thread/i.test(raw)) {
            return t('codexSync.error.active')
        }
        if (/未安装\/找不到codex客户端|unable to find codex launcher|找不到.*codex/i.test(raw)) {
            return t('codexSync.restart.failed.notFound')
        }
        return raw
    }, [t])

    const formatCodexImportFailure = useCallback((reason: string): string => {
        if (
            reason === t('codexSync.error.timeout')
            || reason === t('codexSync.error.active')
            || reason === t('codexSync.restart.failed.notFound')
        ) {
            return reason
        }
        return t('codexSync.failed.bodyWithReason', { reason })
    }, [t])

    const handleRestartCodexDesktop = useCallback(async () => {
        setIsRestartingCodexDesktop(true)
        try {
            const status = await props.api.getCodexDesktopStatus()
            if (!status.codexClientAvailable) throw new Error(t('codexSync.restart.failed.notFound'))

            const result = await props.api.restartCodexDesktop()
            if (!result.success) {
                throw new Error(normalizeCodexScriptError(result.error, t('codexSync.restart.failed.body')))
            }
            addToast({
                title: t('codexSync.restart.started.title'),
                body: t('codexSync.restart.started.body'),
                sessionId: '',
                url: ''
            })
        } catch (restartError) {
            addToast({
                title: t('codexSync.restart.failed.title'),
                body: normalizeCodexScriptError(
                    restartError instanceof Error ? restartError.message : null,
                    t('codexSync.restart.failed.body')
                ),
                sessionId: '',
                url: ''
            })
        } finally {
            setIsRestartingCodexDesktop(false)
        }
    }, [addToast, normalizeCodexScriptError, props.api, t])

    const closeDuplicateMergeDialog = useCallback(() => {
        setIsDuplicateMergeConfirmOpen(false)
        setPendingDuplicateSessionIds([])
        setPendingDuplicateHapiSessionIds([])
        setDuplicateSessionGroups([])
    }, [])

    const handleBulkImportCodexSessions = useCallback(async (sessionIds: string[]) => {
        if (isBulkImportingCodexSessions || isLoadingCodexImportSessions) return

        setIsBulkImportingCodexSessions(true)
        try {
            const result = await props.api.syncCodexSession({
                sessionIds,
                cwd: trimmedDirectory || null,
                machineId: codexImportMachineId ?? machineId
            })
            if (!result.success) {
                throw new Error(normalizeCodexScriptError(result.error, t('codexSync.failed.body')))
            }

            markCodexSessionsImported(sessionIds)
            setSelectedCodexImportSessionId((current) =>
                clearBatchImportedCodexSelection(current, sessionIds)
            )
            setIsCodexImportDialogOpen(false)
            addToast({
                title: t('codexSync.success.title'),
                body: t('codexSync.success.body', { n: result.syncedCount ?? sessionIds.length }),
                sessionId: '',
                url: ''
            })
            await refetchSessions()

            closeDuplicateMergeDialog()
            setPendingDuplicateHapiSessionIds(result.hapiSessionIds ?? [])
            try {
                const duplicateResult = await props.api.getCodexDuplicateSessions({ sessionIds })
                if (!duplicateResult.success) {
                    throw new Error(normalizeCodexScriptError(
                        duplicateResult.error,
                        t('codexSync.duplicates.detect.failed.body')
                    ))
                }
                if (duplicateResult.duplicates.length > 0) {
                    setPendingDuplicateSessionIds(sessionIds)
                    setPendingDuplicateHapiSessionIds(result.hapiSessionIds ?? [])
                    setDuplicateSessionGroups(duplicateResult.duplicates)
                    setIsDuplicateMergeConfirmOpen(true)
                }
            } catch (duplicateError) {
                addToast({
                    title: t('codexSync.duplicates.detect.failed.title'),
                    body: normalizeCodexScriptError(
                        duplicateError instanceof Error ? duplicateError.message : null,
                        t('codexSync.duplicates.detect.failed.body')
                    ),
                    sessionId: '',
                    url: ''
                })
            }
        } catch (importError) {
            const reason = normalizeCodexScriptError(
                importError instanceof Error ? importError.message : null,
                t('dialog.error.default')
            )
            addToast({
                title: t('codexSync.failed.title'),
                body: formatCodexImportFailure(reason),
                sessionId: '',
                url: ''
            })
        } finally {
            setIsBulkImportingCodexSessions(false)
        }
    }, [
        addToast,
        closeDuplicateMergeDialog,
        codexImportMachineId,
        formatCodexImportFailure,
        isBulkImportingCodexSessions,
        isLoadingCodexImportSessions,
        machineId,
        normalizeCodexScriptError,
        props.api,
        refetchSessions,
        t,
        trimmedDirectory
    ])

    const handleMergeDuplicateSessions = useCallback(async () => {
        if (isMergingDuplicateSessions || pendingDuplicateSessionIds.length === 0) return

        setIsMergingDuplicateSessions(true)
        try {
            const result = await props.api.mergeCodexDuplicateSessions({ sessionIds: pendingDuplicateSessionIds })
            if (!result.success) {
                throw new Error(normalizeCodexScriptError(result.error, t('codexSync.duplicates.merge.failed.body')))
            }
            addToast({
                title: t('codexSync.duplicates.merge.success.title'),
                body: t('codexSync.duplicates.merge.success.body'),
                sessionId: '',
                url: ''
            })
            const redirectSessionId = resolveCodexImportRedirectSessionId(
                result.merged,
                pendingDuplicateHapiSessionIds
            )
            closeDuplicateMergeDialog()
            await refetchSessions()
            if (redirectSessionId) props.onSuccess(redirectSessionId)
        } catch (mergeError) {
            addToast({
                title: t('codexSync.duplicates.merge.failed.title'),
                body: normalizeCodexScriptError(
                    mergeError instanceof Error ? mergeError.message : null,
                    t('codexSync.duplicates.merge.failed.body')
                ),
                sessionId: '',
                url: ''
            })
            throw mergeError
        } finally {
            setIsMergingDuplicateSessions(false)
        }
    }, [
        addToast,
        closeDuplicateMergeDialog,
        isMergingDuplicateSessions,
        normalizeCodexScriptError,
        pendingDuplicateHapiSessionIds,
        pendingDuplicateSessionIds,
        props.api,
        props.onSuccess,
        refetchSessions,
        t
    ])

    const handleBulkImportPiSessions = useCallback(async (sessionIds: string[]) => {
        if (isBulkImportingPiSessions || isLoadingPiImportSessions) return
        setIsBulkImportingPiSessions(true)
        try {
            const result = await props.api.importPiSessions({
                sessionIds,
                cwd: trimmedDirectory || null,
                machineId: piImportMachineId ?? machineId
            })
            const importedCount = result.results.filter((item) => item.hapiSessionId && !item.error).length
            const failed = result.results.filter((item) => item.error)
            if (importedCount > 0) {
                addToast({
                    title: t('piImport.success.title'),
                    body: t('piImport.success.body', { n: importedCount }),
                    sessionId: '',
                    url: ''
                })
                await refetchSessions()
                await loadPiImportSessions()
            }
            if (failed.length > 0) {
                const first = failed[0]!.error!
                addToast({
                    title: t('piImport.failed.title'),
                    body: t('piImport.failed.partial', {
                        failed: failed.length,
                        reason: formatPiImportError(first.code, first.message)
                    }),
                    sessionId: '',
                    url: ''
                })
                return
            }
            setIsPiImportDialogOpen(false)
            setSelectedPiImportSessionId(null)
        } catch (importError) {
            addToast({
                title: t('piImport.failed.title'),
                body: importError instanceof Error ? importError.message : t('piImport.failed.body'),
                sessionId: '',
                url: ''
            })
        } finally {
            setIsBulkImportingPiSessions(false)
        }
    }, [
        addToast,
        formatPiImportError,
        isBulkImportingPiSessions,
        isLoadingPiImportSessions,
        loadPiImportSessions,
        machineId,
        piImportMachineId,
        props.api,
        refetchSessions,
        t,
        trimmedDirectory
    ])

    const selectedCodexImportSession = useMemo(
        () => codexImportSessions.find((session) => session.id === selectedCodexImportSessionId) ?? null,
        [codexImportSessions, selectedCodexImportSessionId]
    )
    const selectedPiImportSession = useMemo(
        () => piImportSessions.find((session) => session.id === selectedPiImportSessionId) ?? null,
        [piImportSessions, selectedPiImportSessionId]
    )
    // Pi history import reopens the native session as-is; the launch-only
    // model/effort controls would silently not apply, so hide them.
    const showPiLaunchConfig = agent !== 'pi' || !selectedPiImportSession

    const handleAgentChange = useCallback((newAgent: AgentType) => {
        preserveRestoredDraftRef.current = false
        setAgent(newAgent)
    }, [])

    const handleMachineChange = useCallback((newMachineId: string) => {
        preserveRestoredDraftRef.current = false
        setMachineId(newMachineId)
        setModel('auto')
        setCursorSelectedBase('auto')
        setSelectedCodexImportSessionId(null)
        setCodexImportSessions([])
        setCodexImportMachineId(null)
        setSelectedPiImportSessionId(null)
        setPiImportSessions([])
        setPiImportMachineId(null)
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
            model: agent === 'agy'
                ? (agySelectedModel ?? 'auto')
                : agent === 'opencode'
                    ? (opencodeSelectedModel ?? 'auto')
                    : model,
            cursorSelectedBase,
            machineId,
            effort,
            modelReasoningEffort,
            serviceTier,
            collaborationMode,
            copilotAgentMode,
            yoloMode,
            codexFamilyPermissionMode,
            grokPermissionMode,
            sessionType,
            worktreeName
        })
        props.onChooseFolder({ machineId, directory: trimmedDirectory })
    }, [
        props.onChooseFolder,
        agent,
        model,
        opencodeSelectedModel,
        agySelectedModel,
        cursorSelectedBase,
        machineId,
        effort,
        modelReasoningEffort,
        serviceTier,
        collaborationMode,
        copilotAgentMode,
        yoloMode,
        codexFamilyPermissionMode,
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

    const handleSelectPiImportSession = useCallback((session: PiLocalSessionSummary) => {
        setSelectedPiImportSessionId(session.id)
        if (session.cwd?.trim()) setDirectory(session.cwd.trim())
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
        if (!machineId || !trimmedDirectory || createInFlightRef.current) return

        createInFlightRef.current = true
        setIsCreating(true)
        setError(null)
        try {
            if (!selectedAgentAvailable) {
                haptic.notification('error')
                setError(t('newSession.agentUnavailable'))
                return
            }
            const existsResult = await checkPathsExists([trimmedDirectory])
            if (existsResult.outsideWorkspaceRoots?.includes(trimmedDirectory)) {
                haptic.notification('error')
                setError(t('newSession.directoryOutsideWorkspaceRoots'))
                return
            }
            const directoryExists = existsResult.exists[trimmedDirectory]

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
                : agent === 'agy'
                    ? (agySelectedModel ?? undefined)
                    : (model !== 'auto' ? model : undefined)
            const resolvedEffort = (agent === 'claude' || agent === 'grok' || agent === 'pi') && effort !== 'auto'
                ? effort
                : undefined
            const resolvedModelReasoningEffort = (agent === 'codex' || agent === 'opencode') && modelReasoningEffort !== 'default'
                ? modelReasoningEffort
                : undefined
            const usesCodexFamilyPermissions = usesCodexFamilyPermissionModes(agent)
            const preferredLaunchSettings = {
                model: agent === 'agy'
                    ? (agySelectedModel ?? 'auto')
                    : agent === 'opencode'
                        ? (opencodeSelectedModel ?? 'auto')
                        : model,
                cursorSelectedBase,
                effort,
                modelReasoningEffort,
                ...(usesCodexFamilyPermissions ? { permissionMode: codexFamilyPermissionMode } : {})
            }
            const resolvedServiceTier = agent === 'codex' && showCodexFastMode
                ? serviceTier
                : undefined
            const resolvedCollaborationMode = agent === 'codex' && collaborationMode !== 'default'
                ? collaborationMode
                : undefined

            if (agent === 'codex' && selectedCodexImportSession) {
                setIsImportingCodexSession(true)
                const result = await props.api.syncCodexSession({
                    sessionIds: [selectedCodexImportSession.id],
                    cwd: selectedCodexImportSession.cwd ?? trimmedDirectory,
                    machineId: codexImportMachineId ?? machineId,
                    model: resolvedModel ?? null,
                    modelReasoningEffort: resolvedModelReasoningEffort ?? null,
                    serviceTier: resolvedServiceTier,
                    collaborationMode: resolvedCollaborationMode ?? 'default',
                    yolo: codexFamilyPermissionMode === 'yolo'
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
                        codexFamilyPermissionMode !== 'default'
                            ? { permissionMode: codexFamilyPermissionMode }
                            : undefined
                    )
                    haptic.notification('success')
                    markCodexSessionsImported([selectedCodexImportSession.id])
                    savePreferredLaunchSettings(machineId, agent, preferredLaunchSettings)
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

            if (agent === 'pi' && selectedPiImportSession) {
                setIsImportingPiSession(true)
                const result = await props.api.importPiSessions({
                    sessionIds: [selectedPiImportSession.id],
                    cwd: selectedPiImportSession.cwd ?? trimmedDirectory,
                    machineId: piImportMachineId ?? machineId
                })
                const imported = result.results.find((item) => item.piSessionId === selectedPiImportSession.id)
                if (imported?.error) {
                    setIsImportingPiSession(false)
                    haptic.notification('error')
                    setError(formatPiImportError(imported.error.code, imported.error.message))
                    return
                }
                if (!imported?.hapiSessionId) throw new Error(result.error || t('piImport.failed.body'))
                const reopened = await props.api.reopenSession(imported.hapiSessionId)
                haptic.notification('success')
                savePreferredLaunchSettings(machineId, agent, preferredLaunchSettings)
                clearNewSessionFormDraft()
                setLastUsedMachineId(machineId)
                addRecentPath(machineId, trimmedDirectory)
                props.onSuccess(reopened.sessionId)
                return
            }

            const result = await spawnSession({
                machineId,
                directory: trimmedDirectory,
                agent,
                model: resolvedModel,
                effort: resolvedEffort,
                modelReasoningEffort: resolvedModelReasoningEffort,
                yolo: agent === 'dsh' || agent === 'grok' || usesCodexFamilyPermissions ? undefined : yoloMode,
                permissionMode: agent === 'grok'
                    ? grokPermissionMode
                    : usesCodexFamilyPermissions
                        ? codexFamilyPermissionMode
                        : undefined,
                sessionType,
                worktreeName: sessionType === 'worktree' ? (worktreeName.trim() || undefined) : undefined,
                serviceTier: resolvedServiceTier,
                collaborationMode: resolvedCollaborationMode,
                copilotAgentMode: agent === 'copilot' ? copilotAgentMode : undefined,
            })


            if (result.type === 'success') {
                haptic.notification('success')
                savePreferredLaunchSettings(machineId, agent, preferredLaunchSettings)
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
            setIsImportingPiSession(false)
            haptic.notification('error')
            setError(e instanceof Error ? e.message : 'Failed to create session')
        } finally {
            createInFlightRef.current = false
            setIsCreating(false)
        }
    }

    const isLaunchPreferenceValidationPending =
        (agent === 'codex'
            && (model !== 'auto' || modelReasoningEffort !== 'default')
            && codexModelsState.isLoading)
        || (agent === 'agy'
            && agySelectedModel !== null
            && agyModelsState.isLoading)
        || (agent === 'cursor'
            && (model !== 'auto' || cursorSelectedBase !== 'auto')
            && cursorModelsState.isLoading)
        || (agent === 'grok'
            && deferredDirectory !== ''
            && (model !== 'auto' || effort !== 'auto')
            && (
                deferredDirectoryExists === undefined
                || (deferredDirectoryExists === true && grokModelsState.isLoading)
            ))
        || (agent === 'opencode'
            && deferredDirectory !== ''
            && opencodeSelectedModel !== null
            && (
                deferredDirectoryExists === undefined
                || (deferredDirectoryExists === true && opencodeModelsState.isLoading)
            ))
        || (agent === 'copilot'
            && model !== 'auto'
            && (
                deferredDirectoryExists === undefined
                || (deferredDirectoryExists === true && copilotModelsState.isLoading)
            ))
        || (agent === 'pi'
            && model !== 'auto'
            && piModelsState.isLoading)
    const fastModeSelectionPending = agent === 'codex'
        && serviceTier === 'fast'
        && codexModelsState.isLoading
    const canCreate = Boolean(
        machineId
        && trimmedDirectory
        && !isFormDisabled
        && !missingWorktreeDirectory
        && !directoryOutsideWorkspaceRoots
        && !agentAvailability.isLoading
        && !agentAvailability.error
        && selectedAgentAvailable
        && !isLaunchPreferenceValidationPending
        && !fastModeSelectionPending
    )

    return (
        <div className="flex flex-col divide-y divide-[var(--app-divider)] [&>div]:pr-[10px] lg:[&>div]:pr-3">
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
                agents={availableAgents}
                isDisabled={isFormDisabled || agentAvailability.isLoading || Boolean(agentAvailability.error)}
                onAgentChange={handleAgentChange}
            />
            {agentAvailability.isLoading ? (
                <div className="px-3 py-2 text-xs text-[var(--app-hint)]">
                    {t('newSession.agentAvailabilityLoading')}
                </div>
            ) : agentAvailability.error ? (
                <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs text-red-600">
                    <span>
                        {agentAvailability.upgradeRequired
                            ? t('newSession.runnerUpgradeRequired')
                            : t('newSession.agentAvailabilityFailed')}
                    </span>
                    <button type="button" className="underline" onClick={agentAvailability.refetch}>
                        {t('button.retry')}
                    </button>
                </div>
            ) : availableAgents.length === 0 ? (
                <div className="px-3 py-2 text-xs text-red-600">
                    {t('newSession.noAvailableAgents')}
                </div>
            ) : null}
            {agent === 'codex' ? (
                <CodexImportActions
                    selectedSession={selectedCodexImportSession}
                    isLoading={isLoadingCodexImportSessions}
                    isDisabled={isFormDisabled}
                    error={codexImportError}
                    onChooseHistory={() => {
                        setIsCodexImportDialogOpen(true)
                        void loadCodexImportSessions()
                    }}
                    onClear={() => setSelectedCodexImportSessionId(null)}
                />
            ) : null}
            {agent === 'pi' ? (
                <PiImportActions
                    selectedSession={selectedPiImportSession}
                    isLoading={isLoadingPiImportSessions}
                    isDisabled={isFormDisabled}
                    error={piImportError}
                    onChooseHistory={() => {
                        setIsPiImportDialogOpen(true)
                        void loadPiImportSessions()
                    }}
                    onClear={() => setSelectedPiImportSessionId(null)}
                />
            ) : null}
            {agent === 'dsh' ? null : agent === 'agy' ? (
                <AgyModelSelector
                    machineId={machineId}
                    isLoading={agyModelsState.isLoading}
                    error={agyModelsState.error}
                    availableModels={agyModelsState.availableModels}
                    selectedModel={agySelectedModel}
                    onModelChange={setAgySelectedModel}
                    onRetry={agyModelsState.refetch}
                />
            ) : agent === 'opencode' ? (
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
                                    : agent === 'copilot'
                                        ? copilotModelOptions
                                        : agent === 'pi'
                                            ? (showPiLaunchConfig ? piModelOptions : undefined)
                                    : undefined
                        }
                        isDisabled={
                            isFormDisabled
                            || (agent === 'codex' && Boolean(codexModelsState.error))
                            || (agent === 'grok' && Boolean(grokModelsState.error))
                            || (agent === 'copilot' && Boolean(copilotModelsState.error))
                            || (agent === 'pi' && Boolean(piModelsState.error))
                        }
                        isLoading={(agent === 'codex' && codexModelsState.isLoading)
                            || (agent === 'grok' && grokModelsState.isLoading)
                            || (agent === 'copilot' && copilotModelsState.isLoading)
                            || (agent === 'pi' && piModelsState.isLoading)}
                        error={agent === 'codex' && codexModelsState.error
                            ? `${t('newSession.model.loadFailed')}: ${codexModelsState.error}`
                            : agent === 'grok' && grokModelsState.error
                                ? `${t('newSession.model.loadFailed')}: ${grokModelsState.error}`
                                : agent === 'copilot' && copilotModelsState.error
                                    ? `${t('newSession.model.loadFailed')}: ${copilotModelsState.error}`
                                    : agent === 'pi' && piModelsState.error
                                        ? `${t('newSession.model.loadFailed')}: ${piModelsState.error}`
                                    : null}
                        onModelChange={setModel}
                    />
                )
            )}
            {showPiLaunchConfig ? (
                <EffortField
                    agent={agent}
                    effort={effort}
                    onEffortChange={setEffort}
                    reasoningEffort={modelReasoningEffort}
                    onReasoningEffortChange={setModelReasoningEffort}
                    isDisabled={isFormDisabled || (agent === 'codex' && codexModelsState.isLoading)}
                    grokOptions={agent === 'grok' ? grokEffortOptions : undefined}
                    codexReasoningOptions={agent === 'codex' ? codexReasoningEffortOptions : undefined}
                    piSelectedModel={agent === 'pi' ? piSelectedModel : null}
                />
            ) : null}
            <PermissionField
                agent={agent}
                nativeValue={agent === 'grok' ? grokPermissionMode : codexFamilyPermissionMode}
                yoloMode={yoloMode}
                autoPermissionModeSupported={agent === 'grok' ? grokModelsState.autoPermissionModeSupported : null}
                isDisabled={isFormDisabled}
                onNativeChange={(mode) => {
                    if (agent === 'grok') {
                        setGrokPermissionMode(mode as GrokPermissionMode)
                    } else {
                        setCodexFamilyPermissionMode(mode)
                    }
                }}
                onYoloToggle={setYoloMode}
            />
            <CollaborationModeSelector
                agent={agent}
                value={collaborationMode}
                isDisabled={isFormDisabled}
                onChange={setCollaborationMode}
            />
            <CopilotAgentModeSelector
                agent={agent}
                value={copilotAgentMode}
                isDisabled={isFormDisabled}
                onChange={setCopilotAgentMode}
            />
            <FastModeSelector
                visible={showCodexFastMode}
                value={serviceTier}
                isDisabled={isFormDisabled}
                onChange={setServiceTier}
            />

            {(error ?? spawnError) ? (
                <div className="px-3 py-2 text-sm text-red-600">
                    {error ?? spawnError}
                </div>
            ) : null}

            <ActionButtons
                isPending={isCreating || isPending || isImportingCodexSession || isImportingPiSession}
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
                selectionMode="multiple"
                onConfirm={async (sessionIds) => {
                    if (sessionIds.length === 1) {
                        const session = codexImportSessions.find((candidate) => candidate.id === sessionIds[0])
                        if (session) {
                            handleSelectCodexImportSession(session)
                            setIsCodexImportDialogOpen(false)
                        }
                        return
                    }
                    await handleBulkImportCodexSessions(sessionIds)
                }}
                onRestartCodexDesktop={handleRestartCodexDesktop}
                onArchiveSession={handleArchiveCodexImportSession}
                isPending={isBulkImportingCodexSessions}
                isRestartingCodexDesktop={isRestartingCodexDesktop}
                isLoading={isLoadingCodexImportSessions}
            />
            <PiSessionImportDialog
                isOpen={isPiImportDialogOpen}
                onClose={() => setIsPiImportDialogOpen(false)}
                sessions={piImportSessions}
                currentSessionId={selectedPiImportSessionId}
                currentWorkDirectory={trimmedDirectory}
                onConfirm={async (sessionIds) => {
                    if (sessionIds.length === 1) {
                        const session = piImportSessions.find((candidate) => candidate.id === sessionIds[0])
                        if (session) {
                            handleSelectPiImportSession(session)
                            setIsPiImportDialogOpen(false)
                        }
                        return
                    }
                    await handleBulkImportPiSessions(sessionIds)
                }}
                isPending={isBulkImportingPiSessions}
                isLoading={isLoadingPiImportSessions}
            />
            <ConfirmDialog
                isOpen={isDuplicateMergeConfirmOpen && duplicateSessionGroups.length > 0}
                onClose={closeDuplicateMergeDialog}
                title={t('codexSync.duplicates.confirm.title')}
                description={t('codexSync.duplicates.confirm.description')}
                confirmLabel={t('codexSync.duplicates.confirm.confirm')}
                confirmingLabel={t('codexSync.duplicates.confirm.confirming')}
                onConfirm={handleMergeDuplicateSessions}
                isPending={isMergingDuplicateSessions}
                centerTitle
            />
        </div>
    )
}
