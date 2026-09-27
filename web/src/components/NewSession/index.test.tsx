import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import type { ApiClient } from '@/api/client'
import type { Machine, PiModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { saveNewSessionFormDraft } from './newSessionFormDraft'
import {
    loadPreferredLaunchSettings,
    savePreferredAgent,
    savePreferredLaunchSettings,
    savePreferredYoloMode
} from './preferences'

const mocks = vi.hoisted(() => ({
    spawnSession: vi.fn(),
    onSuccess: vi.fn(),
    notification: vi.fn(),
    checkPathsExists: vi.fn(),
    availableAgents: [
        'agy', 'claude', 'codex', 'dsh', 'copilot', 'cursor', 'grok', 'kimi', 'opencode', 'pi'
    ].map((agent) => ({ agent, available: true })),
    codexModelsLoading: false,
    agyModelsLoading: false,
    agyModels: [{ modelId: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' }],
    directoryExists: undefined as boolean | undefined,
    copilotModels: [] as Array<{ modelId: string; name?: string }>,
    copilotModelsLoading: false,
    kimiModels: [] as Array<{ modelId: string; name?: string; provider?: string }>,
    kimiModelsLoading: false,
    kimiModelsError: null as string | null,
    opencodeModels: [] as Array<{ modelId: string; name?: string }>,
    opencodeCurrentModelId: null as string | null,
    opencodeModelsLoading: false,
    opencodeVariants: null as Record<string, string[]> | null,
    opencodeVariantsLoading: false,
    opencodeVariantsEnabled: false,
    piDialogSelection: ['pi-native-1'] as string[],
    piModels: [] as PiModelSummary[],
    piModelsLoading: false,
    piModelsError: null as string | null,
    nextModelValue: 'gpt-5.6-terra',
    refetchSessions: vi.fn(),
    addToast: vi.fn()
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('@/lib/toast-context', () => ({
    useToast: () => ({ addToast: mocks.addToast })
}))
vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({ haptic: { notification: mocks.notification } })
}))
vi.mock('@/hooks/mutations/useSpawnSession', () => ({
    useSpawnSession: () => ({
        spawnSession: mocks.spawnSession,
        isPending: false,
        error: null
    })
}))
vi.mock('@/hooks/queries/useSessions', () => ({
    useSessions: () => ({ sessions: [], refetch: mocks.refetchSessions })
}))
vi.mock('@/hooks/useRecentPaths', () => ({
    useRecentPaths: () => ({
        getRecentPaths: () => [],
        addRecentPath: vi.fn(),
        getLastUsedMachineId: () => null,
        setLastUsedMachineId: vi.fn()
    })
}))
vi.mock('@/hooks/useMachinePathsExists', () => ({
    useMachinePathsExists: () => ({
        pathExistence: { 'C:\\repo': mocks.directoryExists },
        outsideWorkspaceRoots: new Set<string>(),
        checkPathsExists: mocks.checkPathsExists
    })
}))
vi.mock('@/hooks/queries/useAgentAvailability', () => ({
    useAgentAvailability: () => ({
        agents: mocks.availableAgents,
        isLoading: false,
        error: null,
        upgradeRequired: false,
        refetch: vi.fn()
    })
}))
vi.mock('@/hooks/useDirectorySuggestions', () => ({
    useDirectorySuggestions: () => []
}))
vi.mock('@/hooks/useActiveSuggestions', () => ({
    useActiveSuggestions: () => [[], -1, vi.fn(), vi.fn(), vi.fn()]
}))
vi.mock('@/hooks/queries/useCodexModels', () => ({
    useCodexModels: () => ({
        models: [
            {
                id: 'gpt-5.6-sol',
                displayName: 'GPT-5.6 Sol',
                isDefault: true,
                supportedReasoningEfforts: ['low', 'high', 'xhigh']
            },
            {
                id: 'gpt-5.6-terra',
                displayName: 'GPT-5.6 Terra',
                isDefault: false,
                supportedReasoningEfforts: ['low', 'high', 'max']
            }
        ],
        isLoading: mocks.codexModelsLoading,
        error: null
    })
}))
vi.mock('@/hooks/queries/useAgyModels', () => ({
    useAgyModels: () => ({
        availableModels: mocks.agyModels,
        currentModelId: null,
        isLoading: mocks.agyModelsLoading,
        error: null,
        refetch: vi.fn()
    })
}))
vi.mock('@/hooks/queries/useCursorModelsForMachine', () => ({
    useCursorModelsForMachine: () => ({
        availableModels: [],
        cliModelSkus: [],
        currentModelId: null,
        isLoading: false,
        error: null,
        refetch: vi.fn()
    })
}))
vi.mock('@/hooks/queries/useOpencodeModelsForCwd', () => ({
    useOpencodeModelsForCwd: () => ({
        availableModels: mocks.opencodeModels,
        currentModelId: mocks.opencodeCurrentModelId,
        isLoading: mocks.opencodeModelsLoading,
        error: null,
        refetch: vi.fn()
    })
}))
vi.mock('@/hooks/queries/useOpencodeModelVariants', () => ({
    useOpencodeModelVariants: (args: { enabled: boolean }) => {
        mocks.opencodeVariantsEnabled = args.enabled
        return {
            variants: mocks.opencodeVariants,
            isLoading: mocks.opencodeVariantsLoading,
            error: null
        }
    }
}))
vi.mock('@/hooks/queries/useGrokModelsForCwd', () => ({
    useGrokModelsForCwd: () => ({
        availableModels: [],
        currentModelId: null,
        autoPermissionModeSupported: null,
        isLoading: false,
        error: null
    })
}))
vi.mock('@/hooks/queries/useCopilotModelsForCwd', () => ({
    useCopilotModelsForCwd: () => ({
        availableModels: mocks.copilotModels,
        currentModelId: null,
        isLoading: mocks.copilotModelsLoading,
        error: null
    })
}))
vi.mock('@/hooks/queries/useKimiModelsForCwd', () => ({
    useKimiModelsForCwd: () => ({
        availableModels: mocks.kimiModels,
        currentModelId: null,
        isLoading: mocks.kimiModelsLoading,
        error: mocks.kimiModelsError
    })
}))
vi.mock('@/hooks/queries/usePiModelsForMachine', () => ({
    usePiModelsForMachine: () => ({
        availableModels: mocks.piModels,
        currentModelId: null,
        isLoading: mocks.piModelsLoading,
        error: mocks.piModelsError
    })
}))
vi.mock('../../utils/formatRunnerSpawnError', () => ({
    formatRunnerSpawnError: () => null
}))
vi.mock('@/components/CodexSessionSyncDialog', () => ({
    CodexSessionSyncDialog: () => null
}))
vi.mock('@/components/PiSessionImportDialog', () => ({
    PiSessionImportDialog: (props: { isOpen: boolean; sessions: Array<{ id: string }>; onClose: () => void; onConfirm: (ids: string[]) => Promise<void> }) => props.isOpen ? (
        <>
            <div data-testid="pi-session-ids">{props.sessions.map((session) => session.id).join(',')}</div>
            <button type="button" data-testid="close-pi-history" onClick={props.onClose}>close pi history</button>
            <button type="button" data-testid="select-pi-history" disabled={props.sessions.length === 0} onClick={() => void props.onConfirm(mocks.piDialogSelection)}>
                select pi history
            </button>
        </>
    ) : null
}))
vi.mock('./DirectorySection', () => ({ DirectorySection: () => null }))
vi.mock('./MachineSelector', () => ({
    MachineSelector: (props: { machines: Machine[]; machineId: string | null; isDisabled: boolean; onChange: (machineId: string) => void }) => (
        <select
            aria-label="machine-selector"
            value={props.machineId ?? ''}
            disabled={props.isDisabled}
            onChange={(event) => props.onChange(event.target.value)}
        >
            {props.machines.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.id}</option>)}
        </select>
    )
}))
vi.mock('./SessionTypeSelector', () => ({ SessionTypeSelector: () => null }))
vi.mock('./PermissionField', () => ({
    PermissionField: (props: {
        agent: string
        nativeValue: string
        yoloMode: boolean
        isDisabled: boolean
        onNativeChange: (mode: string) => void
        onYoloToggle: (value: boolean) => void
    }) => (
        <>
            <button type="button" data-testid="permission-mode" onClick={() => props.onNativeChange('yolo')}>
                {props.nativeValue}
            </button>
            <button type="button" data-testid="permission-mode-plan" onClick={() => props.onNativeChange('plan')}>
                {props.nativeValue}
            </button>
            <button type="button" data-testid="permission-mode-default" onClick={() => props.onNativeChange('default')}>
                {props.nativeValue}
            </button>
            <button type="button" data-testid="yolo-toggle" onClick={() => props.onYoloToggle(!props.yoloMode)}>
                {props.yoloMode ? 'yolo-on' : 'yolo-off'}
            </button>
        </>
    )
}))
vi.mock('./CopilotAgentModeSelector', () => ({ CopilotAgentModeSelector: () => null }))
vi.mock('./OpencodeModelSelector', () => ({
    OpencodeModelSelector: (props: { selectedModel: string | null | undefined; onModelChange: (model: string | null) => void }) => (
        <>
            <button type="button" data-testid="opencode-model-default" onClick={() => props.onModelChange(null)}>default</button>
            <button type="button" data-testid="opencode-model-pick" onClick={() => props.onModelChange('provider/model')}>pick</button>
            <div data-testid="opencode-model">{props.selectedModel ?? 'default'}</div>
        </>
    )
}))
vi.mock('./AgyModelSelector', () => ({
    AgyModelSelector: (props: { selectedModel: string | null; onModelChange: (model: string | null) => void }) => (
        <button type="button" data-testid="agy-model" onClick={() => props.onModelChange('gemini-3.6-flash-low')}>
            {props.selectedModel ?? 'auto'}
        </button>
    )
}))
vi.mock('./EffortField', () => ({
    EffortField: (props: { effort: string; reasoningEffort: string; opencodeVariantOptions?: string[] | null; onReasoningEffortChange: (v: string) => void }) => (
        <>
            <div data-testid="launch-effort">{props.effort}</div>
            <div data-testid="opencode-variants">{props.opencodeVariantOptions?.join(',') ?? 'static'}</div>
            <button type="button" data-testid="reasoning" onClick={() => props.onReasoningEffortChange('max')}>
                {props.reasoningEffort}
            </button>
        </>
    )
}))
vi.mock('./ModelSelector', () => ({
    ModelSelector: (props: {
        model: string
        options?: Array<{ value: string; label: string }>
        onModelChange: (model: string) => void
    }) => (
        <>
            <button type="button" data-testid="model" onClick={() => props.onModelChange(mocks.nextModelValue)}>
                {props.model}
            </button>
            <div data-testid="model-options">{props.options?.map((option) => option.label).join(',')}</div>
        </>
    )
}))
vi.mock('./ActionButtons', () => ({
    ActionButtons: (props: { onCreate: () => void; onChooseFolder?: () => void; canCreate: boolean }) => (
        <>
            <button type="button" data-testid="create" disabled={!props.canCreate} onClick={props.onCreate}>create</button>
            {props.onChooseFolder ? <button type="button" data-testid="browse" onClick={props.onChooseFolder}>browse</button> : null}
        </>
    )
}))

import { NewSession } from './index'

const machine = { id: 'machine-1' } as Machine
const api = {
    getHubSettings: vi.fn().mockResolvedValue({
        sessionSummaryContract: false,
        sessionSummaryInChat: false,
        // Neutral defaults so launch-preference tests control New Session via UI /
        // sticky localStorage (bypassPermissions here would seed YOLO and skew asserts).
        peerSpawnDefaults: {
            agent: 'claude',
            permissionMode: 'default',
            models: { claude: 'sonnet' }
        }
    })
} as unknown as ApiClient

function renderWithQuery(ui: ReactElement) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // Pre-seed hub settings so useQuery is warm on first paint — a late resolve
    // re-runs the preferred-launch effect and can wipe an in-test model pick.
    client.setQueryData(queryKeys.hubSettings, {
        sessionSummaryContract: false,
        sessionSummaryInChat: false,
        peerSpawnDefaults: {
            agent: 'claude',
            permissionMode: 'default',
            models: { claude: 'sonnet' }
        }
    })
    const wrap = (node: ReactElement) => (
        <QueryClientProvider client={client}>{node}</QueryClientProvider>
    )
    const result = render(wrap(ui))
    return {
        ...result,
        rerender: (node: ReactElement) => result.rerender(wrap(node))
    }
}

describe('NewSession launch preferences', () => {
    beforeEach(() => {
        localStorage.clear()
        sessionStorage.clear()
        mocks.spawnSession.mockReset()
        mocks.onSuccess.mockReset()
        mocks.notification.mockReset()
        mocks.checkPathsExists.mockReset()
        mocks.checkPathsExists.mockImplementation(async () => ({
            exists: { 'C:\\repo': mocks.directoryExists }
        }))
        mocks.availableAgents.splice(
            0,
            mocks.availableAgents.length,
            ...['agy', 'claude', 'codex', 'dsh', 'copilot', 'cursor', 'grok', 'kimi', 'opencode', 'pi']
                .map((agent) => ({ agent, available: true }))
        )
        mocks.codexModelsLoading = false
        mocks.agyModelsLoading = false
        mocks.agyModels = [{ modelId: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' }]
        mocks.directoryExists = true
        mocks.copilotModels = []
        mocks.copilotModelsLoading = false
        mocks.kimiModels = []
        mocks.kimiModelsLoading = false
        mocks.kimiModelsError = null
        mocks.opencodeModels = [{ modelId: 'provider/current', name: 'Current' }]
        mocks.opencodeCurrentModelId = 'provider/current'
        mocks.opencodeModelsLoading = false
        mocks.opencodeVariants = null
        mocks.opencodeVariantsLoading = false
        mocks.opencodeVariantsEnabled = false
        mocks.piDialogSelection = ['pi-native-1']
        mocks.piModels = []
        mocks.piModelsLoading = false
        mocks.piModelsError = null
        mocks.nextModelValue = 'gpt-5.6-terra'
        mocks.refetchSessions.mockReset()
        mocks.refetchSessions.mockResolvedValue(undefined)
        mocks.addToast.mockReset()
        savePreferredAgent('codex')
    })

    it('hides unavailable Agents and falls back to the first available Agent', async () => {
        savePreferredAgent('claude')
        mocks.availableAgents.splice(
            0,
            mocks.availableAgents.length,
            { agent: 'codex', available: true }
        )

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => expect(screen.getByDisplayValue('codex')).toBeChecked())
        expect(screen.queryByDisplayValue('claude')).not.toBeInTheDocument()
    })

    it('refuses a directory rejected by workspace-root validation', async () => {
        mocks.checkPathsExists.mockImplementation(async ([path]: string[]) => ({
            exists: { [path]: false },
            outsideWorkspaceRoots: [path]
        }))
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'unexpected' })

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(screen.getByText('newSession.directoryOutsideWorkspaceRoots')).toBeInTheDocument())
        expect(mocks.spawnSession).not.toHaveBeenCalled()
    })

    it('restores the last successful model and reasoning effort for the machine and agent', async () => {
        savePreferredLaunchSettings('machine-1', 'codex', {
            model: 'gpt-5.6-sol',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'xhigh',
            permissionMode: 'safe-yolo'
        })

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('model')).toHaveTextContent('gpt-5.6-sol')
            expect(screen.getByTestId('reasoning')).toHaveTextContent('xhigh')
            expect(screen.getByTestId('permission-mode')).toHaveTextContent('default')
        })
    })

    it('does not migrate a legacy YOLO value owned by a non-Codex agent', async () => {
        savePreferredAgent('claude')
        savePreferredYoloMode(true)

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByDisplayValue('codex'))

        await waitFor(() => {
            expect(screen.getByTestId('permission-mode')).toHaveTextContent('default')
        })
    })

    it('migrates a legacy YOLO value when Codex was the preferred agent', async () => {
        savePreferredAgent('codex')
        savePreferredYoloMode(true)

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('permission-mode')).toHaveTextContent('yolo')
        })
    })

    it('shows discovered Copilot models for the selected directory', async () => {
        mocks.copilotModels = [
            { modelId: 'gpt-5.6', name: 'GPT-5.6' },
            { modelId: 'auto', name: 'Auto' }
        ]

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByLabelText('Copilot'))

        await waitFor(() => {
            expect(screen.getByTestId('model-options')).toHaveTextContent('Auto,GPT-5.6')
        })
    })

    it('disables creation while a remembered Copilot model is being validated', async () => {
        mocks.copilotModelsLoading = true
        savePreferredAgent('copilot')
        savePreferredLaunchSettings('machine-1', 'copilot', {
            model: 'gpt-5.6',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'default'
        })

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => expect(screen.getByTestId('create')).toBeDisabled())
    })

    it('shows dynamic Kimi models with Default for the selected directory', async () => {
        mocks.kimiModels = [
            { modelId: 'GLM-5.3-flash', name: 'thehive / GLM-5.3-flash', provider: 'thehive' },
            { modelId: 'deepseek-v4.1-flash', name: 'thehive / hive-deepseek', provider: 'thehive' },
            { modelId: 'hyper-glm-5.3-flash', name: 'charm-hyper / Hyper · GLM-5.3-Flash', provider: 'charm-hyper' },
            { modelId: 'openrouter-union-alpha', provider: 'openrouter' }
        ]

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory={'C:\\repo'}
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByDisplayValue('kimi'))

        await waitFor(() => {
            expect(screen.getByTestId('model-options')).toHaveTextContent(
                'Default,thehive — thehive / GLM-5.3-flash,thehive — thehive / hive-deepseek,charm-hyper — charm-hyper / Hyper · GLM-5.3-Flash,openrouter — openrouter-union-alpha'
            )
        })
    })

    it('restores a remembered Kimi alias instead of resetting it to Default', async () => {
        mocks.kimiModels = [
            { modelId: 'GLM-5.3-flash', provider: 'thehive' }
        ]
        savePreferredAgent('kimi')
        savePreferredLaunchSettings('machine-1', 'kimi', {
            model: 'GLM-5.3-flash',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'default'
        })

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory={'C:\\repo'}
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('model')).toHaveTextContent('GLM-5.3-flash')
            expect(screen.getByTestId('create')).toBeEnabled()
        })
    })

    it('resets a remembered Kimi alias that the dynamic catalog no longer lists', async () => {
        mocks.kimiModels = [
            { modelId: 'GLM-5.3-flash', provider: 'thehive' }
        ]
        savePreferredAgent('kimi')
        savePreferredLaunchSettings('machine-1', 'kimi', {
            model: 'retired-alias',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'default'
        })

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory={'C:\\repo'}
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('model')).toHaveTextContent('auto')
        })
        expect(screen.getByTestId('create')).toBeEnabled()
    })

    it.each([
        ['model', 'gpt-5.6-sol', 'default'],
        ['reasoning effort', 'auto', 'xhigh']
    ])('disables creation while a remembered dynamic %s is being validated', async (
        _setting,
        model,
        modelReasoningEffort
    ) => {
        mocks.codexModelsLoading = true
        savePreferredLaunchSettings('machine-1', 'codex', {
            model,
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort
        })

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => expect(screen.getByTestId('create')).toBeDisabled())
    })

    it.each([
        ['grok', {
            model: 'grok-4',
            cursorSelectedBase: 'auto',
            effort: 'high',
            modelReasoningEffort: 'default'
        }],
        ['opencode', {
            model: 'provider/model',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'high'
        }]
    ] as const)('disables creation while %s cwd existence is unresolved', async (
        agent,
        settings
    ) => {
        mocks.directoryExists = undefined
        savePreferredAgent(agent)
        savePreferredLaunchSettings('machine-1', agent, settings)

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => expect(screen.getByTestId('create')).toBeDisabled())
    })

    it('saves changed launch settings only after creation succeeds', async () => {
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'session-1' })

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        expect(loadPreferredLaunchSettings('machine-1', 'codex')).toBeNull()
        fireEvent.click(screen.getByTestId('model'))
        fireEvent.click(screen.getByTestId('reasoning'))
        fireEvent.click(screen.getByTestId('permission-mode'))
        expect(loadPreferredLaunchSettings('machine-1', 'codex')).toBeNull()
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'yolo' }))
        expect(loadPreferredLaunchSettings('machine-1', 'codex')).toEqual({
            model: 'gpt-5.6-terra',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'max',
            permissionMode: 'yolo'
        })
    })

    it('restores the AGY model from a browse-return draft', async () => {
        savePreferredAgent('agy')
        saveNewSessionFormDraft({
            agent: 'agy', model: 'gemini-3.6-flash-low', cursorSelectedBase: 'auto', machineId: 'machine-1',
            effort: 'auto', modelReasoningEffort: 'default', serviceTier: 'standard', collaborationMode: 'default',
            copilotAgentMode: 'interactive', yoloMode: false, nativePermissionMode: 'default',
            grokPermissionMode: 'default', sessionType: 'simple', worktreeName: ''
        })
        renderWithQuery(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('gemini-3.6-flash-low'))
    })

    it('falls back to Default when a browse-return AGY model is no longer advertised', async () => {
        savePreferredAgent('agy')
        saveNewSessionFormDraft({
            agent: 'agy', model: 'removed-model', cursorSelectedBase: 'auto', machineId: 'machine-1',
            effort: 'auto', modelReasoningEffort: 'default', serviceTier: 'standard', collaborationMode: 'default',
            copilotAgentMode: 'interactive', yoloMode: false, nativePermissionMode: 'default',
            grokPermissionMode: 'default', sessionType: 'simple', worktreeName: ''
        })
        renderWithQuery(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('auto'))
    })

    it('keeps an AGY model the user picked here when the machine catalog changes under the form', async () => {
        // The machine refreshes its catalog in the background, so the list can
        // change while the form is open. A model the user chose is theirs to
        // keep — unlike a restored one, which the two tests above drop.
        savePreferredAgent('agy')
        const view = renderWithQuery(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        fireEvent.click(screen.getByTestId('agy-model'))
        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('gemini-3.6-flash-low'))

        mocks.agyModels = [{ modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' }]
        view.rerender(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('gemini-3.6-flash-low'))
    })

    it('falls back to Default when a preferred AGY model is no longer advertised', async () => {
        savePreferredAgent('agy')
        savePreferredLaunchSettings('machine-1', 'agy', { model: 'removed-model', cursorSelectedBase: 'auto', effort: 'auto', modelReasoningEffort: 'default' })
        renderWithQuery(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('auto'))
    })

    it('blocks Create while a remembered AGY model is awaiting catalog validation', async () => {
        savePreferredAgent('agy')
        savePreferredLaunchSettings('machine-1', 'agy', { model: 'gemini-3.6-flash-low', cursorSelectedBase: 'auto', effort: 'auto', modelReasoningEffort: 'default' })
        mocks.agyModelsLoading = true
        renderWithQuery(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('create')).toBeDisabled())
    })

    it('does not forward the global YOLO preference to managed DSH ACP', async () => {
        savePreferredAgent('dsh')
        savePreferredYoloMode(true)
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'dsh-session' })
        renderWithQuery(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('dsh-session'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'dsh',
            yolo: undefined,
            permissionMode: undefined
        }))
    })

    it('lets Claude create with a chosen permission mode instead of the global YOLO toggle', async () => {
        savePreferredAgent('claude')
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'claude-session' })
        renderWithQuery(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        fireEvent.click(screen.getByTestId('permission-mode-plan'))
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('claude-session'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'claude',
            yolo: undefined,
            permissionMode: 'plan'
        }))
    })

    it('does not carry a permission mode picked under another flavor into the Claude spawn payload', async () => {
        savePreferredAgent('codex')
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'claude-session' })
        renderWithQuery(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        // Starts as codex; picking the mocked native-select button sets the
        // shared nativePermissionMode state to 'yolo', a value 'claude' does
        // not carry in its own permission catalog.
        await waitFor(() => expect(screen.getByDisplayValue('codex')).toBeChecked())
        fireEvent.click(screen.getByTestId('permission-mode'))
        fireEvent.click(screen.getByDisplayValue('claude'))
        await waitFor(() => expect(screen.getByDisplayValue('claude')).toBeChecked())
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('claude-session'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'claude',
            permissionMode: 'default'
        }))
    })

    it('migrates a legacy YOLO value owned by Claude to bypassPermissions', async () => {
        savePreferredAgent('claude')
        savePreferredYoloMode(true)

        renderWithQuery(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        await waitFor(() => {
            expect(screen.getByTestId('permission-mode')).toHaveTextContent('bypassPermissions')
        })
    })

    it('does not preselect bypassPermissions for Claude from a legacy YOLO value owned by another flavor', async () => {
        // hapi:newSession:yolo is a flavor-agnostic global key. The legacyYoloAgent
        // snapshot (captured once at mount, see index.tsx) is what stops a YOLO
        // toggle left on under cursor from silently preselecting bypassPermissions
        // the next time Claude is picked.
        savePreferredAgent('cursor')
        savePreferredYoloMode(true)

        renderWithQuery(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        await waitFor(() => expect(screen.getByDisplayValue('cursor')).toBeChecked())
        fireEvent.click(screen.getByDisplayValue('claude'))

        await waitFor(() => {
            expect(screen.getByTestId('permission-mode')).toHaveTextContent('default')
        })
    })

    it('keeps an explicit OpenCode Default selection instead of restoring a concrete model', async () => {
        savePreferredAgent('opencode')
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'opencode-session' })
        renderWithQuery(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        // The catalog advertises a concrete default; the user picks Default.
        fireEvent.click(screen.getByTestId('opencode-model-default'))
        await waitFor(() => expect(screen.getByTestId('opencode-model')).toHaveTextContent('default'))
        await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('opencode-session'))
        // Spawn omits model and the explicit Default choice sticks.
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ agent: 'opencode', model: undefined }))
        expect(screen.getByTestId('opencode-model')).toHaveTextContent('default')
    })

    it('uses the probed current model variants for an explicit OpenCode Default selection', async () => {
        savePreferredAgent('opencode')
        mocks.opencodeVariants = { 'provider/current': ['low', 'high'] }
        renderWithQuery(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        fireEvent.click(screen.getByTestId('opencode-model-default'))
        await waitFor(() => expect(screen.getByTestId('opencode-variants')).toHaveTextContent('low,high'))
        expect(mocks.opencodeVariantsEnabled).toBe(true)
    })

    it('waits for OpenCode variants before launching a non-default effort', async () => {
        savePreferredAgent('opencode')
        mocks.opencodeVariantsLoading = true
        const view = renderWithQuery(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        fireEvent.click(screen.getByTestId('reasoning'))
        expect(screen.getByTestId('create')).toBeDisabled()

        mocks.opencodeVariantsLoading = false
        mocks.opencodeVariants = { 'provider/current': ['max'] }
        view.rerender(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
    })

    it('does not probe OpenCode variants until the working directory is verified', () => {
        savePreferredAgent('opencode')
        mocks.directoryExists = undefined
        renderWithQuery(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)

        expect(mocks.opencodeVariantsEnabled).toBe(false)
    })

    it('restores a remembered OpenCode model when it is still advertised', async () => {
        savePreferredAgent('opencode')
        savePreferredLaunchSettings('machine-1', 'opencode', { model: 'provider/model', cursorSelectedBase: 'auto', effort: 'auto', modelReasoningEffort: 'high' })
        mocks.opencodeModels = [{ modelId: 'provider/model', name: 'Model' }]
        renderWithQuery(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('opencode-model')).toHaveTextContent('provider/model'))
    })

    it('persists the selected AGY model only after a successful launch', async () => {
        savePreferredAgent('agy')
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'agy-session' })
        renderWithQuery(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        fireEvent.click(screen.getByTestId('agy-model'))
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('agy-session'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ agent: 'agy', model: 'gemini-3.6-flash-low' }))
        expect(loadPreferredLaunchSettings('machine-1', 'agy')?.model).toBe('gemini-3.6-flash-low')
    })

    it('does not overwrite AGY model preference after a failed launch', async () => {
        savePreferredAgent('agy')
        savePreferredLaunchSettings('machine-1', 'agy', { model: 'gemini-3.5-flash-low', cursorSelectedBase: 'auto', effort: 'auto', modelReasoningEffort: 'default' })
        mocks.agyModels = [
            { modelId: 'gemini-3.5-flash-low', name: 'Gemini 3.5 Flash (Low)' },
            { modelId: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' }
        ]
        mocks.spawnSession.mockResolvedValue({ type: 'error', message: 'spawn failed' })
        renderWithQuery(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('gemini-3.5-flash-low'))
        fireEvent.click(screen.getByTestId('agy-model'))
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.notification).toHaveBeenCalledWith('error'))
        expect(loadPreferredLaunchSettings('machine-1', 'agy')?.model).toBe('gemini-3.5-flash-low')
    })

    it('spawns only once when Create is activated twice during directory validation', async () => {
        let finishDirectoryCheck!: (result: { exists: Record<string, boolean> }) => void
        mocks.checkPathsExists.mockReturnValue(new Promise((resolve) => {
            finishDirectoryCheck = resolve
        }))
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'session-1' })

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        const create = screen.getByTestId('create')
        fireEvent.click(create)
        fireEvent.click(create)
        finishDirectoryCheck({ exists: { 'C:\\repo': true } })

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(mocks.checkPathsExists).toHaveBeenCalledTimes(1)
        expect(mocks.spawnSession).toHaveBeenCalledTimes(1)
    })

    it('imports the selected Pi history and resumes the canonical HAPI session', async () => {
        savePreferredAgent('pi')
        const piApi = {
            getPiSessions: vi.fn().mockResolvedValue({
                success: true,
                machineId: 'machine-1',
                sessions: [{
                    id: 'pi-native-1',
                    title: 'Existing Pi session',
                    cwd: 'C:\\repo',
                    file: 'C:\\pi-native-1.jsonl',
                    modifiedAt: 1,
                    messageCount: 2
                }]
            }),
            importPiSessions: vi.fn().mockResolvedValue({
                success: true,
                machineId: 'machine-1',
                results: [{ piSessionId: 'pi-native-1', hapiSessionId: 'hapi-imported-1', action: 'created', appended: 2 }]
            }),
            reopenSession: vi.fn().mockResolvedValue({ ok: true, sessionId: 'hapi-imported-1', resumed: true })
        } as unknown as ApiClient

        renderWithQuery(
            <NewSession
                api={piApi}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'piImport.inline.choose' }))
        await waitFor(() => expect(screen.getByTestId('select-pi-history')).toBeEnabled())
        fireEvent.click(screen.getByTestId('select-pi-history'))
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('hapi-imported-1'))
        expect(piApi.importPiSessions).toHaveBeenCalledWith({
            sessionIds: ['pi-native-1'],
            cwd: 'C:\\repo',
            machineId: 'machine-1'
        })
        expect(piApi.reopenSession).toHaveBeenCalledWith('hapi-imported-1')
        expect(mocks.spawnSession).not.toHaveBeenCalled()
    })

    it('discards a stale Pi scan after switching machines', async () => {
        savePreferredAgent('pi')
        mocks.piDialogSelection = ['pi-machine-b']
        const machineA = { id: 'machine-a' } as Machine
        const machineB = { id: 'machine-b' } as Machine
        let resolveMachineA!: (value: Awaited<ReturnType<ApiClient['getPiSessions']>>) => void
        let resolveMachineB!: (value: Awaited<ReturnType<ApiClient['getPiSessions']>>) => void
        const machineAScan = new Promise<Awaited<ReturnType<ApiClient['getPiSessions']>>>((resolve) => {
            resolveMachineA = resolve
        })
        const machineBScan = new Promise<Awaited<ReturnType<ApiClient['getPiSessions']>>>((resolve) => {
            resolveMachineB = resolve
        })
        const piApi = {
            getPiSessions: vi.fn((_cwd: string | null, selectedMachineId: string) => (
                selectedMachineId === machineA.id ? machineAScan : machineBScan
            )),
            importPiSessions: vi.fn().mockResolvedValue({
                success: true,
                machineId: machineB.id,
                results: [{ piSessionId: 'pi-machine-b', hapiSessionId: 'hapi-machine-b', action: 'created', appended: 1 }]
            }),
            reopenSession: vi.fn().mockResolvedValue({ ok: true, sessionId: 'hapi-machine-b', resumed: true })
        } as unknown as ApiClient

        renderWithQuery(
            <NewSession
                api={piApi}
                machines={[machineA, machineB]}
                initialMachineId={machineA.id}
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'piImport.inline.choose' }))
        fireEvent.click(screen.getByTestId('close-pi-history'))
        fireEvent.change(screen.getByLabelText('machine-selector'), { target: { value: machineB.id } })
        fireEvent.click(screen.getByRole('button', { name: 'piImport.inline.choose' }))
        await act(async () => {
            resolveMachineB({
                success: true,
                machineId: machineB.id,
                sessions: [{ id: 'pi-machine-b', title: 'Machine B', cwd: 'C:\\repo', file: 'B.jsonl', modifiedAt: 2, messageCount: 1 }]
            })
            await machineBScan
        })
        await waitFor(() => expect(screen.getByTestId('pi-session-ids')).toHaveTextContent('pi-machine-b'))

        await act(async () => {
            resolveMachineA({
                success: true,
                machineId: machineA.id,
                sessions: [{ id: 'pi-machine-a', title: 'Machine A', cwd: 'C:\\repo', file: 'A.jsonl', modifiedAt: 1, messageCount: 1 }]
            })
            await machineAScan
        })
        expect(screen.getByTestId('pi-session-ids')).toHaveTextContent('pi-machine-b')
        expect(screen.getByTestId('pi-session-ids')).not.toHaveTextContent('pi-machine-a')

        fireEvent.click(screen.getByTestId('select-pi-history'))
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('hapi-machine-b'))
        expect(piApi.importPiSessions).toHaveBeenCalledWith({
            sessionIds: ['pi-machine-b'],
            cwd: 'C:\\repo',
            machineId: machineB.id
        })
    })

    it('refreshes successful Pi imports even when another batch item fails', async () => {
        savePreferredAgent('pi')
        mocks.piDialogSelection = ['pi-native-1', 'pi-native-2']
        const piApi = {
            getPiSessions: vi.fn().mockResolvedValue({
                success: true,
                machineId: 'machine-1',
                sessions: [1, 2].map((index) => ({
                    id: `pi-native-${index}`,
                    title: `Pi ${index}`,
                    cwd: 'C:\\repo',
                    file: `C:\\pi-${index}.jsonl`,
                    modifiedAt: index,
                    messageCount: 1
                }))
            }),
            importPiSessions: vi.fn().mockResolvedValue({
                success: false,
                machineId: 'machine-1',
                results: [
                    { piSessionId: 'pi-native-1', hapiSessionId: 'hapi-1', action: 'created', appended: 1 },
                    { piSessionId: 'pi-native-2', hapiSessionId: 'hapi-2', error: { code: 'session_active', message: 'active' } }
                ]
            })
        } as unknown as ApiClient

        renderWithQuery(
            <NewSession
                api={piApi}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'piImport.inline.choose' }))
        await waitFor(() => expect(screen.getByTestId('select-pi-history')).toBeEnabled())
        fireEvent.click(screen.getByTestId('select-pi-history'))

        await waitFor(() => expect(mocks.refetchSessions).toHaveBeenCalled())
        expect(piApi.getPiSessions).toHaveBeenCalledTimes(2)
        expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({
            title: 'piImport.success.title',
            body: 'piImport.success.body'
        }))
        expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'piImport.failed.title' }))
    })

    it('does not save changed launch settings when creation fails', async () => {
        mocks.spawnSession.mockResolvedValue({ type: 'error', message: 'spawn failed' })

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        fireEvent.click(screen.getByTestId('model'))
        fireEvent.click(screen.getByTestId('reasoning'))
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.notification).toHaveBeenCalledWith('error'))
        expect(mocks.onSuccess).not.toHaveBeenCalled()
        expect(loadPreferredLaunchSettings('machine-1', 'codex')).toBeNull()
    })

    it('keeps the browse-return draft ahead of the saved launch preference', async () => {
        savePreferredAgent('claude')
        savePreferredLaunchSettings('machine-1', 'codex', {
            model: 'gpt-5.6-sol',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'xhigh'
        })
        saveNewSessionFormDraft({
            agent: 'codex',
            model: 'gpt-5.6-terra',
            cursorSelectedBase: 'auto',
            machineId: 'machine-1',
            effort: 'auto',
            modelReasoningEffort: 'max',
            serviceTier: 'standard',
            collaborationMode: 'default',
            copilotAgentMode: 'interactive',
            yoloMode: false,
            nativePermissionMode: 'default',
            grokPermissionMode: 'default',
            sessionType: 'simple',
            worktreeName: ''
        })

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('model')).toHaveTextContent('gpt-5.6-terra')
            expect(screen.getByTestId('reasoning')).toHaveTextContent('max')
        })
    })

    it('resets a restored Pi model that left the machine catalog', async () => {
        savePreferredAgent('pi')
        mocks.piModels = [
            { provider: 'openai-codex', modelId: 'gpt-5.6-sol' },
        ]
        savePreferredLaunchSettings('machine-1', 'pi', {
            model: 'openai-codex/stale-model',
            cursorSelectedBase: 'auto',
            effort: 'high',
            modelReasoningEffort: 'default',
        })

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('model')).toHaveTextContent('auto')
            expect(screen.getByTestId('launch-effort')).toHaveTextContent('auto')
        })
    })

    it('resets a restored effort the Default Pi selection cannot offer', async () => {
        savePreferredAgent('pi')
        mocks.piModels = [
            {
                provider: 'openai-codex',
                modelId: 'gpt-5.6-sol',
                reasoning: true,
                thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
            },
        ]
        // Default model (auto) renders the effort field without a map, which
        // hides xhigh — the restored hidden level must not survive into create.
        savePreferredLaunchSettings('machine-1', 'pi', {
            model: 'auto',
            cursorSelectedBase: 'auto',
            effort: 'xhigh',
            modelReasoningEffort: 'default',
        })

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('launch-effort')).toHaveTextContent('auto')
        })
    })

    it('keeps a restored xhigh effort when the selected model map opts in', async () => {
        savePreferredAgent('pi')
        mocks.piModels = [
            {
                provider: 'openai-codex',
                modelId: 'gpt-5.6-sol',
                reasoning: true,
                thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
            },
        ]
        savePreferredLaunchSettings('machine-1', 'pi', {
            model: 'openai-codex/gpt-5.6-sol',
            cursorSelectedBase: 'auto',
            effort: 'xhigh',
            modelReasoningEffort: 'default',
        })

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('model')).toHaveTextContent('openai-codex/gpt-5.6-sol')
            expect(screen.getByTestId('launch-effort')).toHaveTextContent('xhigh')
        })
    })

    it('does not submit a hidden restored effort when Pi model discovery fails', async () => {
        savePreferredAgent('pi')
        // A failed catalog never resolves the restored model, so the effort
        // field renders with an undefined map and hides xhigh. Creation is not
        // blocked on error (only on loading), so the hidden level must have
        // been reconciled away rather than forwarded.
        mocks.piModels = []
        mocks.piModelsError = 'probe failed'
        savePreferredLaunchSettings('machine-1', 'pi', {
            model: 'openai-codex/gpt-5.6-sol',
            cursorSelectedBase: 'auto',
            effort: 'xhigh',
            modelReasoningEffort: 'default',
        })

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('launch-effort')).toHaveTextContent('auto')
        })

        act(() => {
            mocks.spawnSession.mockImplementation(async () => ({ type: 'success', sessionId: 'session-1' }))
        })
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'pi',
            effort: undefined,
        }))
    })

    it('shows Pi machine models and thinking-level effort and forwards both on create', async () => {
        savePreferredAgent('pi')
        mocks.piModels = [
            { provider: 'openai-codex', modelId: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
            { provider: 'opencode-go', modelId: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        ]

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            // Provider-qualified options surfaced through the unified ModelSelector.
            expect(screen.getByTestId('model-options')).toHaveTextContent('GPT-5.6 Sol')
            expect(screen.getByTestId('model-options')).toHaveTextContent('DeepSeek V4 Pro')
        })

        // Select the second provider's model and a thinking level.
        act(() => {
            mocks.spawnSession.mockImplementation(async () => ({ type: 'success', sessionId: 'session-1' }))
        })
        mocks.nextModelValue = 'opencode-go/deepseek-v4-pro'
        fireEvent.click(screen.getByTestId('model'))
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'pi',
            model: 'opencode-go/deepseek-v4-pro',
        }))
    })

    it('seeds Codex hub defaults on a fresh browser before sticky keys are written', async () => {
        localStorage.clear()
        let resolveSettings!: (value: unknown) => void
        const deferred = new Promise((resolve) => {
            resolveSettings = resolve
        })
        const slowApi = {
            getHubSettings: vi.fn(() => deferred)
        } as unknown as ApiClient

        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={client}>
                <NewSession
                    api={slowApi}
                    machines={[machine]}
                    initialMachineId="machine-1"
                    initialDirectory="C:\\repo"
                    onSuccess={mocks.onSuccess}
                    onCancel={() => {}}
                />
            </QueryClientProvider>
        )

        expect(screen.getByTestId('create')).toBeDisabled()

        await act(async () => {
            resolveSettings({
                sessionSummaryContract: false,
                sessionSummaryInChat: false,
                peerSpawnDefaults: {
                    agent: 'codex',
                    permissionMode: 'read-only',
                    models: { codex: 'gpt-5' }
                }
            })
            await deferred
        })

        await waitFor(() => {
            expect(screen.getByTestId('permission-mode')).toHaveTextContent('read-only')
        })
        expect(screen.getByTestId('create')).not.toBeDisabled()
    })

    it('keeps Create disabled while getHubSettings is pending', async () => {
        localStorage.clear()
        const deferred = new Promise(() => {})
        const slowApi = {
            getHubSettings: vi.fn(() => deferred)
        } as unknown as ApiClient

        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={client}>
                <NewSession
                    api={slowApi}
                    machines={[machine]}
                    initialMachineId="machine-1"
                    initialDirectory="C:\\repo"
                    onSuccess={mocks.onSuccess}
                    onCancel={() => {}}
                />
            </QueryClientProvider>
        )

        expect(screen.getByTestId('create')).toBeDisabled()
        fireEvent.click(screen.getByTestId('create'))
        expect(mocks.spawnSession).not.toHaveBeenCalled()
    })

    it('keeps an explicit Default permission when hub settings resolve after the edit', async () => {
        localStorage.clear()
        let resolveSettings!: (value: unknown) => void
        const deferred = new Promise((resolve) => {
            resolveSettings = resolve
        })
        const slowApi = {
            getHubSettings: vi.fn(() => deferred)
        } as unknown as ApiClient

        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={client}>
                <NewSession
                    api={slowApi}
                    machines={[machine]}
                    initialMachineId="machine-1"
                    initialDirectory="C:\\repo"
                    onSuccess={mocks.onSuccess}
                    onCancel={() => {}}
                />
            </QueryClientProvider>
        )

        // Explicit Default (same value as mount default) must still count as an edit.
        fireEvent.click(screen.getByTestId('permission-mode-default'))
        expect(screen.getByTestId('permission-mode')).toHaveTextContent('default')

        await act(async () => {
            resolveSettings({
                sessionSummaryContract: false,
                sessionSummaryInChat: false,
                peerSpawnDefaults: {
                    agent: 'claude',
                    permissionMode: 'bypassPermissions',
                    models: { claude: 'sonnet' }
                }
            })
            await deferred
        })

        await waitFor(() => {
            expect(screen.getByTestId('permission-mode')).toHaveTextContent('default')
        })
    })

    it('keeps Cursor Plan when hub settings resolve late with a different agent default', async () => {
        localStorage.clear()
        let resolveSettings!: (value: unknown) => void
        const deferred = new Promise((resolve) => {
            resolveSettings = resolve
        })
        const slowApi = {
            getHubSettings: vi.fn(() => deferred)
        } as unknown as ApiClient

        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={client}>
                <NewSession
                    api={slowApi}
                    machines={[machine]}
                    initialMachineId="machine-1"
                    initialDirectory="C:\\repo"
                    onSuccess={mocks.onSuccess}
                    onCancel={() => {}}
                />
            </QueryClientProvider>
        )

        fireEvent.click(screen.getByDisplayValue('cursor'))
        fireEvent.click(screen.getByTestId('permission-mode-plan'))
        expect(screen.getByTestId('permission-mode')).toHaveTextContent('plan')

        await act(async () => {
            resolveSettings({
                sessionSummaryContract: false,
                sessionSummaryInChat: false,
                peerSpawnDefaults: {
                    agent: 'codex',
                    permissionMode: 'yolo',
                    models: { codex: 'gpt-5' }
                }
            })
            await deferred
        })

        await waitFor(() => {
            expect(screen.getByTestId('permission-mode')).toHaveTextContent('plan')
        })

        act(() => {
            mocks.spawnSession.mockImplementation(async () => ({ type: 'success', sessionId: 'session-1' }))
        })
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'cursor',
            permissionMode: 'plan'
        }))
    })

    it('seeds Grok Plan from delayed hub defaults after agent initialization', async () => {
        localStorage.clear()
        let resolveSettings!: (value: unknown) => void
        const deferred = new Promise((resolve) => {
            resolveSettings = resolve
        })
        const slowApi = {
            getHubSettings: vi.fn(() => deferred)
        } as unknown as ApiClient

        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={client}>
                <NewSession
                    api={slowApi}
                    machines={[machine]}
                    initialMachineId="machine-1"
                    initialDirectory="C:\\repo"
                    onSuccess={mocks.onSuccess}
                    onCancel={() => {}}
                />
            </QueryClientProvider>
        )

        await act(async () => {
            resolveSettings({
                sessionSummaryContract: false,
                sessionSummaryInChat: false,
                peerSpawnDefaults: {
                    agent: 'grok',
                    permissionMode: 'plan',
                    models: {}
                }
            })
            await deferred
        })

        await waitFor(() => {
            expect(screen.getByTestId('permission-mode')).toHaveTextContent('plan')
        })

        act(() => {
            mocks.spawnSession.mockImplementation(async () => ({ type: 'success', sessionId: 'session-1' }))
        })
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'grok',
            permissionMode: 'plan'
        }))
    })

    it('applies delayed hub permission with a sticky agent and no launch prefs', async () => {
        localStorage.clear()
        savePreferredAgent('codex')
        let resolveSettings!: (value: unknown) => void
        const deferred = new Promise((resolve) => {
            resolveSettings = resolve
        })
        const slowApi = {
            getHubSettings: vi.fn(() => deferred)
        } as unknown as ApiClient

        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={client}>
                <NewSession
                    api={slowApi}
                    machines={[machine]}
                    initialMachineId="machine-1"
                    initialDirectory="C:\\repo"
                    onSuccess={mocks.onSuccess}
                    onCancel={() => {}}
                />
            </QueryClientProvider>
        )

        expect(screen.getByTestId('permission-mode')).toHaveTextContent('default')

        await act(async () => {
            resolveSettings({
                sessionSummaryContract: false,
                sessionSummaryInChat: false,
                peerSpawnDefaults: {
                    agent: 'claude',
                    permissionMode: 'read-only',
                    models: { claude: 'sonnet' }
                }
            })
            await deferred
        })

        await waitFor(() => {
            expect(screen.getByTestId('permission-mode')).toHaveTextContent('read-only')
        })
        expect(screen.getByDisplayValue('codex')).toBeChecked()
    })

    it('preserves a saved Default model over a cached hub model', async () => {
        localStorage.clear()
        savePreferredAgent('claude')
        savePreferredLaunchSettings('machine-1', 'claude', {
            model: 'auto',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'default',
            permissionMode: 'default'
        })
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'session-1' })

        renderWithQuery(
            <NewSession
                api={api}
                machines={[machine]}
                initialMachineId="machine-1"
                initialDirectory="C:\\repo"
                onSuccess={mocks.onSuccess}
                onCancel={() => {}}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('model')).toHaveTextContent('auto')
        })
        await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'claude'
        }))
        expect(mocks.spawnSession.mock.calls[0]![0].model).toBeUndefined()
    })

    it('seeds OpenCode model state from hub when no launch preference exists', async () => {
        localStorage.clear()
        mocks.opencodeModels = [
            { modelId: 'provider/hub-model', name: 'Hub' },
            { modelId: 'provider/current', name: 'Current' }
        ]
        mocks.opencodeCurrentModelId = 'provider/current'
        const hubApi = {
            getHubSettings: vi.fn().mockResolvedValue({
                sessionSummaryContract: false,
                sessionSummaryInChat: false,
                peerSpawnDefaults: {
                    agent: 'opencode',
                    permissionMode: 'default',
                    models: { opencode: 'provider/hub-model' }
                }
            })
        } as unknown as ApiClient

        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        client.setQueryData(queryKeys.hubSettings, {
            sessionSummaryContract: false,
            sessionSummaryInChat: false,
            peerSpawnDefaults: {
                agent: 'opencode',
                permissionMode: 'default',
                models: { opencode: 'provider/hub-model' }
            }
        })
        render(
            <QueryClientProvider client={client}>
                <NewSession
                    api={hubApi}
                    machines={[machine]}
                    initialMachineId="machine-1"
                    initialDirectory="C:\\repo"
                    onSuccess={mocks.onSuccess}
                    onCancel={() => {}}
                />
            </QueryClientProvider>
        )

        await waitFor(() => {
            expect(screen.getByTestId('opencode-model')).toHaveTextContent('provider/hub-model')
        })
    })

    it('migrates Cursor YOLO=false over hub yolo into native Default', async () => {
        localStorage.clear()
        savePreferredAgent('cursor')
        savePreferredYoloMode(false)
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'session-1' })
        const hubApi = {
            getHubSettings: vi.fn().mockResolvedValue({
                sessionSummaryContract: false,
                sessionSummaryInChat: false,
                peerSpawnDefaults: {
                    agent: 'cursor',
                    permissionMode: 'yolo',
                    models: {}
                }
            })
        } as unknown as ApiClient
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        client.setQueryData(queryKeys.hubSettings, {
            sessionSummaryContract: false,
            sessionSummaryInChat: false,
            peerSpawnDefaults: {
                agent: 'cursor',
                permissionMode: 'yolo',
                models: {}
            }
        })
        render(
            <QueryClientProvider client={client}>
                <NewSession
                    api={hubApi}
                    machines={[machine]}
                    initialMachineId="machine-1"
                    initialDirectory="C:\\repo"
                    onSuccess={mocks.onSuccess}
                    onCancel={() => {}}
                />
            </QueryClientProvider>
        )

        await waitFor(() => {
            expect(screen.getByDisplayValue('cursor')).toBeChecked()
            expect(screen.getByTestId('permission-mode')).toHaveTextContent('default')
        })
        await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'cursor',
            permissionMode: 'default'
        }))
    })

    it('does not apply Cursor YOLO migration after switching agent before hub settings', async () => {
        localStorage.clear()
        savePreferredAgent('cursor')
        savePreferredYoloMode(true)
        let resolveSettings!: (value: unknown) => void
        const deferred = new Promise((resolve) => {
            resolveSettings = resolve
        })
        const slowApi = {
            getHubSettings: vi.fn(() => deferred)
        } as unknown as ApiClient

        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={client}>
                <NewSession
                    api={slowApi}
                    machines={[machine]}
                    initialMachineId="machine-1"
                    initialDirectory="C:\\repo"
                    onSuccess={mocks.onSuccess}
                    onCancel={() => {}}
                />
            </QueryClientProvider>
        )

        fireEvent.click(screen.getByDisplayValue('codex'))
        await waitFor(() => expect(screen.getByDisplayValue('codex')).toBeChecked())
        expect(screen.getByTestId('permission-mode')).toHaveTextContent('default')

        await act(async () => {
            resolveSettings({
                sessionSummaryContract: false,
                sessionSummaryInChat: false,
                peerSpawnDefaults: {
                    agent: 'codex',
                    permissionMode: 'read-only',
                    models: {}
                }
            })
            await deferred
        })

        await waitFor(() => {
            expect(screen.getByDisplayValue('codex')).toBeChecked()
            // Hub read-only — not Cursor sticky YOLO → yolo
            expect(screen.getByTestId('permission-mode')).toHaveTextContent('read-only')
        })
    })

    it('keeps an explicit Claude model when hub settings resolve late with Codex', async () => {
        localStorage.clear()
        let resolveSettings!: (value: unknown) => void
        const deferred = new Promise((resolve) => {
            resolveSettings = resolve
        })
        const slowApi = {
            getHubSettings: vi.fn(() => deferred)
        } as unknown as ApiClient
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'session-1' })

        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={client}>
                <NewSession
                    api={slowApi}
                    machines={[machine]}
                    initialMachineId="machine-1"
                    initialDirectory="C:\\repo"
                    onSuccess={mocks.onSuccess}
                    onCancel={() => {}}
                />
            </QueryClientProvider>
        )

        expect(screen.getByDisplayValue('claude')).toBeChecked()
        fireEvent.click(screen.getByTestId('model'))
        expect(screen.getByTestId('model')).toHaveTextContent(mocks.nextModelValue)

        await act(async () => {
            resolveSettings({
                sessionSummaryContract: false,
                sessionSummaryInChat: false,
                peerSpawnDefaults: {
                    agent: 'codex',
                    permissionMode: 'read-only',
                    models: { codex: 'gpt-5' }
                }
            })
            await deferred
        })

        await waitFor(() => {
            expect(screen.getByDisplayValue('claude')).toBeChecked()
            expect(screen.getByTestId('model')).toHaveTextContent(mocks.nextModelValue)
        })
        await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'claude',
            model: mocks.nextModelValue
        }))
    })

    it('keeps an explicit OpenCode Default when hub settings resolve late', async () => {
        localStorage.clear()
        mocks.opencodeModels = [
            { modelId: 'provider/hub-model', name: 'Hub' },
            { modelId: 'provider/current', name: 'Current' }
        ]
        mocks.opencodeCurrentModelId = 'provider/current'
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'session-1' })
        let resolveSettings!: (value: unknown) => void
        const deferred = new Promise((resolve) => {
            resolveSettings = resolve
        })
        const slowApi = {
            getHubSettings: vi.fn(() => deferred)
        } as unknown as ApiClient

        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={client}>
                <NewSession
                    api={slowApi}
                    machines={[machine]}
                    initialMachineId="machine-1"
                    initialDirectory="C:\\repo"
                    onSuccess={mocks.onSuccess}
                    onCancel={() => {}}
                />
            </QueryClientProvider>
        )

        fireEvent.click(screen.getByDisplayValue('opencode'))
        fireEvent.click(screen.getByTestId('opencode-model-default'))
        expect(screen.getByTestId('opencode-model')).toHaveTextContent('default')

        await act(async () => {
            resolveSettings({
                sessionSummaryContract: false,
                sessionSummaryInChat: false,
                peerSpawnDefaults: {
                    agent: 'opencode',
                    permissionMode: 'default',
                    models: { opencode: 'provider/hub-model' }
                }
            })
            await deferred
        })

        await waitFor(() => {
            expect(screen.getByTestId('opencode-model')).toHaveTextContent('default')
        })
        await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'opencode',
            model: undefined
        }))
    })

    it('seeds AGY spawn model from hub when no launch preference exists', async () => {
        localStorage.clear()
        mocks.agyModels = [
            { modelId: 'hub-agy-model', name: 'Hub AGY' },
            { modelId: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' }
        ]
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'session-1' })
        const hubApi = {
            getHubSettings: vi.fn().mockResolvedValue({
                sessionSummaryContract: false,
                sessionSummaryInChat: false,
                peerSpawnDefaults: {
                    agent: 'agy',
                    permissionMode: 'default',
                    models: { agy: 'hub-agy-model' }
                }
            })
        } as unknown as ApiClient

        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        client.setQueryData(queryKeys.hubSettings, {
            sessionSummaryContract: false,
            sessionSummaryInChat: false,
            peerSpawnDefaults: {
                agent: 'agy',
                permissionMode: 'default',
                models: { agy: 'hub-agy-model' }
            }
        })
        render(
            <QueryClientProvider client={client}>
                <NewSession
                    api={hubApi}
                    machines={[machine]}
                    initialMachineId="machine-1"
                    initialDirectory="C:\\repo"
                    onSuccess={mocks.onSuccess}
                    onCancel={() => {}}
                />
            </QueryClientProvider>
        )

        await waitFor(() => {
            expect(screen.getByTestId('agy-model')).toHaveTextContent('hub-agy-model')
        })
        await waitFor(() => expect(screen.getByTestId('create')).toBeEnabled())
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(mocks.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'agy',
            model: 'hub-agy-model'
        }))
    })
})
