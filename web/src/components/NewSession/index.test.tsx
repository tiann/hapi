import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { saveNewSessionFormDraft } from './newSessionFormDraft'
import {
    loadPreferredLaunchSettings,
    savePreferredAgent,
    savePreferredLaunchSettings
} from './preferences'

const mocks = vi.hoisted(() => ({
    spawnSession: vi.fn(),
    onSuccess: vi.fn(),
    notification: vi.fn(),
    checkPathsExists: vi.fn(),
    codexModelsLoading: false,
    agyModelsLoading: false,
    agyModels: [{ modelId: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' }],
    directoryExists: undefined as boolean | undefined,
    copilotModels: [] as Array<{ modelId: string; name?: string }>,
    copilotModelsLoading: false,
    piDialogSelection: ['pi-native-1'] as string[],
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
        checkPathsExists: mocks.checkPathsExists
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
        availableModels: [],
        currentModelId: null,
        isLoading: false,
        error: null,
        refetch: vi.fn()
    })
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
vi.mock('./GrokPermissionModeSelector', () => ({ GrokPermissionModeSelector: () => null }))
vi.mock('./CodexFamilyPermissionModeSelector', () => ({ CodexFamilyPermissionModeSelector: () => null }))
vi.mock('./CopilotAgentModeSelector', () => ({ CopilotAgentModeSelector: () => null }))
vi.mock('./YoloToggle', () => ({ YoloToggle: () => null }))
vi.mock('./OpencodeModelSelector', () => ({ OpencodeModelSelector: () => null }))
vi.mock('./AgyModelSelector', () => ({
    AgyModelSelector: (props: { selectedModel: string | null; onModelChange: (model: string | null) => void }) => (
        <button type="button" data-testid="agy-model" onClick={() => props.onModelChange('gemini-3.6-flash-low')}>
            {props.selectedModel ?? 'auto'}
        </button>
    )
}))
vi.mock('./LaunchEffortSelector', () => ({
    LaunchEffortSelector: (props: { effort: string }) => (
        <div data-testid="launch-effort">{props.effort}</div>
    )
}))
vi.mock('./ModelSelector', () => ({
    ModelSelector: (props: {
        model: string
        options?: Array<{ value: string; label: string }>
        onModelChange: (model: string) => void
    }) => (
        <>
            <button type="button" data-testid="model" onClick={() => props.onModelChange('gpt-5.6-terra')}>
                {props.model}
            </button>
            <div data-testid="model-options">{props.options?.map((option) => option.label).join(',')}</div>
        </>
    )
}))
vi.mock('./ReasoningEffortSelector', () => ({
    ReasoningEffortSelector: (props: { value: string; onChange: (effort: string) => void }) => (
        <button type="button" data-testid="reasoning" onClick={() => props.onChange('max')}>
            {props.value}
        </button>
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
const api = {} as ApiClient

describe('NewSession launch preferences', () => {
    beforeEach(() => {
        localStorage.clear()
        sessionStorage.clear()
        mocks.spawnSession.mockReset()
        mocks.onSuccess.mockReset()
        mocks.notification.mockReset()
        mocks.checkPathsExists.mockReset()
        mocks.checkPathsExists.mockImplementation(async () => ({ 'C:\\repo': mocks.directoryExists }))
        mocks.codexModelsLoading = false
        mocks.agyModelsLoading = false
        mocks.agyModels = [{ modelId: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' }]
        mocks.directoryExists = true
        mocks.copilotModels = []
        mocks.copilotModelsLoading = false
        mocks.piDialogSelection = ['pi-native-1']
        mocks.refetchSessions.mockReset()
        mocks.refetchSessions.mockResolvedValue(undefined)
        mocks.addToast.mockReset()
        savePreferredAgent('codex')
    })

    it('restores the last successful model and reasoning effort for the machine and agent', async () => {
        savePreferredLaunchSettings('machine-1', 'codex', {
            model: 'gpt-5.6-sol',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'xhigh'
        })

        render(
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
        })
    })

    it('shows discovered Copilot models for the selected directory', async () => {
        mocks.copilotModels = [
            { modelId: 'gpt-5.6', name: 'GPT-5.6' },
            { modelId: 'auto', name: 'Auto' }
        ]

        render(
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

        render(
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

        render(
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

        render(
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

        render(
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
        expect(loadPreferredLaunchSettings('machine-1', 'codex')).toBeNull()
        fireEvent.click(screen.getByTestId('create'))

        await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledWith('session-1'))
        expect(loadPreferredLaunchSettings('machine-1', 'codex')).toEqual({
            model: 'gpt-5.6-terra',
            cursorSelectedBase: 'auto',
            effort: 'auto',
            modelReasoningEffort: 'max'
        })
    })

    it('restores the AGY model from a browse-return draft', async () => {
        savePreferredAgent('agy')
        saveNewSessionFormDraft({
            agent: 'agy', model: 'gemini-3.6-flash-low', cursorSelectedBase: 'auto', machineId: 'machine-1',
            effort: 'auto', modelReasoningEffort: 'default', serviceTier: 'standard', collaborationMode: 'default',
            copilotAgentMode: 'interactive', yoloMode: false, codexFamilyPermissionMode: 'default',
            grokPermissionMode: 'default', sessionType: 'simple', worktreeName: ''
        })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('gemini-3.6-flash-low'))
    })

    it('falls back to Default when a browse-return AGY model is no longer advertised', async () => {
        savePreferredAgent('agy')
        saveNewSessionFormDraft({
            agent: 'agy', model: 'removed-model', cursorSelectedBase: 'auto', machineId: 'machine-1',
            effort: 'auto', modelReasoningEffort: 'default', serviceTier: 'standard', collaborationMode: 'default',
            copilotAgentMode: 'interactive', yoloMode: false, codexFamilyPermissionMode: 'default',
            grokPermissionMode: 'default', sessionType: 'simple', worktreeName: ''
        })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('auto'))
    })

    it('falls back to Default when a preferred AGY model is no longer advertised', async () => {
        savePreferredAgent('agy')
        savePreferredLaunchSettings('machine-1', 'agy', { model: 'removed-model', cursorSelectedBase: 'auto', effort: 'auto', modelReasoningEffort: 'default' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('auto'))
    })

    it('blocks Create while a remembered AGY model is awaiting catalog validation', async () => {
        savePreferredAgent('agy')
        savePreferredLaunchSettings('machine-1', 'agy', { model: 'gemini-3.6-flash-low', cursorSelectedBase: 'auto', effort: 'auto', modelReasoningEffort: 'default' })
        mocks.agyModelsLoading = true
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('create')).toBeDisabled())
    })

    it('persists the selected AGY model only after a successful launch', async () => {
        savePreferredAgent('agy')
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'agy-session' })
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
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
        render(<NewSession api={api} machines={[machine]} initialMachineId="machine-1" initialDirectory="C:\repo" onSuccess={mocks.onSuccess} onCancel={() => {}} />)
        await waitFor(() => expect(screen.getByTestId('agy-model')).toHaveTextContent('gemini-3.5-flash-low'))
        fireEvent.click(screen.getByTestId('agy-model'))
        fireEvent.click(screen.getByTestId('create'))
        await waitFor(() => expect(mocks.notification).toHaveBeenCalledWith('error'))
        expect(loadPreferredLaunchSettings('machine-1', 'agy')?.model).toBe('gemini-3.5-flash-low')
    })

    it('spawns only once when Create is activated twice during directory validation', async () => {
        let finishDirectoryCheck!: (result: Record<string, boolean>) => void
        mocks.checkPathsExists.mockReturnValue(new Promise((resolve) => {
            finishDirectoryCheck = resolve
        }))
        mocks.spawnSession.mockResolvedValue({ type: 'success', sessionId: 'session-1' })

        render(
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
        finishDirectoryCheck({ 'C:\\repo': true })

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

        render(
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

        render(
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

        render(
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

        render(
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
            codexFamilyPermissionMode: 'default',
            grokPermissionMode: 'default',
            sessionType: 'simple',
            worktreeName: ''
        })

        render(
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
})
