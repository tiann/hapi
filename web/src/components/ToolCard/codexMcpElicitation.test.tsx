import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'
import { CodexMcpElicitationFooter } from '@/components/ToolCard/CodexMcpElicitationFooter'
import {
    buildCodexMcpElicitationFormContent,
    createCodexMcpElicitationFormState,
    normalizeCodexMcpElicitationFormSchema
} from '@/components/ToolCard/codexMcpElicitation'

const platformMocks = vi.hoisted(() => ({
    impact: vi.fn(),
    notification: vi.fn(),
    selection: vi.fn()
}))

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        isTelegram: false,
        isTouch: false,
        haptic: platformMocks
    })
}))

function makeTool(input: unknown): ChatToolCall {
    return {
        id: 'tool-1',
        name: 'CodexMcpElicitation',
        state: 'running',
        input,
        createdAt: 0,
        startedAt: 0,
        completedAt: null,
        description: null
    }
}

const formInput = {
    requestId: 'request-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    serverName: 'demo-server',
    mode: 'form' as const,
    message: 'Need MCP input',
    requestedSchema: {
        type: 'object',
        properties: {
            token: {
                type: 'string',
                title: 'Access token'
            },
            count: {
                type: 'integer',
                title: 'Count'
            },
            enabled: {
                type: 'boolean',
                title: 'Enabled'
            },
            mode: {
                title: 'Mode',
                enum: ['basic', 'advanced']
            },
            settings: {
                type: 'object',
                title: 'Settings',
                properties: {
                    theme: {
                        type: 'string'
                    }
                }
            }
        },
        required: ['token', 'count']
    }
}

const urlInput = {
    requestId: 'request-url-1',
    threadId: 'thread-1',
    turnId: 'turn-2',
    serverName: 'auth-server',
    mode: 'url' as const,
    message: 'Open the login page',
    url: 'https://example.com/login'
}

describe('normalizeCodexMcpElicitationFormSchema', () => {
    afterEach(() => {
        vi.clearAllMocks()
    })

    it('maps common field types and falls back to json for complex fields', () => {
        const schema = normalizeCodexMcpElicitationFormSchema(formInput.requestedSchema)
        expect(schema.kind).toBe('object')
        if (schema.kind !== 'object') {
            throw new Error('expected object schema')
        }

        expect(schema.fields.map((field) => ({
            key: field.key,
            kind: field.kind,
            required: field.required,
            label: field.label
        }))).toEqual([
            { key: 'token', kind: 'string', required: true, label: 'Access token' },
            { key: 'count', kind: 'integer', required: true, label: 'Count' },
            { key: 'enabled', kind: 'boolean', required: false, label: 'Enabled' },
            { key: 'mode', kind: 'enum', required: false, label: 'Mode' },
            { key: 'settings', kind: 'json', required: false, label: 'Settings' }
        ])
    })

    it('rejects unsupported non-object root schemas', () => {
        expect(normalizeCodexMcpElicitationFormSchema({
            type: 'array',
            items: {
                type: 'string'
            }
        })).toMatchObject({
            kind: 'unsupported',
            reason: expect.stringContaining('Only object forms are supported')
        })
    })
})

describe('buildCodexMcpElicitationFormContent', () => {
    afterEach(() => {
        vi.clearAllMocks()
    })

    it('builds typed content for supported field kinds', () => {
        const schema = normalizeCodexMcpElicitationFormSchema(formInput.requestedSchema)
        const state = createCodexMcpElicitationFormState(schema)
        state.token = 'abc'
        state.count = '3'
        state.enabled = true
        state.mode = '1'
        state.settings = '{"theme":"dark"}'

        expect(buildCodexMcpElicitationFormContent(schema, state)).toEqual({
            ok: true,
            content: {
                token: 'abc',
                count: 3,
                enabled: true,
                mode: 'advanced',
                settings: {
                    theme: 'dark'
                }
            }
        })
    })

    it('surfaces validation failures for invalid json fallback fields', () => {
        const schema = normalizeCodexMcpElicitationFormSchema(formInput.requestedSchema)
        const state = createCodexMcpElicitationFormState(schema)
        state.token = 'abc'
        state.count = '3'
        state.settings = '{broken'

        expect(buildCodexMcpElicitationFormContent(schema, state)).toMatchObject({
            ok: false,
            fieldKey: 'settings'
        })
    })
})

describe('CodexMcpElicitationFooter', () => {
    afterEach(() => {
        vi.clearAllMocks()
    })

    it('submits collected form values instead of an empty object', async () => {
        const respondToMcpElicitation = vi.fn().mockResolvedValue(undefined)
        const onDone = vi.fn()
        const api = {
            respondToMcpElicitation
        } as unknown as ApiClient

        render(
            <CodexMcpElicitationFooter
                api={api}
                sessionId="session-1"
                tool={makeTool(formInput)}
                disabled={false}
                onDone={onDone}
            />
        )

        fireEvent.change(screen.getByLabelText(/Access token/i), { target: { value: 'abc' } })
        fireEvent.change(screen.getByLabelText(/Count/i), { target: { value: '3' } })
        fireEvent.click(screen.getByLabelText(/Enabled/i))
        fireEvent.change(screen.getByLabelText(/Mode/i), { target: { value: '1' } })
        fireEvent.change(screen.getByLabelText(/Settings/i), { target: { value: '{"theme":"dark"}' } })
        fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

        await waitFor(() => {
            expect(respondToMcpElicitation).toHaveBeenCalledWith('session-1', 'request-1', {
                action: 'accept',
                content: {
                    token: 'abc',
                    count: 3,
                    enabled: true,
                    mode: 'advanced',
                    settings: {
                        theme: 'dark'
                    }
                }
            })
        })
        expect(onDone).toHaveBeenCalled()
    })

    it('preserves in-progress form values across rerenders for the same tool id', () => {
        const api = {
            respondToMcpElicitation: vi.fn().mockResolvedValue(undefined)
        } as unknown as ApiClient

        const rendered = render(
            <CodexMcpElicitationFooter
                api={api}
                sessionId="session-1"
                tool={makeTool(formInput)}
                disabled={false}
                onDone={() => {}}
            />
        )

        fireEvent.change(screen.getByLabelText(/Access token/i), { target: { value: 'draft-token' } })

        rendered.rerender(
            <CodexMcpElicitationFooter
                api={api}
                sessionId="session-1"
                tool={makeTool({
                    ...formInput,
                    requestedSchema: {
                        ...formInput.requestedSchema,
                        properties: {
                            ...formInput.requestedSchema.properties
                        }
                    }
                })}
                disabled={false}
                onDone={() => {}}
            />
        )

        expect(screen.getByLabelText(/Access token/i)).toHaveValue('draft-token')
    })

    it('opens the URL before accepting URL-mode elicitations', async () => {
        const respondToMcpElicitation = vi.fn().mockResolvedValue(undefined)
        const onDone = vi.fn()
        const api = {
            respondToMcpElicitation
        } as unknown as ApiClient
        const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

        render(
            <CodexMcpElicitationFooter
                api={api}
                sessionId="session-1"
                tool={makeTool(urlInput)}
                disabled={false}
                onDone={onDone}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'Open and continue' }))

        await waitFor(() => {
            expect(openSpy).toHaveBeenCalledWith('https://example.com/login', '_blank', 'noopener,noreferrer')
            expect(respondToMcpElicitation).toHaveBeenCalledWith('session-1', 'request-url-1', {
                action: 'accept',
                content: null
            })
        })
        expect(onDone).toHaveBeenCalled()
    })
})
