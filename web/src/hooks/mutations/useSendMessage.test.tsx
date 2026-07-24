import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useSendMessage } from './useSendMessage'
import { ApiError, type ApiClient } from '@/api/client'

vi.mock('@/lib/message-window-store', () => ({
    appendOptimisticMessage: vi.fn(),
    getMessageWindowState: vi.fn(() => ({ messages: [], pending: [] })),
    updateMessageStatus: vi.fn(),
    removeOptimisticMessage: vi.fn(),
}))

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: { notification: vi.fn() },
    }),
}))

vi.mock('@/lib/messages', () => ({
    makeClientSideId: vi.fn(() => 'local-id-1'),
}))

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { mutations: { retry: false } },
    })
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

function createMockApi(sendMessage: (...args: unknown[]) => Promise<void> = async () => {}): ApiClient {
    return { sendMessage } as unknown as ApiClient
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>((res) => {
        resolve = res
    })
    return { promise, resolve }
}

describe('useSendMessage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('calls onSuccess with the session ID that was sent', async () => {
        const onSuccess = vi.fn()
        const api = createMockApi()

        const { result } = renderHook(
            () => useSendMessage(api, 'session-A', { onSuccess }),
            { wrapper: createWrapper() },
        )

        act(() => {
            result.current.sendMessage('hello')
        })

        await waitFor(() => {
            expect(onSuccess).toHaveBeenCalledWith('session-A')
        })
    })

    it('keeps a thinking-session send in flight until the POST confirms it is queued', async () => {
        const request = deferred<void>()
        const api = createMockApi(() => request.promise)
        const { appendOptimisticMessage, updateMessageStatus } = await import('@/lib/message-window-store')
        const appendMock = vi.mocked(appendOptimisticMessage)
        const updateMock = vi.mocked(updateMessageStatus)

        const { result } = renderHook(
            () => useSendMessage(api, 'session-A', { isSessionThinking: true }),
            { wrapper: createWrapper() },
        )

        act(() => {
            void result.current.sendMessage('queue this')
        })

        await waitFor(() => {
            expect(appendMock).toHaveBeenCalledWith(
                'session-A',
                expect.objectContaining({
                    localId: 'local-id-1',
                    status: 'sending',
                }),
            )
        })
        expect(updateMock).not.toHaveBeenCalledWith('session-A', 'local-id-1', 'queued')

        await act(async () => {
            request.resolve()
            await request.promise
        })

        await waitFor(() => {
            expect(updateMock).toHaveBeenCalledWith('session-A', 'local-id-1', 'queued')
        })
    })

    it('calls onSuccess with resolved session ID, not the original', async () => {
        const onSuccess = vi.fn()
        const api = createMockApi()

        const { result } = renderHook(
            () => useSendMessage(api, 'session-original', {
                onSuccess,
                resolveSessionId: async () => 'session-resolved',
                onSessionResolved: vi.fn(),
            }),
            { wrapper: createWrapper() },
        )

        act(() => {
            result.current.sendMessage('hello')
        })

        await waitFor(() => {
            expect(onSuccess).toHaveBeenCalledWith('session-resolved')
        })
    })

    it('does not call onSuccess when send fails', async () => {
        const onSuccess = vi.fn()
        const api = createMockApi(async () => {
            throw new Error('network error')
        })

        const { result } = renderHook(
            () => useSendMessage(api, 'session-A', { onSuccess }),
            { wrapper: createWrapper() },
        )

        act(() => {
            result.current.sendMessage('hello')
        })

        await waitFor(() => {
            expect(result.current.isSending).toBe(false)
        })

        expect(onSuccess).not.toHaveBeenCalled()
    })

    // assistant-ui clears the composer eagerly when send is invoked, so to
    // retain the typed text on failure we hand the original input back
    // through the `onError` callback.  The three branches below cover the
    // acceptance criteria: 5xx/network, 4xx, and 2xx.
    describe('composer text retention on send failure', () => {
        it('5xx/network: onError fires with the original text so the composer can restore it', async () => {
            const onError = vi.fn()
            const onSuccess = vi.fn()
            const api = createMockApi(async () => {
                // request<T>() throws plain Error for 5xx with this shape.
                throw new Error('HTTP 503 Service Unavailable: hub down')
            })

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError, onSuccess }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('keep this text on 503')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            const info = onError.mock.calls[0][0] as { text: string; error: unknown }
            expect(info.text).toBe('keep this text on 503')
            expect(info.error).toBeInstanceOf(Error)
            expect((info.error as Error).message).toContain('503')
            expect(onSuccess).not.toHaveBeenCalled()
        })

        it('network: onError fires with the original text on a fetch-level rejection', async () => {
            const onError = vi.fn()
            // Simulates a TypeError surfaced by fetch() when the hub socket
            // dies mid-request (e.g. daily-rebuild restart blip).
            const api = createMockApi(async () => {
                throw new TypeError('Failed to fetch')
            })

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('keep this on a dropped fetch')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            const info = onError.mock.calls[0][0] as { text: string; error: unknown }
            expect(info.text).toBe('keep this on a dropped fetch')
            expect(info.error).toBeInstanceOf(TypeError)
        })

        it('4xx: onError fires with the original text so the inline affordance can render', async () => {
            const onError = vi.fn()
            const api = createMockApi(async () => {
                // request<T>() throws plain Error for 4xx (e.g. 400/403).
                throw new Error('HTTP 400 Bad Request: invalid payload')
            })

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('keep this text on 400')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            const info = onError.mock.calls[0][0] as { text: string; error: unknown }
            expect(info.text).toBe('keep this text on 400')
            expect((info.error as Error).message).toContain('400')
        })

        it('2xx: onError is not called and onSuccess fires (composer clears as today)', async () => {
            const onError = vi.fn()
            const onSuccess = vi.fn()
            const api = createMockApi()

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError, onSuccess }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('clean send')
            })

            await waitFor(() => {
                expect(onSuccess).toHaveBeenCalledWith('session-A')
            })
            expect(onError).not.toHaveBeenCalled()
        })

        it('non-Error throws still surface text; the consumer falls back to its default message', async () => {
            const onError = vi.fn()
            const api = createMockApi(async () => {
                // Defensive case — some providers throw bare strings/objects.
                // We must not swallow these or the composer would silently
                // eat the user's text again.
                throw 'opaque failure'
            })

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('keep this on opaque failure')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            const info = onError.mock.calls[0][0] as { text: string; error: unknown; scheduledAt: number | null }
            expect(info.text).toBe('keep this on opaque failure')
            expect(info.error).toBe('opaque failure')
            expect(info.scheduledAt).toBeNull()
        })

        it('carries scheduledAt through onError so the composer can restore a failed scheduled send as scheduled', async () => {
            // Without this, SessionChat clears pendingSchedule on accept and the
            // subsequent failure's restore would silently downgrade a scheduled
            // send to immediate -- the operator hits send again and the message
            // dispatches now instead of at the chosen time.
            const onError = vi.fn()
            const api = createMockApi(async () => {
                throw new Error('HTTP 503 Service Unavailable')
            })
            const scheduledAt = Date.now() + 5 * 60 * 1000

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('see you in 5', undefined, scheduledAt)
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            const info = onError.mock.calls[0][0] as { text: string; scheduledAt: number | null }
            expect(info.text).toBe('see you in 5')
            expect(info.scheduledAt).toBe(scheduledAt)
        })

        it('immediate send: scheduledAt is null in onError', async () => {
            const onError = vi.fn()
            const api = createMockApi(async () => {
                throw new Error('boom')
            })

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('immediate')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            const info = onError.mock.calls[0][0] as { scheduledAt: number | null }
            expect(info.scheduledAt).toBeNull()
        })

        it('removes the optimistic row on failure so the composer-restore path is the single retry surface', async () => {
            // Without this, the thread keeps a stale `failed` bubble next to
            // the restored composer text, and the operator can stack a
            // duplicate by retrying from either surface.
            const onError = vi.fn()
            const api = createMockApi(async () => {
                throw new Error('HTTP 503')
            })

            const { removeOptimisticMessage, updateMessageStatus } = await import('@/lib/message-window-store')
            const removeMock = vi.mocked(removeOptimisticMessage)
            const updateMock = vi.mocked(updateMessageStatus)

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('hello')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            // The optimistic row is removed instead of being kept as failed.
            expect(removeMock).toHaveBeenCalledWith('session-A', 'local-id-1')
            // Defensive: nothing else should have transitioned the row to
            // 'failed' on this path -- we removed it outright.
            expect(updateMock.mock.calls.some((call) => call[2] === 'failed')).toBe(false)
        })

        it('carries sessionId through onError so a resumed-session POST that fails restores into the right composer', async () => {
            // Inactive-session resume: useSendMessage resolves a target id,
            // kicks off async navigation, and then the POST can fail.  The
            // route component keys sendError state by sessionId so the
            // restore lands on the resumed session, not the old one whose
            // composer the operator has already navigated away from.
            const onError = vi.fn()
            const api = createMockApi(async () => {
                throw new Error('HTTP 500')
            })

            const { result } = renderHook(
                () => useSendMessage(api, 'session-original', {
                    onError,
                    resolveSessionId: async () => 'session-resolved',
                    onSessionResolved: vi.fn(),
                }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('hi from resumed')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            const info = onError.mock.calls[0][0] as { sessionId: string; text: string }
            expect(info.sessionId).toBe('session-resolved')
            expect(info.text).toBe('hi from resumed')
        })

        it('attachment send: keeps the failed row in the thread and skips composer-restore', async () => {
            // The composer-restore path can't reinstate uploaded attachment
            // metadata, so for sends with attachments we fall back to the
            // legacy failed-bubble UX (operator retries via the in-thread
            // retry button, which re-fires the send WITH attachments).
            const onError = vi.fn()
            const api = createMockApi(async () => {
                throw new Error('HTTP 503')
            })

            const { removeOptimisticMessage, updateMessageStatus } = await import('@/lib/message-window-store')
            const removeMock = vi.mocked(removeOptimisticMessage)
            const updateMock = vi.mocked(updateMessageStatus)

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('see this image', [
                    { id: 'att-1', filename: 'x.png', mimeType: 'image/png', size: 1, path: '/x.png' }
                ])
            })

            await waitFor(() => {
                expect(updateMock).toHaveBeenCalledWith('session-A', 'local-id-1', 'failed')
            })
            // No composer-restore: onError is NOT fired and the optimistic
            // row is NOT removed -- both would destroy the attachment UX.
            expect(onError).not.toHaveBeenCalled()
            expect(removeMock).not.toHaveBeenCalled()
        })

        it('retryMessage: passes attachments through so failed-bubble retry of an attachment send keeps its files', async () => {
            // Without this, the failed-bubble retry path silently drops the
            // attachments and re-fires as a text-only send.
            const sendMock = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {})
            const api = { sendMessage: sendMock } as unknown as ApiClient

            const { getMessageWindowState } = await import('@/lib/message-window-store')
            const stateMock = vi.mocked(getMessageWindowState)
            const failedAttachmentMessage = {
                id: 'local-att-1',
                seq: null,
                localId: 'local-att-1',
                content: {
                    role: 'user' as const,
                    content: {
                        type: 'text' as const,
                        text: 'photo + text',
                        attachments: [
                            { id: 'att-1', filename: 'x.png', mimeType: 'image/png', size: 1, path: '/x.png' }
                        ]
                    }
                },
                createdAt: 1000,
                invokedAt: null,
                scheduledAt: null,
                status: 'failed' as const,
                originalText: 'photo + text',
            }
            stateMock.mockReturnValue({
                messages: [failedAttachmentMessage],
                pending: []
            } as unknown as ReturnType<typeof getMessageWindowState>)

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A'),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.retryMessage('local-att-1')
            })

            await waitFor(() => {
                expect(sendMock).toHaveBeenCalled()
            })
            const args = sendMock.mock.calls[0]
            expect(args[0]).toBe('session-A')
            expect(args[1]).toBe('photo + text')
            expect(args[2]).toBe('local-att-1')
            expect(args[3]).toEqual([
                { id: 'att-1', filename: 'x.png', mimeType: 'image/png', size: 1, path: '/x.png' }
            ])
        })
    })

    it('does not call onSuccess when blocked', () => {
        const onSuccess = vi.fn()
        const onBlocked = vi.fn()

        const { result } = renderHook(
            () => useSendMessage(null, 'session-A', { onSuccess, onBlocked }),
            { wrapper: createWrapper() },
        )

        act(() => {
            result.current.sendMessage('hello')
        })

        expect(onBlocked).toHaveBeenCalledWith('no-api')
        expect(onSuccess).not.toHaveBeenCalled()
    })

    it('resolves true when the send is accepted', async () => {
        const api = createMockApi()
        const { result } = renderHook(
            () => useSendMessage(api, 'session-A'),
            { wrapper: createWrapper() },
        )
        let acceptedPromise: Promise<boolean> | undefined
        act(() => {
            acceptedPromise = result.current.sendMessage('hello')
        })
        await expect(acceptedPromise!).resolves.toBe(true)
    })

    it('resolves false when blocked (no api) so the caller can preserve schedule state', async () => {
        const onBlocked = vi.fn()
        const { result } = renderHook(
            () => useSendMessage(null, 'session-A', { onBlocked }),
            { wrapper: createWrapper() },
        )
        let acceptedPromise: Promise<boolean> | undefined
        act(() => {
            acceptedPromise = result.current.sendMessage('hello')
        })
        await expect(acceptedPromise!).resolves.toBe(false)
        expect(onBlocked).toHaveBeenCalledWith('no-api')
    })

    it('resolves false when blocked (no session)', async () => {
        const api = createMockApi()
        const { result } = renderHook(
            () => useSendMessage(api, null),
            { wrapper: createWrapper() },
        )
        let acceptedPromise: Promise<boolean> | undefined
        act(() => {
            acceptedPromise = result.current.sendMessage('hello')
        })
        await expect(acceptedPromise!).resolves.toBe(false)
    })

    it('resolves false when resolveSessionId throws (inactive-session resume failure)', async () => {
        const api = createMockApi()
        const resumeError = new Error('resume failed')
        const { result } = renderHook(
            () => useSendMessage(api, 'session-A', {
                resolveSessionId: async () => { throw resumeError },
                onSessionResolved: vi.fn(),
            }),
            { wrapper: createWrapper() },
        )
        let acceptedPromise: Promise<boolean> | undefined
        act(() => {
            acceptedPromise = result.current.sendMessage('hello')
        })
        await expect(acceptedPromise!).resolves.toBe(false)
    })

    it('resolves true after async resolveSessionId succeeds and mutation starts', async () => {
        const api = createMockApi()
        const { result } = renderHook(
            () => useSendMessage(api, 'session-original', {
                resolveSessionId: async () => 'session-resolved',
                onSessionResolved: vi.fn(),
            }),
            { wrapper: createWrapper() },
        )
        let acceptedPromise: Promise<boolean> | undefined
        act(() => {
            acceptedPromise = result.current.sendMessage('hello')
        })
        await expect(acceptedPromise!).resolves.toBe(true)
    })

    // #918: the inactive-session 409 path
    describe('inactive-session 409 (issue #918)', () => {
        it('fires onError with the ApiError so the consumer can render a session_inactive affordance', async () => {
            // Hub returns 409 with code: 'session_inactive' (guards.ts).
            // The api client throws ApiError(status=409, code='session_inactive').
            const onError = vi.fn()
            const api = createMockApi(async () => {
                throw new ApiError(
                    'HTTP 409 Conflict: {"error":"Session is inactive","code":"session_inactive"}',
                    409,
                    'session_inactive',
                    '{"error":"Session is inactive","code":"session_inactive"}'
                )
            })

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('hello inactive')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            const info = onError.mock.calls[0][0] as { text: string; error: unknown; sessionId: string }
            expect(info.text).toBe('hello inactive')
            expect(info.sessionId).toBe('session-A')
            expect(info.error).toBeInstanceOf(ApiError)
            const apiErr = info.error as ApiError
            expect(apiErr.status).toBe(409)
            expect(apiErr.code).toBe('session_inactive')
        })

        it('fires onError when resolveSessionId rejects (pre-mutation inactive-session failure)', async () => {
            // Pre-mutation: the route's resolveSessionId throws when
            // inactiveSessionCanResume returns false OR api.resumeSession
            // fails.  Prior to #918 this dropped the typed text into the
            // void with only a console.error; the operator saw nothing.
            // The hook must surface this through onError too.
            const onError = vi.fn()
            const api = createMockApi()
            const resumeError = new ApiError('Session is inactive', 409, 'session_inactive')

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', {
                    onError,
                    resolveSessionId: async () => { throw resumeError },
                    onSessionResolved: vi.fn(),
                }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('hello pre-mutation')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            const info = onError.mock.calls[0][0] as { text: string; error: unknown; sessionId: string }
            expect(info.text).toBe('hello pre-mutation')
            // Keyed by the ORIGINAL sessionId: pre-mutation never navigated.
            expect(info.sessionId).toBe('session-A')
            expect(info.error).toBe(resumeError)
        })

        it('5xx still uses the legacy text-restore path (#918 must not regress transient-failure UX)', async () => {
            // Acceptance criterion: a real transient 500/network failure
            // must keep the original behavior (remove optimistic row,
            // onError fires with the plain message), not adopt the
            // session_inactive affordance.
            const onError = vi.fn()
            const api = createMockApi(async () => {
                throw new ApiError(
                    'HTTP 500 Internal Server Error',
                    500,
                    undefined,
                    undefined
                )
            })

            const { removeOptimisticMessage } = await import('@/lib/message-window-store')
            const removeMock = vi.mocked(removeOptimisticMessage)

            const { result } = renderHook(
                () => useSendMessage(api, 'session-A', { onError }),
                { wrapper: createWrapper() },
            )

            act(() => {
                result.current.sendMessage('hello transient')
            })

            await waitFor(() => {
                expect(onError).toHaveBeenCalledTimes(1)
            })
            expect(removeMock).toHaveBeenCalledWith('session-A', 'local-id-1')
            const info = onError.mock.calls[0][0] as { error: unknown }
            // No session_inactive code -> consumer renders fallback
            // message, no Reopen action attached.
            expect((info.error as ApiError).code).toBeUndefined()
            expect((info.error as ApiError).status).toBe(500)
        })
    })

    it('preserves scheduledAt when retrying a failed scheduled message', async () => {
        const sendMock = vi.fn(async () => {})
        const api = createMockApi(sendMock)
        const scheduledAt = Date.now() + 5 * 60_000

        const { getMessageWindowState } = await import('@/lib/message-window-store')
        vi.mocked(getMessageWindowState).mockReturnValueOnce({
            messages: [],
            pending: [{
                id: 'local-retry-1',
                seq: null,
                localId: 'local-retry-1',
                content: { role: 'user', content: { type: 'text', text: 'hi later' } },
                createdAt: 1_000,
                invokedAt: null,
                scheduledAt,
                status: 'failed',
                originalText: 'hi later',
            } as never],
        } as never)

        const { result } = renderHook(
            () => useSendMessage(api, 'session-A'),
            { wrapper: createWrapper() },
        )

        act(() => {
            result.current.retryMessage('local-retry-1')
        })

        await waitFor(() => {
            expect(sendMock).toHaveBeenCalled()
        })

        // api.sendMessage(sessionId, text, localId, attachments, scheduledAt)
        expect(sendMock).toHaveBeenCalledWith(
            'session-A',
            'hi later',
            'local-retry-1',
            undefined,
            scheduledAt,
        )
    })
})
