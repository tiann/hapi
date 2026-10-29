import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { RewindIntentStore, withStagedRewindInput, type RewindDelivery, type RewindIntent } from './rewindIntent'

const intent: RewindIntent = {
    operationId: 'operation-a', requestedLocalId: 'local-two', cutoffSeq: 10, phase: 'pending',
    hubSessionId: 'hub-a', nativeSessionId: 'native-a', workingDirectory: '/test',
    keepBoundary: 'assistant-one', dropFromLocalId: 'local-two',
    droppedPrompts: ['prompt-two'], baselineUuids: ['prompt-one', 'assistant-one', 'prompt-two']
}

describe('durable rewind intent', () => {
    it('retains exact staged input and mode across writer death and refuses replacement input', () => {
        const home = mkdtempSync(join(tmpdir(), 'hapi-rewind-staged-'))
        const delivery: RewindDelivery = {
            deliveredText: '/skill expanded exact input',
            items: [{ message: '$skill original input', localId: 'q' }], isolate: true,
            mode: { permissionMode: 'plan', model: 'haiku', effort: 'low', allowedTools: ['Read'] }
        }
        const staged = withStagedRewindInput(intent, delivery)
        const child = spawnSync('bun', ['--eval', `
            import { RewindIntentStore } from ${JSON.stringify(join(import.meta.dirname, 'rewindIntent.ts'))};
            new RewindIntentStore(${JSON.stringify(home)}, 'server-a', 'hub-a').write(${JSON.stringify(staged)});
            process.kill(process.pid, 'SIGKILL');
        `], { encoding: 'utf8' })
        expect(child.signal).toBe('SIGKILL')
        const recovered = new RewindIntentStore(home, 'server-a', 'hub-a').read()!
        expect(recovered.stagedInput?.delivery).toEqual(delivery)
        expect(withStagedRewindInput(recovered, delivery)).toBe(recovered)
        expect(() => withStagedRewindInput(recovered, { ...delivery, deliveredText: 'different R' })).toThrow('cannot be replaced')
        expect(() => withStagedRewindInput(recovered, { ...delivery, mode: { permissionMode: 'default' } })).toThrow('cannot be replaced')
        expect(new RewindIntentStore(home, 'server-a', 'hub-a').read()).toEqual(recovered)
    })

    it('survives writer SIGKILL and binds the same hub/native branch on reopen', () => {
        const home = mkdtempSync(join(tmpdir(), 'hapi-rewind-intent-'))
        const child = spawnSync('bun', ['--eval', `
            import { RewindIntentStore } from ${JSON.stringify(join(import.meta.dirname, 'rewindIntent.ts'))};
            new RewindIntentStore(${JSON.stringify(home)}, 'server-a', 'hub-a').write(${JSON.stringify(intent)});
            process.kill(process.pid, 'SIGKILL');
        `], { encoding: 'utf8' })
        expect(child.signal).toBe('SIGKILL')
        expect(new RewindIntentStore(home, 'server-a', 'hub-a').read()).toEqual(intent)
        expect(new RewindIntentStore(home, 'server-a', 'hub-b').read()).toBeNull()
        expect(new RewindIntentStore(home, 'server-b', 'hub-a').read()).toBeNull()
        const reopened = new RewindIntentStore(home, 'server-a', 'hub-a')
        reopened.write(null)
        expect(new RewindIntentStore(home, 'server-a', 'hub-a').read()).toBeNull()
    })

    it('fails closed on a corrupt durable intent instead of resuming old history', () => {
        const home = mkdtempSync(join(tmpdir(), 'hapi-rewind-intent-'))
        const store = new RewindIntentStore(home, 'server-a', 'hub-a')
        store.write(intent)
        const directory = join(home, 'claude-rewind-intents')
        writeFileSync(join(directory, readdirSync(directory)[0]!), '{invalid')
        expect(() => new RewindIntentStore(home, 'server-a', 'hub-a').read()).toThrow()
    })
})
