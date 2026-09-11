// Sibling of runnerLifecycleProcessChild.ts for runnerLifecycle.process.test.ts.
//
// Registers process handlers WITHOUT opting into SIGHUP survival
// (registerProcessHandlers() with no options). Proves the opt-in gate is
// real at the OS-signal level, not just "no listener object was created" —
// a real, separately-spawned process must actually die on SIGHUP here,
// same as it always did before terminal-hangup survival existed.
import fs from 'node:fs'
import { createRunnerLifecycle } from '../runnerLifecycle'

const session = {
    updateMetadata: (fn: (m: Record<string, unknown>) => Record<string, unknown>) => {
        const next = fn({})
        fs.writeSync(1, `EVENT updateMetadata ${JSON.stringify(next)}\n`)
    },
    sendSessionDeath: (reason: string) => {
        fs.writeSync(1, `EVENT sendSessionDeath ${reason}\n`)
    },
    flush: async () => true,
    close: async () => {
        fs.writeSync(1, 'EVENT close\n')
    }
} as unknown as Parameters<typeof createRunnerLifecycle>[0]['session']

const lifecycle = createRunnerLifecycle({ session, logTag: 'child' })
lifecycle.registerProcessHandlers()

fs.writeSync(1, 'READY\n')

setInterval(() => {}, 1000)
