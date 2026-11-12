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

describe('resolveToolAutoApprovalDecision ping_peer', () => {
    it.each([
        'ping_peer',
        'mcp__hapi__ping_peer',
        'hapi_ping_peer',
        'Ping Peer Session'
    ])('does not auto-approve %s in default mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('default', toolName, 'call-1')).toBeNull()
    })

    it.each([
        'ping_peer',
        'mcp__hapi__ping_peer',
        'hapi_ping_peer',
        'Ping Peer Session'
    ])('does not auto-approve %s in read-only mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('read-only', toolName, 'call-1')).toBeNull()
    })

    it('fails read-only closed for unclassifiable requests (title-only identity)', () => {
        // Berry-style request: no kind, no rawInput — the title is a human
        // summary like 'Run command', which the write-hint heuristic cannot
        // classify. Auto-approving it would let a shell write (e.g.
        // `touch file`) run while HAPI advertises read-only.
        expect(resolveToolAutoApprovalDecision('read-only', 'Run command', 'call-1', undefined, { unclassifiable: true })).toBeNull()
        expect(resolveToolAutoApprovalDecision('read-only', 'Check the build', 'APPROVAL-7', undefined, { unclassifiable: true })).toBeNull()
    })

    it('keeps classifiable requests on the title heuristic in read-only mode', () => {
        expect(resolveToolAutoApprovalDecision('read-only', 'Run command', 'call-1', undefined, { unclassifiable: false })).toBe('approved')
        expect(resolveToolAutoApprovalDecision('read-only', 'Write file', 'call-1', undefined, { unclassifiable: false })).toBeNull()
    });

    it('fails closed BEFORE the title auto-approve keywords for unclassifiable requests', () => {
        // Regression: the exact-name / name-hint checks used to run before
        // the unclassifiable guard, so an unclassifiable request whose
        // human title happened to contain an auto-approve keyword was
        // approved. The title is prose, not a tool classification.
        expect(resolveToolAutoApprovalDecision('read-only', 'Think about the migration', 'APPROVAL-9', undefined, { unclassifiable: true })).toBeNull()
        expect(resolveToolAutoApprovalDecision('default', 'Think about the migration', 'APPROVAL-9', undefined, { unclassifiable: true })).toBeNull()
        expect(resolveToolAutoApprovalDecision('read-only', 'list peer sessions', 'APPROVAL-9', undefined, { unclassifiable: true })).toBeNull()
        expect(resolveToolAutoApprovalDecision('default', 'list peer sessions', 'APPROVAL-9', undefined, { unclassifiable: true })).toBeNull()
    })

    it('skips the id-hint auto-approve path for unclassifiable requests', () => {
        expect(resolveToolAutoApprovalDecision('default', 'Run command', 'save_memory-forged', undefined, { unclassifiable: true })).toBeNull()
        expect(resolveToolAutoApprovalDecision('read-only', 'Run command', 'change_title-forged', undefined, { unclassifiable: true })).toBeNull()
    })

    it('keeps mode-policy approvals for unclassifiable requests (yolo / safe-yolo never read the title)', () => {
        expect(resolveToolAutoApprovalDecision('yolo', 'Think about the migration', 'APPROVAL-9', undefined, { unclassifiable: true })).toBe('approved_for_session')
        expect(resolveToolAutoApprovalDecision('safe-yolo', 'Think about the migration', 'APPROVAL-9', undefined, { unclassifiable: true })).toBe('approved')
    })

    it('still auto-approves classifiable keyword-named tools in read-only mode', () => {
        // The guard must not overreach: a request with machine-readable
        // identity keeps its keyword auto-approval.
        expect(resolveToolAutoApprovalDecision('read-only', 'save_memory', 'call-1', undefined, { unclassifiable: false })).toBe('approved')
        expect(resolveToolAutoApprovalDecision('default', 'save_memory', 'call-1', undefined, { unclassifiable: false })).toBe('approved')
    })

    it('still auto-approves unrelated read tools in read-only mode', () => {
        expect(resolveToolAutoApprovalDecision('read-only', 'Read', 'call-1')).toBe('approved')
        expect(resolveToolAutoApprovalDecision('read-only', 'grep', 'call-2')).toBe('approved')
    })
})

describe('resolveToolAutoApprovalDecision spawn_peer', () => {
    it.each([
        'spawn_peer',
        'mcp__hapi__spawn_peer',
        'hapi_spawn_peer',
        'Spawn Peer Session'
    ])('does not auto-approve %s in default mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('default', toolName, 'call-1')).toBeNull()
    })

    it.each([
        'spawn_peer',
        'mcp__hapi__spawn_peer',
        'hapi_spawn_peer',
        'Spawn Peer Session'
    ])('does not auto-approve %s in read-only mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('read-only', toolName, 'call-1')).toBeNull()
    })
})

describe('resolveToolAutoApprovalDecision inspect_peer', () => {
    it.each([
        'inspect_peer',
        'mcp__hapi__inspect_peer',
        'hapi_inspect_peer',
        'Inspect Peer Session'
    ])('does not auto-approve %s in default mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('default', toolName, 'call-1')).toBeNull()
    })

    it.each([
        'inspect_peer',
        'mcp__hapi__inspect_peer',
        'hapi_inspect_peer',
        'Inspect Peer Session'
    ])('does not auto-approve %s in read-only mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('read-only', toolName, 'call-1')).toBeNull()
    })
})

describe('resolveToolAutoApprovalDecision list_peers', () => {
    it.each([
        'list_peers',
        'hapi_list_peers',
        'happy__list_peers',
        'mcp__hapi__list_peers',
        'List Peer Sessions'
    ])('auto-approves the exact discovery tool name %s', (toolName) => {
        expect(resolveToolAutoApprovalDecision('default', toolName, 'call-1')).toBe('approved')
    })

    it('does not approve another tool whose name only contains list_peers', () => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            'list_peers_and_write',
            'call-1'
        )).toBeNull()
    })
})

describe('resolveToolAutoApprovalDecision session_job', () => {
    it.each([
        'session_job',
        'hapi_session_job',
        'mcp__hapi__session_job',
        'Session-Attached Job'
    ])('does not name-only auto-approve spoofable job tool %s', (toolName) => {
        // Bridge / --allowedTools own the approve path; global title allowlist must not.
        expect(resolveToolAutoApprovalDecision('default', toolName, 'call-1')).toBeNull()
    })
})
