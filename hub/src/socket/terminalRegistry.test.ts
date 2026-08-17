import { describe, it, expect } from 'bun:test'
import { TerminalRegistry } from './terminalRegistry'

describe('TerminalRegistry', () => {
    it('fires onRemove when a terminal is removed', () => {
        const removed: string[] = []
        const reg = new TerminalRegistry({ idleTimeoutMs: 0, onRemove: (e) => removed.push(e.terminalId) })
        reg.register('t1', 's1', 'sock1', 'cli1')
        reg.remove('t1')
        expect(removed).toEqual(['t1'])
    })

    it('keeps same-id reconnects as additional viewers without firing onRemove', () => {
        const removed: string[] = []
        const reg = new TerminalRegistry({ idleTimeoutMs: 0, onRemove: (e) => removed.push(e.terminalId) })
        reg.register('t1', 's1', 'sockA', 'cli1')
        reg.register('t1', 's1', 'sockB', 'cli1')
        expect(removed).toEqual([])
        expect(reg.get('t1')?.viewerSocketIds).toEqual(new Set(['sockA', 'sockB']))
        expect(reg.countForSocket('sockA')).toBe(1)
        expect(reg.countForSocket('sockB')).toBe(1)
    })

    it('deduplicates concurrent auto bootstraps without reusing PTY resource IDs', () => {
        const reg = new TerminalRegistry({ idleTimeoutMs: 0 })

        const first = reg.register('term-s1-auto-nonce-a', 's1', 'sockA', 'cli1')
        const second = reg.register('term-s1-auto-nonce-b', 's1', 'sockB', 'cli1')

        expect(first?.terminalId).toBe('term-s1-auto-nonce-a')
        expect(second).toBeNull()
        expect(reg.listForSession('s1').map((entry) => entry.terminalId)).toEqual(['term-s1-auto-nonce-a'])

        // Auto bootstrap is only the initial create-if-empty gate. Manual New
        // terminals remain multi-terminal and are not blocked by it.
        expect(reg.register('term-s1-manual', 's1', 'sockB', 'cli1')).not.toBeNull()
        expect(reg.countForSession('s1')).toBe(2)

        // A later lifecycle gets a new nonce and is allowed once the session is
        // genuinely empty, so stale callbacks for an old ID cannot target it.
        reg.remove('term-s1-auto-nonce-a')
        reg.remove('term-s1-manual')
        expect(reg.register('term-s1-auto-nonce-c', 's1', 'sockC', 'cli1')?.terminalId)
            .toBe('term-s1-auto-nonce-c')
    })

    it('detaches one web viewer without releasing the terminal resource or other viewers', () => {
        const removed: string[] = []
        const reg = new TerminalRegistry({ idleTimeoutMs: 0, onRemove: (e) => removed.push(e.terminalId) })
        reg.register('t1', 's1', 'sock1', 'cli1')
        reg.attach('t1', 's1', 'sock2')
        reg.detachBySocket('sock1')
        expect(removed).toEqual([])
        expect(reg.countForSocket('sock1')).toBe(0)
        expect(reg.get('t1')?.viewerSocketIds).toEqual(new Set(['sock2']))
    })

    it('lists terminals for a session in creation order and exposes viewer state', async () => {
        const reg = new TerminalRegistry({ idleTimeoutMs: 0 })
        reg.register('t1', 's1', 'sock1', 'cli1')
        await new Promise((resolve) => setTimeout(resolve, 2))
        reg.register('t2', 's1', 'sock2', 'cli1')
        reg.register('other', 's2', 'sock3', 'cli2')
        reg.detach('t1', 'sock1')

        expect(reg.listForSession('s1').map((entry) => ({ id: entry.terminalId, viewers: [...entry.viewerSocketIds] }))).toEqual([
            { id: 't1', viewers: [] },
            { id: 't2', viewers: ['sock2'] }
        ])
    })

    it('attaches another viewer without changing terminal creation metadata', () => {
        const reg = new TerminalRegistry({ idleTimeoutMs: 0 })
        const created = reg.register('t1', 's1', 'sock1', 'cli1')
        const attached = reg.attach('t1', 's1', 'sock2')

        expect(attached?.viewerSocketIds).toEqual(new Set(['sock1', 'sock2']))
        expect(attached?.createdAt).toBe(created?.createdAt)
        expect(reg.countForSession('s1')).toBe(1)
    })

    it('tracks session subscribers independently of terminal attachment', () => {
        const reg = new TerminalRegistry({ idleTimeoutMs: 0 })
        reg.subscribeSession('s1', 'sock1')
        reg.subscribeSession('s1', 'sock2')
        reg.register('t1', 's1', 'sock1', 'cli1')
        reg.detach('t1', 'sock1')

        expect(new Set(reg.subscribersForSession('s1'))).toEqual(new Set(['sock1', 'sock2']))
        reg.detachBySocket('sock1')
        expect(reg.subscribersForSession('s1')).toEqual(['sock2'])
    })

    it('fires onRemove for every terminal dropped on CLI disconnect', () => {
        const removed: string[] = []
        const reg = new TerminalRegistry({ idleTimeoutMs: 0, onRemove: (e) => removed.push(e.terminalId) })
        reg.register('t1', 's1', 'sock1', 'cli1')
        reg.removeByCliSocket('cli1')
        expect(removed).toEqual(['t1'])
    })

    it('fires onRemove when a terminal is reaped for inactivity', async () => {
        const removed: string[] = []
        const reg = new TerminalRegistry({ idleTimeoutMs: 10, onRemove: (e) => removed.push(e.terminalId) })
        reg.register('t1', 's1', 'sock1', 'cli1')
        await new Promise((r) => setTimeout(r, 40))
        expect(removed).toEqual(['t1'])
    })
})
