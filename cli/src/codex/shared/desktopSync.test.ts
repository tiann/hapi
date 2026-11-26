import { describe, expect, it, vi } from 'vitest'
import { superviseDesktopThreads } from './desktopSync'
import { AttachedIneligibleThreadError, type AttachedStopReason } from './attached'
import { AttachedHistoryChangedError } from './attachedHistory'

function fixture() {
    const stop = new AbortController()
    const loaded = new Set<string>()
    const active = new Map<string, (reason: AttachedStopReason) => void>()
    const discover = vi.fn(async () => new Set(loaded))
    const attach = vi.fn(async (id: string, ready: () => void, signal: AbortSignal): Promise<AttachedStopReason> => {
        return new Promise(resolve => {
            const done = (reason: AttachedStopReason) => { active.delete(id); resolve(reason) }
            signal.addEventListener('abort', () => done('detached'), { once: true })
            active.set(id, done)
            ready()
        })
    })
    const checkSettings = vi.fn(async () => {})
    const start = () => superviseDesktopThreads({ signal: stop.signal, discover, attach, checkSettings, pollMs: 2, retryMs: 10 })
    const wait = (check: () => void) => vi.waitFor(check, { interval: 5, timeout: 1_000 })
    return { stop, loaded, active, discover, attach, checkSettings, start, wait }
}

describe('desktop thread synchronization', () => {
    it('bridges existing and later roots without duplicates and cleans them up on removal', async () => {
        const { stop, loaded, active, attach, start, wait } = fixture()
        loaded.add('already-open')
        const running = start()
        try {
            await wait(() => expect(active.has('already-open')).toBe(true))
            loaded.add('opened-later')
            await wait(() => expect([...active.keys()]).toEqual(['already-open', 'opened-later']))
            expect(attach.mock.calls.map(([id]) => id)).toEqual(['already-open', 'opened-later'])
        } finally { stop.abort(); await running }
        expect(active.size).toBe(0)
    })

    it('keeps siblings alive when a root is detached, until that root is unloaded and reopened', async () => {
        const { stop, loaded, active, attach, discover, start, wait } = fixture()
        loaded.add('first').add('second')
        const running = start()
        try {
            await wait(() => expect(active.size).toBe(2))
            active.get('first')?.('detached')
            const scans = discover.mock.calls.length
            await wait(() => expect(discover.mock.calls.length).toBeGreaterThan(scans + 2))
            expect([...active.keys()]).toEqual(['second'])
            expect(attach.mock.calls.filter(([id]) => id === 'first')).toHaveLength(1)
            loaded.delete('first')
            const changed = discover.mock.calls.length
            await wait(() => expect(discover.mock.calls.length).toBeGreaterThan(changed + 1))
            loaded.add('first')
            await wait(() => expect(active.size).toBe(2))
        } finally { stop.abort(); await running }
    })

    it('retries a lost bridge, but does not revive ineligible or history-frozen roots', async () => {
        const { stop, loaded, active, attach, start, wait } = fixture()
        attach.mockRejectedValueOnce(new AttachedIneligibleThreadError()).mockRejectedValueOnce(new AttachedHistoryChangedError())
        loaded.add('child').add('rewritten').add('live')
        const running = start()
        try {
            await wait(() => expect(active.has('live')).toBe(true))
            active.get('live')?.('unavailable')
            await wait(() => expect(attach.mock.calls.map(([id]) => id)).toEqual(['child', 'rewritten', 'live', 'live']))
            expect([...active.keys()]).toEqual(['live'])
        } finally { stop.abort(); await running }
    })

    it('does not treat discovery failure as an empty snapshot, but stops when the saved Hub changes', async () => {
        const { stop, loaded, active, discover, checkSettings, start, wait } = fixture()
        loaded.add('first')
        const running = start()
        void running.catch(() => {})
        try {
            await wait(() => expect(active.has('first')).toBe(true))
            discover.mockRejectedValue(new Error('socket disconnected'))
            const scans = discover.mock.calls.length
            await wait(() => expect(discover.mock.calls.length).toBeGreaterThan(scans + 2))
            expect(active.has('first')).toBe(true)
            checkSettings.mockRejectedValue(new Error('settings changed'))
            await expect(running).rejects.toThrow('settings changed')
            expect(active.size).toBe(0)
        } finally { stop.abort(); await running.catch(() => {}) }
    })
})
