import { act, fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { getComposerEscapeAction, type TextInputState, useRichComposerBridge } from './HappyComposer'

const events = vi.hoisted(() => [] as string[])

vi.mock('@assistant-ui/tap', () => ({
    flushTapSync: (callback: () => void) => {
        events.push('flush:start')
        callback()
        events.push('flush:end')
    },
}))

type Bridge = ReturnType<typeof useRichComposerBridge>

function BridgeHarness(props: {
    callbacksRef: { current: Bridge | null }
    api: {
        composer: () => {
            setText: (text: string) => void
        }
    }
}) {
    const [inputState, setInputState] = useState<TextInputState>({
        text: '',
        selection: { start: 0, end: 0 },
    })
    const [, setUnrelatedVersion] = useState(0)
    const bridge = useRichComposerBridge(props.api, setInputState, null)
    props.callbacksRef.current = bridge

    useEffect(() => {
        if (inputState.text) events.push(`mirror-render:${inputState.text}`)
    }, [inputState])

    return (
        <button type="button" onClick={() => setUnrelatedVersion((version) => version + 1)}>
            Unrelated rerender
        </button>
    )
}

describe('useRichComposerBridge', () => {
    it('flushes the composer write before mirror render and keeps callbacks stable across unrelated renders', () => {
        const callbacksRef: { current: Bridge | null } = { current: null }
        const api = {
            composer: () => ({
                setText: (text: string) => events.push(`setText:${text}`),
            }),
        }

        render(<BridgeHarness callbacksRef={callbacksRef} api={api} />)
        const initial = callbacksRef.current
        expect(initial).not.toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'Unrelated rerender' }))

        expect(callbacksRef.current?.onValueChange).toBe(initial?.onValueChange)
        expect(callbacksRef.current?.onMirrorChange).toBe(initial?.onMirrorChange)
        expect(callbacksRef.current?.onEdit).toBe(initial?.onEdit)

        events.length = 0
        act(() => {
            callbacksRef.current!.onValueChange('new composer text')
            callbacksRef.current!.onMirrorChange({
                text: 'mirror text',
                selection: { start: 11, end: 11 },
            })
        })

        expect(events).toEqual([
            'flush:start',
            'setText:new composer text',
            'flush:end',
            'mirror-render:mirror text',
        ])
    })
})

describe('getComposerEscapeAction', () => {
    it('clears suggestions before aborting, and aborts before collapsing', () => {
        expect(getComposerEscapeAction({
            hasSuggestions: true,
            threadIsRunning: true,
            isExpanded: true,
        })).toBe('clearSuggestions')
        expect(getComposerEscapeAction({
            hasSuggestions: false,
            threadIsRunning: true,
            isExpanded: true,
        })).toBe('abort')
        expect(getComposerEscapeAction({
            hasSuggestions: false,
            threadIsRunning: false,
            isExpanded: true,
        })).toBe('collapse')
    })
})
