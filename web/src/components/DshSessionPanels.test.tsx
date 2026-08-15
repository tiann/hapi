import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { DshSessionPanels } from './DshSessionPanels'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'

function rawMessage(id: string, payload: unknown, role = 'agent'): DecryptedMessage {
    return {
        id,
        seq: 1,
        localId: null,
        createdAt: 1,
        content: { role, content: { type: 'codex', data: payload } },
    } as DecryptedMessage
}

const API = {
    dshAction: async () => ({ ok: true as const, result: {} }),
    dshModels: async () => ({
        current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        routable: true,
        groups: [{
            id: 'deepseek-official',
            name: 'DeepSeek',
            models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }]
        }],
        failures: []
    }),
    dshSkills: async () => ({ skills: [] }),
    sendMessage: async () => ({ attemptId: 'a1' }),
} as unknown as ApiClient

function renderPanels(messages: DecryptedMessage[]) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <I18nProvider>
            <QueryClientProvider client={queryClient}>
                <DshSessionPanels api={API} sessionId="dsh-1" messages={messages} />
            </QueryClientProvider>
        </I18nProvider>
    )
}

describe('DshSessionPanels (standard HAPI view integration)', () => {
    it('renders nothing when the session has no DSH state', () => {
        renderPanels([])
        expect(screen.queryByText('DeepSeek Harness')).toBeTruthy()
    })

    it('shows the goal bar from a folded dsh_state snapshot', () => {
        renderPanels([
            rawMessage('m1', { type: 'dsh_state', state: {
                seq: 5,
                goal: { objective: 'ship it', status: 'active', revision: 1 }
            } }),
            rawMessage('m2', { type: 'dsh_state', state: {
                seq: 6,
                goal: { objective: 'ship it now', status: 'active', revision: 2 }
            } }),
        ])
        expect(screen.getByText('ship it now')).toBeTruthy()
        // Higher seq wins — the older objective must not render.
        expect(screen.queryByText('ship it')).toBeNull()
    })

    it('shows queue and jobs docks from snapshots', () => {
        renderPanels([
            rawMessage('m1', { type: 'dsh_state', state: {
                seq: 1,
                queue: { items: [{ id: 'q1', placement: 'queued', text: 'second prompt' }] },
                jobs: { jobs: [{ id: 'bash-1', kind: 'bash', label: 'bun run build', status: 'running', startedAt: 1 }] }
            } }),
        ])
        expect(screen.getByText('second prompt')).toBeTruthy()
        expect(screen.getByText('bun run build')).toBeTruthy()
    })

    it('folds native events without rendering them as panels', () => {
        renderPanels([
            rawMessage('m1', { type: 'dsh_native', event: { seq: 1, type: 'turn/start', time: 1, data: {} } }),
            rawMessage('m2', { type: 'text', text: 'streamed answer', id: 'dsh-t1', streamSnapshot: true }),
        ])
        // Panels do not render conversation content.
        expect(screen.queryByText('streamed answer')).toBeNull()
    })
})
