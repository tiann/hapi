import { describe, expect, it } from 'vitest'
import { resolveToolAutoApprovalDecision } from './BasePermissionHandler'

describe('resolveToolAutoApprovalDecision skill_lookup', () => {
    it.each([
        'skill_lookup',
        'hapi_skill_lookup',
        'happy__skill_lookup',
        'mcp__hapi__skill_lookup'
    ])('auto-approves the exact read-only HAPI tool name %s', (toolName) => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            toolName,
            'call-1'
        )).toBe('approved')
    })

    it('does not approve another tool solely from a skill-looking call id', () => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            'dangerous_tool',
            'skill_lookup-forged-id'
        )).toBeNull()
    })

    it('does not approve another tool whose name only contains skill_lookup', () => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            'skill_lookup_write_file',
            'call-1'
        )).toBeNull()
        expect(resolveToolAutoApprovalDecision(
            'default',
            'dangerous_skill_lookup',
            'call-2'
        )).toBeNull()
    })
})

describe('resolveToolAutoApprovalDecision display media', () => {
    it.each([
        'display_image',
        'display_video',
        'hapi_display_image',
        'hapi_display_video',
        'mcp__hapi__display_image',
        'mcp__hapi__display_video',
    ])('does not auto-approve display media tool %s in default mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            toolName,
            'call-1'
        )).toBeNull()
    })

    it('does not approve substring lookalikes or forged call ids', () => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            'dangerous_display_image_upload',
            'call-1'
        )).toBeNull()
        expect(resolveToolAutoApprovalDecision(
            'default',
            'dangerous_tool',
            'display_video-forged-id'
        )).toBeNull()
    })
})
