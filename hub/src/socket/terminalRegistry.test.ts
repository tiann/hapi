import { describe, it, expect } from 'bun:test'
import { TerminalRegistry } from './terminalRegistry'

describe('TerminalRegistry onRemove', () => {
    it('fires onRemove when a terminal is removed', () => {
        const removed: string[] = []
        const reg = new TerminalRegistry({ idleTimeoutMs: 0, onRemove: (e) => removed.push(e.terminalId) })
        reg.register('t1', 's1', 'sock1', 'cli1')
        reg.remove('t1')
        expect(removed).toEqual(['t1'])
    })

    it('does NOT fire onRemove on a same-id reconnect re-register', () => {
        const removed: string[] = []
        const reg = new TerminalRegistry({ idleTimeoutMs: 0, onRemove: (e) => removed.push(e.terminalId) })
        reg.register('t1', 's1', 'sockA', 'cli1')
        // Reconnect: same terminalId + session, different web socket → the stale
        // entry is re-registered silently so the client keeps its scrollback.
        reg.register('t1', 's1', 'sockB', 'cli1')
        expect(removed).toEqual([])
    })

    it('fires onRemove for every terminal dropped on web disconnect', () => {
        const removed: string[] = []
        const reg = new TerminalRegistry({ idleTimeoutMs: 0, onRemove: (e) => removed.push(e.terminalId) })
        reg.register('t1', 's1', 'sock1', 'cli1')
        reg.register('t2', 's1', 'sock1', 'cli1')
        reg.removeBySocket('sock1')
        expect(removed.sort()).toEqual(['t1', 't2'])
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
