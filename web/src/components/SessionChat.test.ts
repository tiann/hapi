import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    applyGlobalSelectAll,
    applyModelChangeWithReasoningRollback,
    buildGoalStateMessages,
    isScratchlistHotkeyBlockedTarget,
    isScratchlistToggleHotkey,
    isSelectAllTargetBlocked,
    mergeStagedAttachmentsInOrder,
    resolvePiContextWindow,
    resolveLatestCompletedBoundaryIdForView,
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

describe('resolveLatestCompletedBoundaryIdForView', () => {
    it('uses the live tail boundary when following the latest messages', () => {
        expect(resolveLatestCompletedBoundaryIdForView('tail', 'agent-text:latest', {
            id: 'agent-text:old',
            tailRevision: 1
        }, 2))
            .toBe('agent-text:latest')
    })

    it('keeps the live tail boundary while reading older messages', () => {
        expect(resolveLatestCompletedBoundaryIdForView('history', null, {
            id: 'agent-text:latest',
            tailRevision: 2
        }, 2))
            .toBe('agent-text:latest')
    })

    it('invalidates the remembered boundary after a live tail revision', () => {
        expect(resolveLatestCompletedBoundaryIdForView('history', null, {
            id: 'agent-text:old',
            tailRevision: 2
        }, 3)).toBeNull()
    })

    it('does not invent a boundary before the tail has been observed', () => {
        expect(resolveLatestCompletedBoundaryIdForView('history', null, null, 0)).toBeNull()
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
 * Regression cover for upstream review on PR #798 / #1205: scratchlist-mode
 * submissions must fall through to chat when the payload cannot be parked
 * (schedule set, or any attachment still on a normal CLI upload path).
 */
describe('shouldRouteToScratchlist', () => {
    function attachment(path = '/tmp/attach-1.png'): AttachmentMetadata {
        return {
            id: 'attach-1',
            filename: 'attach-1.png',
            mimeType: 'image/png',
            size: 1024,
            path,
        }
    }

    function hubAttachment(): AttachmentMetadata {
        return attachment('hapi-hub:scratchlist/default/session-1/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-a.png')
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

    it('returns true when every attachment is already hub-resident', () => {
        expect(shouldRouteToScratchlist(true, [hubAttachment()], null)).toBe(true)
        expect(shouldRouteToScratchlist(true, [hubAttachment(), hubAttachment()], null)).toBe(true)
    })

    it('returns false when any attachment still has a normal CLI path', () => {
        expect(shouldRouteToScratchlist(true, [attachment()], null)).toBe(false)
        expect(shouldRouteToScratchlist(true, [hubAttachment(), attachment()], null)).toBe(false)
    })

    it('returns false when scratchlist mode is on but a scheduled-send is set', () => {
        expect(shouldRouteToScratchlist(true, undefined, Date.now() + 60_000)).toBe(false)
        expect(shouldRouteToScratchlist(true, [], 0)).toBe(false)
    })

    it('returns false when both attachments and scheduledAt are set', () => {
        expect(shouldRouteToScratchlist(true, [hubAttachment()], Date.now() + 60_000)).toBe(false)
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

describe('mergeStagedAttachmentsInOrder', () => {
    function attachment(id: string, path: string): AttachmentMetadata {
        return {
            id,
            filename: `${id}.png`,
            mimeType: 'image/png',
            size: 1024,
            path,
        }
    }

    it('replaces staged hub attachments without changing mixed attachment order', () => {
        const hubAttachment = attachment('hub-a', 'hapi-hub:scratchlist/default/session/hub-a.png')
        const normalAttachment = attachment('normal-b', '/tmp/normal-b.png')
        const stagedAttachment = attachment('hub-a', '/tmp/staged-hub-a.png')

        expect(mergeStagedAttachmentsInOrder(
            [hubAttachment, normalAttachment],
            [stagedAttachment],
        )).toEqual([stagedAttachment, normalAttachment])
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

describe('isSelectAllTargetBlocked', () => {
    it('blocks select-all takeover when focus is in the rich composer (contentEditable)', () => {
        const composer = document.createElement('div')
        composer.setAttribute('contenteditable', 'plaintext-only')
        expect(isSelectAllTargetBlocked(composer)).toBe(true)
    })

    it('blocks select-all takeover when focus is in a textarea (fallback composer)', () => {
        const textarea = document.createElement('textarea')
        expect(isSelectAllTargetBlocked(textarea)).toBe(true)
    })

    it('blocks select-all takeover when focus is in a single-line input', () => {
        const input = document.createElement('input')
        expect(isSelectAllTargetBlocked(input)).toBe(true)
    })

    it('blocks select-all takeover when focus is anywhere inside a [role=dialog]', () => {
        const dialog = document.createElement('div')
        dialog.setAttribute('role', 'dialog')
        const inner = document.createElement('button')
        dialog.appendChild(inner)
        document.body.appendChild(dialog)
        expect(isSelectAllTargetBlocked(inner)).toBe(true)
        document.body.removeChild(dialog)
    })

    it('does NOT block select-all takeover when focus is on the message thread / body', () => {
        const message = document.createElement('div')
        expect(isSelectAllTargetBlocked(message)).toBe(false)
        expect(isSelectAllTargetBlocked(document.body)).toBe(false)
    })

    it('does NOT block select-all takeover when target is null or non-Element', () => {
        expect(isSelectAllTargetBlocked(null)).toBe(false)
        expect(isSelectAllTargetBlocked(window as unknown as EventTarget)).toBe(false)
    })
})

describe('applyGlobalSelectAll', () => {
    function setupThread(): HTMLElement {
        const thread = document.createElement('div')
        thread.className = 'happy-thread-messages'
        const message = document.createElement('div')
        message.textContent = 'assistant reply text'
        thread.appendChild(message)
        document.body.appendChild(thread)
        return thread
    }

    afterEach(() => {
        window.getSelection()?.removeAllRanges()
        document.body.innerHTML = ''
    })

    it('selects the message thread for Ctrl+A when focus is on the page body', () => {
        setupThread()
        const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, cancelable: true })
        expect(applyGlobalSelectAll(event)).toBe(true)
        expect(event.defaultPrevented).toBe(true)
        const selection = window.getSelection()
        expect(selection?.toString()).toBe('assistant reply text')
    })

    it('ignores non-Ctrl/Cmd+A shortcuts', () => {
        setupThread()
        for (const event of [
            new KeyboardEvent('keydown', { key: 'a' }),
            new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, altKey: true }),
            new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, shiftKey: true }),
            new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }),
        ]) {
            expect(applyGlobalSelectAll(event)).toBe(false)
            expect(event.defaultPrevented).toBe(false)
        }
    })

    it('leaves select-all to the browser when focus is in the composer', () => {
        setupThread()
        const composer = document.createElement('div')
        composer.setAttribute('contenteditable', 'plaintext-only')
        const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, cancelable: true })
        Object.defineProperty(event, 'target', { value: composer })
        expect(applyGlobalSelectAll(event)).toBe(false)
        expect(event.defaultPrevented).toBe(false)
        expect(window.getSelection()?.toString()).toBe('')
    })

    it('does nothing when the thread is absent', () => {
        const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, cancelable: true })
        expect(applyGlobalSelectAll(event)).toBe(false)
        expect(event.defaultPrevented).toBe(false)
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

    it('uses every canonical message even when the thread hides queued rows', () => {
        const now = 1_700_000_000_000
        const messages = [
            userMessage({ id: 'visible', createdAt: now - 10 }),
            userMessage({ id: 'pending', createdAt: now })
        ]

        expect(buildGoalStateMessages(messages).map((message) => message.id))
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
