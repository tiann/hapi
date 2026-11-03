import { describe, expect, it } from 'vitest'
import {
    clearPostCloseGateForNewUserPrompt,
    createPostCloseHarnessGate,
    noteAssistantTextForPostCloseGate,
    shouldSuppressPostCloseHarnessMessage,
    shouldSuppressPostCloseHarnessThinking,
    truncateCoalescedHarnessAfterDoneFooter
} from './postCloseHarnessSilence'

const DONE_FOOTER =
    'AGENT_NOTIFY_SUMMARY {"version":1,"agent":"a","project":"hapi","status":"done","summary":"Finished the topic"}'

const BLOCKED_FOOTER =
    'AGENT_NOTIFY_SUMMARY {"version":1,"agent":"a","project":"hapi","status":"blocked","summary":"Need a decision"}'

describe('postCloseHarnessSilence (#2267)', () => {
    it('suppresses harness speech after done even while promptInFlight (drain window)', () => {
        const gate = createPostCloseHarnessGate()
        noteAssistantTextForPostCloseGate(gate, `Answer.\n\n${DONE_FOOTER}`)

        expect(shouldSuppressPostCloseHarnessMessage(gate, {
            promptInFlight: true,
            messageType: 'text'
        })).toBe(true)
        expect(shouldSuppressPostCloseHarnessThinking(gate, {
            promptInFlight: true,
            thinking: true
        })).toBe(true)
    })

    it('does not suppress while a soft-steer is still outstanding after done (Codex P2)', () => {
        const gate = createPostCloseHarnessGate()
        noteAssistantTextForPostCloseGate(gate, `Answer.\n\n${DONE_FOOTER}`)

        expect(shouldSuppressPostCloseHarnessMessage(gate, {
            promptInFlight: false,
            softSteerOutstanding: true,
            messageType: 'text'
        })).toBe(false)
        expect(shouldSuppressPostCloseHarnessThinking(gate, {
            promptInFlight: false,
            softSteerOutstanding: true,
            thinking: true
        })).toBe(false)
    })

    it('suppresses harness-resume speech after done once noted', () => {
        const gate = createPostCloseHarnessGate()
        noteAssistantTextForPostCloseGate(gate, `Answer.\n\n${DONE_FOOTER}`)

        expect(shouldSuppressPostCloseHarnessMessage(gate, {
            promptInFlight: false,
            messageType: 'text'
        })).toBe(true)
        expect(shouldSuppressPostCloseHarnessMessage(gate, {
            promptInFlight: false,
            messageType: 'reasoning'
        })).toBe(true)
    })

    it('still forwards tools after done so premature-done follow-up work stays visible', () => {
        const gate = createPostCloseHarnessGate()
        noteAssistantTextForPostCloseGate(gate, `Answer.\n\n${DONE_FOOTER}`)

        expect(shouldSuppressPostCloseHarnessMessage(gate, {
            promptInFlight: false,
            messageType: 'tool_call'
        })).toBe(false)
        expect(shouldSuppressPostCloseHarnessMessage(gate, {
            promptInFlight: false,
            messageType: 'tool_result'
        })).toBe(false)
        expect(shouldSuppressPostCloseHarnessMessage(gate, {
            promptInFlight: false,
            messageType: 'plan'
        })).toBe(false)
    })

    it('does not suppress after non-done status (blocked still allows harness follow-up speech)', () => {
        const gate = createPostCloseHarnessGate()
        noteAssistantTextForPostCloseGate(gate, `Waiting.\n\n${BLOCKED_FOOTER}`)

        expect(shouldSuppressPostCloseHarnessMessage(gate, {
            promptInFlight: false,
            messageType: 'text'
        })).toBe(false)
    })

    it('ignores live interim text snapshots when noting the gate', () => {
        const gate = createPostCloseHarnessGate()
        noteAssistantTextForPostCloseGate(gate, `Partial\n\n${DONE_FOOTER}`, { live: true })

        expect(shouldSuppressPostCloseHarnessMessage(gate, {
            promptInFlight: false,
            messageType: 'text'
        })).toBe(false)
    })

    it('clears the done gate when the next prompt handler swap reopens speech', () => {
        const gate = createPostCloseHarnessGate()
        noteAssistantTextForPostCloseGate(gate, `Answer.\n\n${DONE_FOOTER}`)
        clearPostCloseGateForNewUserPrompt(gate)

        expect(shouldSuppressPostCloseHarnessMessage(gate, {
            promptInFlight: true,
            messageType: 'text'
        })).toBe(false)
    })

    it('replaces a prior done close when a later settled footer is not done', () => {
        const gate = createPostCloseHarnessGate()
        noteAssistantTextForPostCloseGate(gate, `Answer.\n\n${DONE_FOOTER}`)
        noteAssistantTextForPostCloseGate(gate, `Need input.\n\n${BLOCKED_FOOTER}`)

        expect(shouldSuppressPostCloseHarnessMessage(gate, {
            promptInFlight: false,
            messageType: 'text'
        })).toBe(false)
    })

    it('still surfaces errors and usage during post-done harness resume', () => {
        const gate = createPostCloseHarnessGate()
        noteAssistantTextForPostCloseGate(gate, `Answer.\n\n${DONE_FOOTER}`)

        expect(shouldSuppressPostCloseHarnessMessage(gate, {
            promptInFlight: false,
            messageType: 'error'
        })).toBe(false)
        expect(shouldSuppressPostCloseHarnessMessage(gate, {
            promptInFlight: false,
            messageType: 'usage'
        })).toBe(false)
    })

    it('documents that the done-closing text itself is noted after the suppress check so it is not dropped', () => {
        const gate = createPostCloseHarnessGate()
        expect(shouldSuppressPostCloseHarnessMessage(gate, {
            promptInFlight: false,
            messageType: 'text'
        })).toBe(false)
        noteAssistantTextForPostCloseGate(gate, `Answer.\n\n${DONE_FOOTER}`)
        expect(shouldSuppressPostCloseHarnessMessage(gate, {
            promptInFlight: false,
            messageType: 'text'
        })).toBe(true)
    })

    it('does not close the gate from a mid-body done footer (end-anchor only on note)', () => {
        const gate = createPostCloseHarnessGate()
        noteAssistantTextForPostCloseGate(
            gate,
            `Answer.\n\n${DONE_FOOTER}\nShell finished; here is a redundant summary.`
        )

        expect(shouldSuppressPostCloseHarnessMessage(gate, {
            promptInFlight: true,
            messageType: 'text'
        })).toBe(false)
    })

    it('truncates coalesced harness prose after an unfenced done footer', () => {
        const coalesced = `Answer.\n\n${DONE_FOOTER}\nShell finished; here is a redundant summary.`
        expect(truncateCoalescedHarnessAfterDoneFooter(coalesced)).toBe(`Answer.\n\n${DONE_FOOTER}`)
        expect(truncateCoalescedHarnessAfterDoneFooter(`Answer.\n\n${DONE_FOOTER}`)).toBeNull()
        expect(truncateCoalescedHarnessAfterDoneFooter(
            `Waiting.\n\n${BLOCKED_FOOTER}\nMore explanation.`
        )).toBeNull()
    })

    it('truncates same-line glued harness prose after the done JSON object', () => {
        const glued = `Answer.\n\n${DONE_FOOTER}Shell finished; redundant.`
        expect(truncateCoalescedHarnessAfterDoneFooter(glued)).toBe(`Answer.\n\n${DONE_FOOTER}`)
    })

    it('preserves fenced done-footer examples used as documentation', () => {
        const docs = [
            'Use this footer:',
            '```',
            DONE_FOOTER,
            '```',
            'Then the hub will notify you.'
        ].join('\n')
        expect(truncateCoalescedHarnessAfterDoneFooter(docs)).toBeNull()
    })

    it('preserves tilde-fenced done-footer examples', () => {
        const docs = [
            'Example:',
            '~~~json',
            DONE_FOOTER,
            '~~~',
            'Then the hub will notify you.'
        ].join('\n')
        expect(truncateCoalescedHarnessAfterDoneFooter(docs)).toBeNull()
    })

    it('skips truncation while a soft-steer is outstanding', () => {
        const coalesced = `Answer.\n\n${DONE_FOOTER}\nSteered follow-up the user asked for.`
        expect(truncateCoalescedHarnessAfterDoneFooter(coalesced, {
            softSteerOutstanding: true
        })).toBeNull()
    })

    it('preserves inline-code footer examples', () => {
        const docs = 'Use `' + DONE_FOOTER + '` to close a turn, then explain more.'
        expect(truncateCoalescedHarnessAfterDoneFooter(docs)).toBeNull()
    })

    it('truncates after a done footer whose summary contains brace characters', () => {
        const footer =
            'AGENT_NOTIFY_SUMMARY {"version":1,"agent":"a","project":"hapi","status":"done","summary":"Fixed handling of the } character"}'
        const coalesced = `Answer.\n\n${footer}Shell finished; redundant.`
        expect(truncateCoalescedHarnessAfterDoneFooter(coalesced)).toBe(`Answer.\n\n${footer}`)
    })
})
