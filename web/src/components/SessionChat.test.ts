import { describe, expect, it, vi } from 'vitest'
import {
    applyModelChangeWithReasoningRollback,
    buildGoalStateMessages,
    isScratchlistHotkeyBlockedTarget,
    isScratchlistToggleHotkey,
    resolvePiContextWindow,
    shouldAutoClearPendingSchedule,
    shouldRouteToScratchlist,
} from './SessionChat'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import type { AttachmentMetadata, DecryptedMessage } from '@/types/api'

describe('applyModelChangeWithReasoningRollback', () => {
    it('restores the previous effort when the model switch fails after clearing it', async () => {
        const modelError = new Error('model switch failed')
        const setModel = vi.fn(async () => { throw modelError })
        const setModelReasoningEffort = vi.fn(async () => {})

        await expect(applyModelChangeWithReasoningRollback({
            model: 'gpt-next',
            previousModelReasoningEffort: 'extreme',
            shouldClearReasoningEffort: true,
            setModel,
            setModelReasoningEffort
        })).rejects.toBe(modelError)

        expect(setModelReasoningEffort.mock.calls).toEqual([[null], ['extreme']])
        expect(setModel).toHaveBeenCalledWith('gpt-next')
    })

    it('keeps the cleared effort when the model switch succeeds', async () => {
        const setModel = vi.fn(async () => {})
        const setModelReasoningEffort = vi.fn(async () => {})

        await applyModelChangeWithReasoningRollback({
            model: 'gpt-next',
            previousModelReasoningEffort: 'extreme',
            shouldClearReasoningEffort: true,
            setModel,
            setModelReasoningEffort
        })

        expect(setModelReasoningEffort).toHaveBeenCalledOnce()
        expect(setModelReasoningEffort).toHaveBeenCalledWith(null)
        expect(setModel).toHaveBeenCalledWith('gpt-next')
    })
})

describe('resolvePiContextWindow', () => {
    const models = [
        { provider: 'provider-a', modelId: 'shared-model', contextWindow: 100_000 },
        { provider: 'provider-b', modelId: 'shared-model', contextWindow: 200_000 },
    ]

    it('uses the provider-qualified selected model when model ids collide', () => {
        expect(resolvePiContextWindow(
            models,
            { provider: 'provider-b', modelId: 'shared-model' },
            'shared-model',
        )).toBe(200_000)
    })

    it('falls back to the legacy model id when selected-model metadata is absent', () => {
        expect(resolvePiContextWindow(models, undefined, 'shared-model')).toBe(100_000)
    })
})

function userMessage(props: {
    id: string
    createdAt: number
    localId?: string | null
    invokedAt?: number | null
    scheduledAt?: number | null
}): DecryptedMessage {
    return {
        id: props.id,
        seq: null,
        localId: props.localId ?? null,
        content: {
            role: 'user',
            content: {
                type: 'text',
                text: 'hello'
            }
        },
        createdAt: props.createdAt,
        invokedAt: props.invokedAt,
        scheduledAt: props.scheduledAt
    }
}

/**
 * Unit tests for shouldAutoClearPendingSchedule.
 *
 * The useEffect in SessionChat auto-clears only 'absolute' pending schedules
 * when the chosen time expires.  'preset' schedules must NOT be auto-cleared
 * because they are relative to send time and have no fixed expiry.
 *
 * This test guards against future refactors that accidentally break the
 * preset-stays-alive invariant (a silent break: the effect would cancel the
 * preset with no user-visible error before send time).
 */
describe('shouldAutoClearPendingSchedule', () => {
    it('returns false for null (no schedule set)', () => {
        expect(shouldAutoClearPendingSchedule(null)).toBe(false)
    })

    it('returns false for preset schedule — presets do not expire before send', () => {
        const preset: PendingSchedule = { type: 'preset', preset: '+5m' }
        expect(shouldAutoClearPendingSchedule(preset)).toBe(false)
    })

    it('returns false for all preset values', () => {
        const presets: Array<'+5m' | '+30m' | '+1h' | '+4h'> = ['+5m', '+30m', '+1h', '+4h']
        for (const p of presets) {
            const pending: PendingSchedule = { type: 'preset', preset: p }
            expect(shouldAutoClearPendingSchedule(pending)).toBe(false)
        }
    })

    it('returns true for absolute schedule — absolute schedules have a fixed expiry instant', () => {
        const absolute: PendingSchedule = { type: 'absolute', ms: Date.now() + 60_000 }
        expect(shouldAutoClearPendingSchedule(absolute)).toBe(true)
    })

    it('returns true for expired absolute schedule (ms in the past)', () => {
        const expired: PendingSchedule = { type: 'absolute', ms: Date.now() - 1000 }
        expect(shouldAutoClearPendingSchedule(expired)).toBe(true)
    })
})

/**
 * Unit tests for shouldRouteToScratchlist.
 *
 * Regression cover for upstream review on PR #798 (github-actions[bot]
 * [Major]): scratchlist-mode submissions used to silently drop
 * attachments and scheduledAt because the wrapper short-circuited to
 * scratchlist.add(text) regardless of payload. The fix is to fall
 * through to the regular chat send whenever the submission can't be
 * represented as a pure-text scratchlist entry.
 */
describe('shouldRouteToScratchlist', () => {
    function attachment(): AttachmentMetadata {
        return {
            id: 'attach-1',
            filename: 'attach-1.png',
            mimeType: 'image/png',
            size: 1024,
            path: '/tmp/attach-1.png',
        }
    }

    it('returns false when scratchlist mode is off, regardless of payload', () => {
        expect(shouldRouteToScratchlist(false, undefined, null)).toBe(false)
        expect(shouldRouteToScratchlist(false, [attachment()], null)).toBe(false)
        expect(shouldRouteToScratchlist(false, undefined, Date.now() + 60_000)).toBe(false)
    })

    it('returns true when scratchlist mode is on and the payload is pure text', () => {
        expect(shouldRouteToScratchlist(true, undefined, null)).toBe(true)
        expect(shouldRouteToScratchlist(true, undefined, undefined)).toBe(true)
        expect(shouldRouteToScratchlist(true, [], null)).toBe(true)
    })

    it('returns false when scratchlist mode is on but attachments are present', () => {
        expect(shouldRouteToScratchlist(true, [attachment()], null)).toBe(false)
        expect(shouldRouteToScratchlist(true, [attachment(), attachment()], null)).toBe(false)
    })

    it('returns false when scratchlist mode is on but a scheduled-send is set', () => {
        expect(shouldRouteToScratchlist(true, undefined, Date.now() + 60_000)).toBe(false)
        expect(shouldRouteToScratchlist(true, [], 0)).toBe(false)
    })

    it('returns false when both attachments and scheduledAt are set', () => {
        expect(shouldRouteToScratchlist(true, [attachment()], Date.now() + 60_000)).toBe(false)
    })

    /**
     * Bot follow-up on PR #798: handleSend gates pendingSchedule cleanup on
     * routedToScratchlist, not scratchlistMode. So a scheduled chat send made
     * while the scratchlist toggle is on (which falls through to chat per
     * the previous tests) MUST also trigger schedule clear + scroll bump.
     * This test pins the decision matrix that handleSend depends on.
     */
    it('cleanup gate: scheduled chat send while scratchlist toggle is on still clears schedule', () => {
        const scheduledAt = Date.now() + 60_000
        // Scenario: mode on, no attachments, scheduled. shouldRouteToScratchlist
        // must return false so handleSend's `if (!routedToScratchlist)` runs
        // setPendingSchedule(null).
        const routed = shouldRouteToScratchlist(true, undefined, scheduledAt)
        expect(routed).toBe(false)
        const shouldClearAfterAccepted = !routed
        expect(shouldClearAfterAccepted).toBe(true)
    })

    it('cleanup gate: pure-text scratchlist add does NOT clear schedule', () => {
        const routed = shouldRouteToScratchlist(true, undefined, null)
        expect(routed).toBe(true)
        const shouldClearAfterAccepted = !routed
        expect(shouldClearAfterAccepted).toBe(false)
    })
})

describe('isScratchlistToggleHotkey', () => {
    function k(over: Partial<{
        metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string
    }>): { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string } {
        return { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: '', ...over }
    }

    it('matches Ctrl+Shift+S (Linux/Windows)', () => {
        expect(isScratchlistToggleHotkey(k({ ctrlKey: true, shiftKey: true, key: 'S' }))).toBe(true)
        expect(isScratchlistToggleHotkey(k({ ctrlKey: true, shiftKey: true, key: 's' }))).toBe(true)
    })

    it('matches Cmd+Shift+S (macOS)', () => {
        expect(isScratchlistToggleHotkey(k({ metaKey: true, shiftKey: true, key: 'S' }))).toBe(true)
    })

    it('rejects Cmd/Ctrl + S without shift (browser Save)', () => {
        // Browsers reserve Ctrl-S / Cmd-S for "Save Page". The toggle MUST
        // require shift so the user's save-page muscle memory keeps working.
        expect(isScratchlistToggleHotkey(k({ ctrlKey: true, key: 's' }))).toBe(false)
        expect(isScratchlistToggleHotkey(k({ metaKey: true, key: 's' }))).toBe(false)
    })

    it('rejects bare S / Shift+S (literal typing)', () => {
        expect(isScratchlistToggleHotkey(k({ key: 's' }))).toBe(false)
        expect(isScratchlistToggleHotkey(k({ shiftKey: true, key: 'S' }))).toBe(false)
    })

    it('rejects when Alt is also held (avoid clashes with OS shortcuts)', () => {
        expect(isScratchlistToggleHotkey(k({
            ctrlKey: true, shiftKey: true, altKey: true, key: 'S',
        }))).toBe(false)
    })

    it('rejects unrelated keys', () => {
        expect(isScratchlistToggleHotkey(k({ ctrlKey: true, shiftKey: true, key: 'A' }))).toBe(false)
        expect(isScratchlistToggleHotkey(k({ ctrlKey: true, shiftKey: true, key: 'Tab' }))).toBe(false)
    })
})

describe('isScratchlistHotkeyBlockedTarget', () => {
    // Note: tests run under jsdom, so HTMLElement / HTMLInputElement etc.
    // are real constructors that we can construct via document.createElement.

    it('blocks hotkey when focus is in a single-line input', () => {
        const input = document.createElement('input')
        expect(isScratchlistHotkeyBlockedTarget(input)).toBe(true)
    })

    it('blocks hotkey when focus is in a select element', () => {
        const select = document.createElement('select')
        expect(isScratchlistHotkeyBlockedTarget(select)).toBe(true)
    })

    it('blocks hotkey when focus is on a contentEditable host', () => {
        const div = document.createElement('div')
        div.setAttribute('contenteditable', 'true')
        expect(isScratchlistHotkeyBlockedTarget(div)).toBe(true)
    })

    it('blocks hotkey when focus is anywhere inside a [role=dialog]', () => {
        const dialog = document.createElement('div')
        dialog.setAttribute('role', 'dialog')
        const inner = document.createElement('button')
        dialog.appendChild(inner)
        document.body.appendChild(dialog)
        expect(isScratchlistHotkeyBlockedTarget(inner)).toBe(true)
        document.body.removeChild(dialog)
    })

    it('does NOT block hotkey when focus is on the composer textarea', () => {
        // The composer textarea is the EXPECTED focus target when the
        // operator presses the shortcut. Blocking it would defeat the
        // shortcut entirely.
        const textarea = document.createElement('textarea')
        expect(isScratchlistHotkeyBlockedTarget(textarea)).toBe(false)
    })

    it('does NOT block hotkey when focus is on a regular button', () => {
        const button = document.createElement('button')
        expect(isScratchlistHotkeyBlockedTarget(button)).toBe(false)
    })

    it('does NOT block hotkey when target is null (unfocused)', () => {
        expect(isScratchlistHotkeyBlockedTarget(null)).toBe(false)
    })

    it('does NOT block hotkey when target is non-Element (e.g. window)', () => {
        // Some keyboard events come with a non-Element target (e.g. window
        // before focus settles). Should fall through.
        expect(isScratchlistHotkeyBlockedTarget(window as unknown as EventTarget)).toBe(false)
    })
})

describe('buildGoalStateMessages', () => {
    it('keeps immediate queued user messages so completed goal status can clear before timeline render', () => {
        const now = 1_700_000_000_000
        const messages = [
            userMessage({
                id: 'local-immediate',
                localId: 'local-immediate',
                createdAt: now,
                invokedAt: null
            })
        ]

        expect(buildGoalStateMessages(messages).map((message) => message.id))
            .toEqual(['local-immediate'])
    })

    it('includes pending messages that are outside the visible timeline window', () => {
        const now = 1_700_000_000_000
        const visible = [
            userMessage({ id: 'visible', createdAt: now - 10 })
        ]
        const pending = [
            userMessage({ id: 'pending', createdAt: now })
        ]

        expect(buildGoalStateMessages(visible, pending).map((message) => message.id))
            .toEqual(['visible', 'pending'])
    })

    it('ignores uninvoked scheduled messages, including mature prompts, until they are invoked', () => {
        const now = 1_700_000_000_000
        const futureQueued = userMessage({
            id: 'future',
            createdAt: now,
            invokedAt: null,
            scheduledAt: now + 60_000
        })
        const matureQueued = userMessage({
            id: 'mature',
            createdAt: now + 1,
            invokedAt: null,
            scheduledAt: now - 60_000
        })
        const invokedScheduled = userMessage({
            id: 'invoked',
            createdAt: now + 2,
            invokedAt: now + 30_000,
            scheduledAt: now - 60_000
        })

        expect(buildGoalStateMessages([futureQueued, matureQueued, invokedScheduled]).map((message) => message.id))
            .toEqual(['invoked'])
    })
})
