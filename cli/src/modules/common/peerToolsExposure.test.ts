import { afterEach, describe, expect, it } from 'vitest'
import {
    applyHubPeerToolsEnabled,
    isHubPeerToolsEnabled,
    resetHubPeerToolsEnabledForTests
} from './peerToolsExposure'
import { getSystemPrompt } from '@/claude/utils/systemPrompt'
import { getCodexSystemPrompt } from '@/codex/utils/systemPrompt'
import { getTitleInstruction, getOpencodeNativeToolInstruction } from '@/opencode/utils/systemPrompt'

describe('peerToolsExposure', () => {
    afterEach(() => resetHubPeerToolsEnabledForTests())

    it('defaults peer tools exposure on for old bootstrap responses', () => {
        expect(isHubPeerToolsEnabled()).toBe(true)
    })

    it('keeps OpenCode peer citation guidance enabled by default', () => {
        expect(getTitleInstruction({})).toContain('hapi_inspect_peer')
        expect(getOpencodeNativeToolInstruction({})).toContain('hapi_inspect_peer')
    })

    it('tracks the hub-resolved exposure toggle', () => {
        applyHubPeerToolsEnabled(false)
        expect(isHubPeerToolsEnabled()).toBe(false)
        applyHubPeerToolsEnabled(true)
        expect(isHubPeerToolsEnabled()).toBe(true)
    })

    it('removes peer citation guidance when exposure is off', () => {
        applyHubPeerToolsEnabled(false)
        expect(getSystemPrompt()).not.toContain('inspect_peer')
        expect(getCodexSystemPrompt({})).not.toContain('inspect_peer')
        expect(getTitleInstruction({})).not.toContain('inspect_peer')
        expect(getOpencodeNativeToolInstruction({})).not.toContain('inspect_peer')
    })
})
