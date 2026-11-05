import { StrictMode, useSyncExternalStore } from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@/types/api'
import { useHappyRuntime } from './assistant-runtime'

describe('assistant-ui composer snapshots', () => {
    it('carries transcript echo eligibility from user blocks into message metadata', () => {
        const session = { id: 'echo-test', active: true, thinking: false } as Session
        const { result } = renderHook(() => useHappyRuntime({
            session,
            blocks: [
                { kind: 'user-text', id: 'echo', localId: null, createdAt: 1, invokedAt: 1, text: 'Echo', meta: { isTranscriptEcho: true } },
                { kind: 'user-text', id: 'terminal', localId: null, createdAt: 2, invokedAt: 2, text: 'Terminal prompt' },
            ],
            messagesVersion: 0, historyVersion: 0, isSending: false, isRunning: false,
            onSendMessage: vi.fn(), onAbort: vi.fn(async () => {}),
        }))
        const messages = result.current.thread.getState().messages
        expect(messages[0]?.metadata.custom).toMatchObject({ sourceMessageId: 'echo', isTranscriptEcho: true })
        expect(messages[1]?.metadata.custom).toMatchObject({ sourceMessageId: 'terminal', isTranscriptEcho: false })
    })
    it('keeps snapshots stable and updates running state without a composer edit', async () => {
        const onSendMessage = vi.fn()
        const onAbort = vi.fn(async () => {})
        const session = { id: 'snapshot-test', active: true, thinking: false } as Session
        const { result, rerender } = renderHook(({ isRunning }) => {
            const runtime = useHappyRuntime({
                session,
                blocks: [],
                messagesVersion: 0,
                historyVersion: 0,
                isSending: false,
                isRunning,
                onSendMessage,
                onAbort,
            })
            const composer = runtime.thread.composer
            const snapshot = useSyncExternalStore(composer.subscribe, composer.getState)
            return { composer, snapshot }
        }, { initialProps: { isRunning: false }, wrapper: StrictMode })

        expect(result.current.snapshot.canCancel).toBe(false)
        expect(result.current.composer.getState()).toBe(result.current.snapshot)

        // Dictation and draft restoration both write through setText.
        act(() => result.current.composer.setText('dictated words'))
        expect(result.current.snapshot.text).toBe('dictated words')
        expect(result.current.composer.getState()).toBe(result.current.snapshot)

        rerender({ isRunning: true })
        expect(result.current.snapshot.canCancel).toBe(true)
        expect(result.current.snapshot.text).toBe('dictated words')
        rerender({ isRunning: false })
        expect(result.current.snapshot.canCancel).toBe(false)

        await act(async () => result.current.composer.send())
        expect(onSendMessage).toHaveBeenCalledExactlyOnceWith('dictated words', undefined, null, 'default')
        expect(result.current.snapshot.text).toBe('')
        expect(result.current.composer.getState()).toBe(result.current.snapshot)
    })
})
