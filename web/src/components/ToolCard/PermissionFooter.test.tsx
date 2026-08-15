import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'
import { I18nProvider } from '@/lib/i18n-context'
import { PermissionFooter } from './PermissionFooter'

const pendingTool: ChatToolCall = {
    id: 'tool-1',
    name: 'Bash',
    state: 'pending',
    input: { command: 'pwd' },
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    execStartedAt: null,
    execCompletedAt: null,
    description: null,
    permission: { id: 'approval-1', status: 'pending' }
}

describe('PermissionFooter', () => {
    it('does not offer a session-wide approval that DeepSeek Harness cannot honor', () => {
        render(
            <I18nProvider>
                <PermissionFooter
                    api={{} as ApiClient}
                    sessionId="session-1"
                    metadata={{ path: '/tmp/project', host: 'localhost', flavor: 'dsh' }}
                    tool={pendingTool}
                    disabled={false}
                    onDone={() => {}}
                />
            </I18nProvider>
        )

        expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Allow For Session' })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
    })
})
