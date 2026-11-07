import { describe, expect, it } from 'vitest'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import { resolveAssistantForkPoints } from './assistant-fork-points'

const user = (id: string): VisibleChatBlock => ({
    kind: 'user-text', id, localId: id, createdAt: 1, invokedAt: 1, text: id
})
const assistant = (id: string): VisibleChatBlock => ({
    kind: 'agent-text', id, localId: null, createdAt: 2, text: id
})

describe('resolveAssistantForkPoints', () => {
    it('uses the next prompt as an exclusive boundary after the assistant turn', () => {
        const result = resolveAssistantForkPoints([
            user('u1'), assistant('a1'), assistant('a1-continuation'),
            user('u2'), assistant('a2'), user('u3'), assistant('a3')
        ], { u1: true, u2: true, u3: true })
        expect([...result]).toEqual([['agent-text:a1', 'u2'], ['agent-text:a2', 'u3']])
    })

    it('does not skip a missing point to find a later usable prompt', () => {
        const result = resolveAssistantForkPoints([
            user('u1'), assistant('a1'), user('u2'), assistant('a2'), user('u3')
        ], { u3: true })
        expect([...result]).toEqual([['agent-text:a2', 'u3']])
    })

    it('does not guess boundaries for imported history without native points', () => {
        expect(resolveAssistantForkPoints([assistant('a1'), user('u2')], undefined).size).toBe(0)
    })

    it('preserves the rendered card id when reasoning starts or continues a reply', () => {
        const reasoning: VisibleChatBlock = { kind: 'agent-reasoning', id: 'r1', localId: null, createdAt: 2, text: 'thinking' }
        expect([...resolveAssistantForkPoints([
            user('u1'), reasoning, assistant('a1'), { ...reasoning, id: 'r2' }, user('u2')
        ], { u2: true })]).toEqual([['agent-reasoning:r1', 'u2']])
    })
})
