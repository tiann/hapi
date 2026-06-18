import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { AgentSessionImportDialog } from './AgentSessionImportDialog'
import type {
    AgentImportFlavor,
    CodexLocalSessionSummary,
    CursorImportableSessionSummary,
    CursorImportRowOutcome,
    ClaudeLocalSessionSummary
} from '@/types/api'

interface RenderOpts {
    flavor?: AgentImportFlavor
    onChangeFlavor?: (flavor: AgentImportFlavor) => void
    codexSessions?: CodexLocalSessionSummary[]
    currentCodexSessionId?: string | null
    isLoadingCodex?: boolean
    isPendingCodex?: boolean
    onConfirmCodex?: (sessionIds: string[]) => Promise<void>
    onRestartCodexDesktop?: () => Promise<void>
    cursorSessions?: CursorImportableSessionSummary[]
    isLoadingCursor?: boolean
    isPendingCursor?: boolean
    cursorLastOutcomes?: CursorImportRowOutcome[] | null
    onConfirmCursor?: (uuids: string[]) => Promise<void>
    claudeSessions?: ClaudeLocalSessionSummary[]
    currentClaudeSessionId?: string | null
    isLoadingClaude?: boolean
    isPendingClaude?: boolean
    onConfirmClaude?: (sessionIds: string[]) => Promise<void>
}

function renderDialog(opts: RenderOpts = {}) {
    const onChangeFlavor = opts.onChangeFlavor ?? vi.fn()
    const onConfirmCodex = opts.onConfirmCodex ?? vi.fn(async () => {})
    const onConfirmCursor = opts.onConfirmCursor ?? vi.fn(async () => {})
    const onConfirmClaude = opts.onConfirmClaude ?? vi.fn(async () => {})
    const view = render(
        <I18nProvider>
            <AgentSessionImportDialog
                isOpen={true}
                onClose={vi.fn()}
                flavor={opts.flavor ?? 'codex'}
                onChangeFlavor={onChangeFlavor}
                codexSessions={opts.codexSessions ?? []}
                currentCodexSessionId={opts.currentCodexSessionId ?? null}
                isLoadingCodex={opts.isLoadingCodex ?? false}
                isPendingCodex={opts.isPendingCodex ?? false}
                isRestartingCodexDesktop={false}
                onConfirmCodex={onConfirmCodex}
                onRestartCodexDesktop={opts.onRestartCodexDesktop ?? vi.fn()}
                cursorSessions={opts.cursorSessions ?? []}
                isLoadingCursor={opts.isLoadingCursor ?? false}
                isPendingCursor={opts.isPendingCursor ?? false}
                cursorLastOutcomes={opts.cursorLastOutcomes ?? null}
                onConfirmCursor={onConfirmCursor}
                claudeSessions={opts.claudeSessions ?? []}
                currentClaudeSessionId={opts.currentClaudeSessionId ?? null}
                isLoadingClaude={opts.isLoadingClaude ?? false}
                isPendingClaude={opts.isPendingClaude ?? false}
                onConfirmClaude={onConfirmClaude}
            />
        </I18nProvider>
    )
    return { ...view, onChangeFlavor, onConfirmCodex, onConfirmCursor, onConfirmClaude }
}

const codexSampleSession: CodexLocalSessionSummary = {
    id: 'codex-session-1',
    title: 'Codex session title',
    lastUserMessage: 'Last prompt',
    cwd: '/home/user/project',
    file: '/home/user/.codex/sessions/session.jsonl',
    modifiedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    originator: 'codex_cli',
    cliVersion: '0.124.0'
}

const cursorSampleAcp: CursorImportableSessionSummary = {
    id: 'cursor-acp-uuid',
    title: 'Cursor ACP chat',
    firstUserMessage: 'First user prompt',
    workspacePath: '/home/user/repo',
    storeDbPath: '/home/user/.cursor/acp-sessions/cursor-acp-uuid/store.db',
    sourceFormat: 'acp',
    modifiedAt: Date.UTC(2026, 0, 3, 3, 4, 5),
    sizeBytes: 12_345,
    alreadyImportedHapiSessionId: null
}

const cursorSampleLegacyAlreadyImported: CursorImportableSessionSummary = {
    id: 'cursor-legacy-uuid',
    title: 'Cursor legacy chat',
    workspacePath: '/home/user/other',
    storeDbPath: '/home/user/.cursor/chats/wsh/cursor-legacy-uuid/store.db',
    sourceFormat: 'legacy',
    modifiedAt: Date.UTC(2026, 0, 4, 3, 4, 5),
    sizeBytes: 7_777,
    alreadyImportedHapiSessionId: 'hapi-existing-id'
}

const claudeSampleSession: ClaudeLocalSessionSummary = {
    id: 'claude-session-1',
    title: 'Claude session title',
    lastUserMessage: 'Claude prompt',
    cwd: '/home/user/claude-project',
    file: '/home/user/.claude/projects/session.jsonl',
    modifiedAt: Date.UTC(2026, 0, 5, 3, 4, 5),
    originator: 'claude_cli',
    cliVersion: '1.0.0'
}

describe('AgentSessionImportDialog', () => {
    afterEach(() => {
        cleanup()
    })

    it('shows the Codex panel by default and lists Codex sessions', () => {
        renderDialog({ codexSessions: [codexSampleSession] })
        expect(screen.getByText('Codex session title')).toBeInTheDocument()
        expect(screen.getAllByText('/home/user/project').length).toBeGreaterThan(0)
        expect(screen.getByRole('tab', { name: 'Codex' })).toHaveAttribute('aria-selected', 'true')
        expect(screen.getByRole('tab', { name: 'Cursor' })).toHaveAttribute('aria-selected', 'false')
    })

    it('switches to the Cursor panel when the flavor tab is clicked', () => {
        const onChangeFlavor = vi.fn()
        renderDialog({ flavor: 'codex', onChangeFlavor })
        fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }))
        expect(onChangeFlavor).toHaveBeenCalledWith('cursor')
    })

    it('switches to the Claude panel when the flavor tab is clicked', () => {
        const onChangeFlavor = vi.fn()
        renderDialog({ flavor: 'codex', onChangeFlavor })
        fireEvent.click(screen.getByRole('tab', { name: 'Claude' }))
        expect(onChangeFlavor).toHaveBeenCalledWith('claude')
    })

    it('renders the Claude panel and confirms selection', async () => {
        const onConfirmClaude = vi.fn(async () => {})
        renderDialog({
            flavor: 'claude',
            claudeSessions: [claudeSampleSession],
            onConfirmClaude
        })
        expect(screen.getByText('Claude session title')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('checkbox'))
        fireEvent.click(screen.getByText('Import'))
        await waitFor(() => expect(onConfirmClaude).toHaveBeenCalledWith(['claude-session-1']))
    })

    it('renders the Cursor panel with ACP / legacy badges and the ACP-strict hint', () => {
        renderDialog({
            flavor: 'cursor',
            cursorSessions: [cursorSampleAcp, cursorSampleLegacyAlreadyImported]
        })
        expect(screen.getByText('Cursor ACP chat')).toBeInTheDocument()
        expect(screen.getByText('Cursor legacy chat')).toBeInTheDocument()
        expect(screen.getByText('ACP')).toBeInTheDocument()
        expect(screen.getByText('Legacy')).toBeInTheDocument()
        expect(screen.getByText('Already imported')).toBeInTheDocument()
        // Strict ACP hint visible above the list.
        expect(screen.getByText(/acp verify-probe/i)).toBeInTheDocument()
    })

    it('disables the already-imported row and skips it when selecting all', () => {
        const onConfirmCursor = vi.fn(async () => {})
        renderDialog({
            flavor: 'cursor',
            cursorSessions: [cursorSampleAcp, cursorSampleLegacyAlreadyImported],
            onConfirmCursor
        })
        fireEvent.click(screen.getByText('Select all'))
        fireEvent.click(screen.getByText('Import'))
        expect(onConfirmCursor).toHaveBeenCalledTimes(1)
        expect(onConfirmCursor).toHaveBeenCalledWith(['cursor-acp-uuid'])
    })

    it('surfaces a per-row refusal chip when the last outcome failed', () => {
        const lastOutcomes: CursorImportRowOutcome[] = [
            {
                ok: false,
                uuid: 'cursor-acp-uuid',
                reason: 'verify_load_failed',
                message: 'agent acp session/load failed: bad blob graph',
                durationMs: 123
            }
        ]
        renderDialog({
            flavor: 'cursor',
            cursorSessions: [cursorSampleAcp],
            cursorLastOutcomes: lastOutcomes
        })
        expect(screen.getByText('agent acp could not load this chat')).toBeInTheDocument()
        expect(screen.getByText(/bad blob graph/)).toBeInTheDocument()
    })

    it('confirms Codex selection and forwards selected session ids', async () => {
        const onConfirmCodex = vi.fn(async () => {})
        renderDialog({
            flavor: 'codex',
            codexSessions: [codexSampleSession],
            onConfirmCodex
        })
        const checkbox = screen.getByRole('checkbox')
        fireEvent.click(checkbox)
        fireEvent.click(screen.getByText('Import'))
        await waitFor(() => expect(onConfirmCodex).toHaveBeenCalled())
        expect(onConfirmCodex).toHaveBeenCalledWith(['codex-session-1'])
    })

    it('shows the loading state on the active flavor', () => {
        renderDialog({ flavor: 'cursor', isLoadingCursor: true })
        expect(screen.getByText('Loading local Cursor chats…')).toBeInTheDocument()
    })

    it('disables flavor switching while an import is in flight', () => {
        renderDialog({ flavor: 'codex', isPendingCodex: true })
        expect(screen.getByRole('tab', { name: 'Cursor' })).toBeDisabled()
    })
})
