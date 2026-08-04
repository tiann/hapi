import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ApiClient } from '@/api/client'
import type { CodexDuplicateSessionGroup, CodexLocalSessionSummary, Machine } from '@/types/api'
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
import { clearBatchImportedCodexSelection, resolveCodexImportRedirectSessionId } from './codexImportMerge'
import { AgyModelSelector } from './AgyModelSelector'
import { DirectorySection } from './DirectorySection'
import { GrokPermissionModeSelector } from './GrokPermissionModeSelector'
import { CodexFamilyPermissionModeSelector } from './CodexFamilyPermissionModeSelector'
import { CopilotAgentModeSelector } from './CopilotAgentModeSelector'
import { FastModeSelector } from './FastModeSelector'
import { MachineSelector } from './MachineSelector'
import { ModelSelector } from './ModelSelector'
import { OpencodeModelSelector } from './OpencodeModelSelector'
import { LaunchEffortSelector } from './LaunchEffortSelector'
import { shouldEnableOpencodeModelDiscovery } from './opencodeModelsGate'
import { buildGrokEffortOptions, buildGrokModelOptions, shouldEnableGrokModelDiscovery } from './grokModels'
import { ReasoningEffortSelector } from './ReasoningEffortSelector'
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
import { YoloToggle } from './YoloToggle'
import { usesCodexFamilyPermissionModes } from '@/lib/codexFamilyPermissionAgents'
import { CodexSessionSyncDialog } from '@/components/CodexSessionSyncDialog'
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
    const [model, setModel] = useState('auto')
    const [cursorSelectedBase, setCursorSelectedBase] = useState('auto')
    const pendingCursorBaseRef = useRef<string | null>(null)
    const [effort, setEffort] = useState<LaunchEffort>('auto')
    const [modelReasoningEffort, setModelReasoningEffort] = useState<CodexReasoningEffort>('default')
    const [opencodeSelectedModel, setOpencodeSelectedModel] = useState<string | null>(null)
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
    const [isCreating, setIsCreating] = useState(false)
    const createInFlightRef = useRef(false)
    const [isBulkImportingCodexSessions, setIsBulkImportingCodexSessions] = useState(false)
    const [isRestartingCodexDesktop, setIsRestartingCodexDesktop] = useState(false)
    const [pendingDuplicateSessionIds, setPendingDuplicateSessionIds] = useState<string[]>([])
    const [pendingDuplicateHapiSessionIds, setPendingDuplicateHapiSessionIds] = useState<string[]>([])
    const [duplicateSessionGroups, setDuplicateSessionGroups] = useState<CodexDuplicateSessionGroup[]>([])
    const [isDuplicateMergeConfirmOpen, setIsDuplicateMergeConfirmOpen] = useState(false)
    const [isMergingDuplicateSessions, setIsMergingDuplicateSessions] = useState(false)
    const isFormDisabled = Boolean(isCreating || isPending || props.isLoading || isImportingCodexSession || isBulkImportingCodexSessions)
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
        if (
            opencodeSelectedModel !== null
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
        if (preserveRestoredDraftRef.current) {
            return
        }
        setOpencodeSelectedModel(null)
    }, [agent, machineId, deferredDirectory])

    useEffect(() => {
        if (!machineId || preserveRestoredDraftRef.current) {
            return
        }

        const preferred = resolvePreferredLaunchSettings(
            agent,
            loadPreferredLaunchSettings(machineId, agent)
        )

        setModel(agent === 'opencode' ? 'auto' : preferred.model)
        setCursorSelectedBase(preferred.cursorSelectedBase)
        setEffort(preferred.effort)
        setModelReasoningEffort(preferred.modelReasoningEffort)
        setOpencodeSelectedModel(
            agent === 'opencode' && preferred.model !== 'auto' ? preferred.model : null
        )
        setAgySelectedModel(
            agent === 'agy' && preferred.model !== 'auto' ? preferred.model : null
        )
    }, [agent, machineId])

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

    const selectedCodexImportSession = useMemo(
        () => codexImportSessions.find((session) => session.id === selectedCodexImportSessionId) ?? null,
        [codexImportSessions, selectedCodexImportSessionId]
    )

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
                : agent === 'agy'
                    ? (agySelectedModel ?? undefined)
                    : (model !== 'auto' ? model : undefined)
            const resolvedEffort = (agent === 'claude' || agent === 'grok') && effort !== 'auto'
                ? effort
                : undefined
            const resolvedModelReasoningEffort = (agent === 'codex' || agent === 'opencode') && modelReasoningEffort !== 'default'
                ? modelReasoningEffort
                : undefined
            const preferredLaunchSettings = {
                model: agent === 'agy'
                    ? (agySelectedModel ?? 'auto')
                    : agent === 'opencode'
                        ? (opencodeSelectedModel ?? 'auto')
                        : model,
                cursorSelectedBase,
                effort,
                modelReasoningEffort
            }
            const resolvedServiceTier = agent === 'codex' && showCodexFastMode
                ? serviceTier
                : undefined
            const resolvedCollaborationMode = agent === 'codex' && collaborationMode !== 'default'
                ? collaborationMode
                : undefined

            const usesCodexFamilyPermissions = usesCodexFamilyPermissionModes(agent)

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

            const result = await spawnSession({
                machineId,
                directory: trimmedDirectory,
                agent,
                model: resolvedModel,
                effort: resolvedEffort,
                modelReasoningEffort: resolvedModelReasoningEffort,
                yolo: agent === 'grok' || usesCodexFamilyPermissions ? undefined : yoloMode,
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
                startingMode: agent === 'agy' ? 'pty' : undefined
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
    const fastModeSelectionPending = agent === 'codex'
        && serviceTier === 'fast'
        && codexModelsState.isLoading
    const canCreate = Boolean(
        machineId
        && trimmedDirectory
        && !isFormDisabled
        && !missingWorktreeDirectory
        && !isLaunchPreferenceValidationPending
        && !fastModeSelectionPending
    )

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
                onAgentChange={handleAgentChange}
            />
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
            {agent === 'agy' ? (
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
                                : undefined
                        }
                        isDisabled={
                            isFormDisabled
                            || (agent === 'codex' && Boolean(codexModelsState.error))
                            || (agent === 'grok' && Boolean(grokModelsState.error))
                            || (agent === 'copilot' && Boolean(copilotModelsState.error))
                        }
                        isLoading={(agent === 'codex' && codexModelsState.isLoading)
                            || (agent === 'grok' && grokModelsState.isLoading)
                            || (agent === 'copilot' && copilotModelsState.isLoading)}
                        error={agent === 'codex' && codexModelsState.error
                            ? `${t('newSession.model.loadFailed')}: ${codexModelsState.error}`
                            : agent === 'grok' && grokModelsState.error
                                ? `${t('newSession.model.loadFailed')}: ${grokModelsState.error}`
                                : agent === 'copilot' && copilotModelsState.error
                                    ? `${t('newSession.model.loadFailed')}: ${copilotModelsState.error}`
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
            <CodexFamilyPermissionModeSelector
                agent={agent}
                value={codexFamilyPermissionMode}
                isDisabled={isFormDisabled}
                onChange={setCodexFamilyPermissionMode}
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
            {agent !== 'grok' && !usesCodexFamilyPermissionModes(agent) ? (
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
                isPending={isCreating || isPending || isImportingCodexSession}
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
