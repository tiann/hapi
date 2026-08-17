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

    it('rebinds a same-id reconnect without firing onRemove', () => {
        const removed: string[] = []
        const reg = new TerminalRegistry({ idleTimeoutMs: 0, onRemove: (e) => removed.push(e.terminalId) })
        reg.register('t1', 's1', 'sockA', 'cli1')
        reg.register('t1', 's1', 'sockB', 'cli1')
        expect(removed).toEqual([])
        expect(reg.get('t1')?.socketId).toBe('sockB')
        expect(reg.countForSocket('sockA')).toBe(0)
        expect(reg.countForSocket('sockB')).toBe(1)
    })

    it('detaches terminals on web disconnect without releasing their resources', () => {
        const removed: string[] = []
        const reg = new TerminalRegistry({ idleTimeoutMs: 0, onRemove: (e) => removed.push(e.terminalId) })
        reg.register('t1', 's1', 'sock1', 'cli1')
        reg.register('t2', 's1', 'sock1', 'cli1')
        reg.detachBySocket('sock1')
        expect(removed).toEqual([])
        expect(reg.countForSocket('sock1')).toBe(0)
        expect(reg.get('t1')?.socketId).toBeNull()
        expect(reg.get('t2')?.socketId).toBeNull()
    })

    it('lists detached and attached terminals for a session in creation order', async () => {
        const reg = new TerminalRegistry({ idleTimeoutMs: 0 })
        reg.register('t1', 's1', 'sock1', 'cli1')
        await new Promise((resolve) => setTimeout(resolve, 2))
        reg.register('t2', 's1', 'sock2', 'cli1')
        reg.register('other', 's2', 'sock3', 'cli2')
        reg.detach('t1', 'sock1')

        expect(reg.listForSession('s1').map((entry) => ({ id: entry.terminalId, socketId: entry.socketId }))).toEqual([
            { id: 't1', socketId: null },
            { id: 't2', socketId: 'sock2' }
        ])
    })

    it('attaches a detached terminal without changing its creation metadata', () => {
        const reg = new TerminalRegistry({ idleTimeoutMs: 0 })
        const created = reg.register('t1', 's1', 'sock1', 'cli1')
        reg.detach('t1', 'sock1')
        const attached = reg.attach('t1', 's1', 'sock2')

        expect(attached?.socketId).toBe('sock2')
        expect(attached?.createdAt).toBe(created?.createdAt)
        expect(reg.countForSession('s1')).toBe(1)
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
