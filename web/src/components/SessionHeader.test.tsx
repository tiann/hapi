import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionHeader } from './SessionHeader'

vi.mock('@/hooks/useTelegram', () => ({
    isTelegramApp: vi.fn(() => false)
}))

vi.mock('@/hooks/mutations/useSessionActions', () => ({
    useSessionActions: () => ({
        archiveSession: vi.fn(),
        renameSession: vi.fn(),
        deleteSession: vi.fn(),
        isPending: false
    })
}))

vi.mock('@/components/SessionActionMenu', () => ({
    SessionActionMenu: () => null
}))

vi.mock('@/components/RenameSessionDialog', () => ({
    RenameSessionDialog: () => null
}))

vi.mock('@/components/ui/ConfirmDialog', () => ({
    ConfirmDialog: () => null
}))

function renderHeader(sessionOverrides: Record<string, unknown> = {}) {
    const session = {
        id: '1234567890abcdef',
        active: true,
        createdAt: 0,
        updatedAt: 0,
        activeAt: 0,
        seq: 0,
        namespace: 'default',
        metadataVersion: 0,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        metadata: {
            name: 'Named Session',
            path: '/workspace/project-name',
            flavor: 'codex',
            worktree: { branch: 'feature/chips', basePath: '/workspace/project-name' }
        },
        model: 'gpt-5.4',
        effort: 'very-high',
        permissionMode: 'yolo',
        collaborationMode: 'default',
        agentState: null,
        ...sessionOverrides
    }

    return renderToStaticMarkup(
        <I18nProvider>
            <SessionHeader
                session={session as never}
                onBack={vi.fn()}
                onViewFiles={vi.fn()}
                api={null}
            />
        </I18nProvider>
    )
}

describe('SessionHeader', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        const localStorageMock = {
            getItem: vi.fn(() => 'en'),
            setItem: vi.fn(),
            removeItem: vi.fn()
        }
        Object.defineProperty(window, 'localStorage', { value: localStorageMock, configurable: true })
    })

    it('renders full metadata chips', () => {
        const markup = renderHeader()
        expect(markup).toContain('Named Session')
        expect(markup).toContain('codex')
        expect(markup).toContain('gpt-5.4')
        expect(markup).toContain('Very High')
        expect(markup).toContain('Yolo')
        expect(markup).toContain('feature/chips')
        expect(markup).toContain('text-[var(--app-flavor-codex-text)] font-medium')
        expect(markup).toContain('text-[var(--app-hint)] opacity-40')
    })

    it('hides effort when absent', () => {
        const markup = renderHeader({ effort: null })
        expect(markup).not.toContain('Very High')
        expect(markup).toContain('Named Session')
        expect(markup).toContain('gpt-5.4')
    })

    it('hides permission mode when default', () => {
        const markup = renderHeader({ permissionMode: 'default' })
        expect(markup).not.toContain('Yolo')
        expect(markup).toContain('Named Session')
        expect(markup).toContain('codex')
    })

    it('hides worktree when absent', () => {
        const markup = renderHeader({
            metadata: {
                name: 'Named Session',
                path: '/workspace/project-name',
                flavor: 'codex'
            }
        })
        expect(markup).not.toContain('feature/chips')
    })

    it('falls back to the path basename for the title', () => {
        const markup = renderHeader({
            metadata: {
                path: '/workspace/path-title',
                flavor: 'codex'
            }
        })
        expect(markup).toContain('path-title')
    })

    it('falls back to the short id when no path or summary exists', () => {
        const markup = renderHeader({
            id: 'abcdef1234567890',
            metadata: null
        })
        expect(markup).toContain('abcdef12')
    })

    it('uses hint styling for unknown flavors', () => {
        const markup = renderHeader({
            metadata: {
                name: 'Mystery Session',
                path: '/workspace/mystery',
                flavor: 'mystery'
            }
        })
        expect(markup).toContain('mystery')
        expect(markup).toContain('text-[var(--app-hint)] font-medium')
    })
})
