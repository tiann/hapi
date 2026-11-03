import { describe, expect, it } from 'vitest'
import {
    clearPostCloseGateForNewUserPrompt,
    createPostCloseHarnessGate,
    noteAssistantTextForPostCloseGate,
    shouldSuppressPostCloseHarnessMessage,
    shouldSuppressPostCloseHarnessThinking
} from './postCloseHarnessSilence'

const DONE_FOOTER =
    'AGENT_NOTIFY_SUMMARY {"version":1,"agent":"a","project":"hapi","status":"done","summary":"Finished the topic"}'

const BLOCKED_FOOTER =
    'AGENT_NOTIFY_SUMMARY {"version":1,"agent":"a","project":"hapi","status":"blocked","summary":"Need a decision"}'

describe('postCloseHarnessSilence (#2267)', () => {
    it('does not suppress while a HAPI-owned prompt is in flight, even after done footer', () => {
        const gate = createPostCloseHarnessGate()
        noteAssistantTextForPostCloseGate(gate, `Answer.\n\n${DONE_FOOTER}`)

        expect(shouldSuppressPostCloseHarnessMessage(gate, {
            promptInFlight: true,
            messageType: 'text'
        })).toBe(false)
    })

    it('suppresses harness-resume speech after done once the HAPI prompt has ended', () => {
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
        expect(shouldSuppressPostCloseHarnessThinking(gate, {
            promptInFlight: false,
            thinking: true
        })).toBe(true)
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

    it('clears the done gate when a new HAPI user prompt starts', () => {
        const gate = createPostCloseHarnessGate()
        noteAssistantTextForPostCloseGate(gate, `Answer.\n\n${DONE_FOOTER}`)
        clearPostCloseGateForNewUserPrompt(gate)

        expect(shouldSuppressPostCloseHarnessMessage(gate, {
            promptInFlight: false,
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
        // Launcher contract: evaluate suppress on the *prior* gate state, then
        // note. A settled done footer while the gate is still open must forward.
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
})
