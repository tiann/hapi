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

    it('closes the gate when a done footer is buried under coalesced harness prose (#2268)', () => {
        const gate = createPostCloseHarnessGate()
        noteAssistantTextForPostCloseGate(
            gate,
            `Answer.\n\n${DONE_FOOTER}\nShell finished; here is a redundant summary.`
        )

        expect(shouldSuppressPostCloseHarnessMessage(gate, {
            promptInFlight: true,
            messageType: 'text'
        })).toBe(true)
    })

    it('truncates coalesced harness prose after a done footer for the launcher forward path', () => {
        const coalesced = `Answer.\n\n${DONE_FOOTER}\nShell finished; here is a redundant summary.`
        expect(truncateCoalescedHarnessAfterDoneFooter(coalesced)).toBe(`Answer.\n\n${DONE_FOOTER}`)
        expect(truncateCoalescedHarnessAfterDoneFooter(`Answer.\n\n${DONE_FOOTER}`)).toBeNull()
        expect(truncateCoalescedHarnessAfterDoneFooter(
            `Waiting.\n\n${BLOCKED_FOOTER}\nMore explanation.`
        )).toBeNull()
    })
})
