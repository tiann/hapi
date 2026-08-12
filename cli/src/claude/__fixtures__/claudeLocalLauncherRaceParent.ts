// Standalone process for claudeLocalLauncher.childExitsFirst.process.test.ts.
//
// Models the exact ordering hazard from the automated review's Major
// finding on tiann/hapi#1527: terminal close delivers SIGHUP to the whole
// foreground process group (this "parent" process and its "claude" child)
// at once, with no guaranteed ordering between the parent's own SIGHUP
// callback and the child's exit callback. A same-process
// `process.emit('SIGHUP')` unit test cannot prove anything about that
// ordering — it needs two real, independently signalled OS processes,
// which is what this fixture plus its harness in the test file provide.
//
// This process spawns a real "claude" child
// (claudeLocalLauncherRaceGrandchild.ts), registers a SIGHUP handler that
// calls the real markTerminalLost() — the same call runnerLifecycle's
// production SIGHUP handler makes — and once the child exits, runs the
// exact classification claudeLocalLauncher.ts uses on a clean child exit:
// isTerminalLost() || await waitForTerminalLoss(100).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { isTerminalLost, waitForTerminalLoss, markTerminalLost } from '../../agent/terminalLossState'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GRANDCHILD_SCRIPT = path.join(__dirname, 'claudeLocalLauncherRaceGrandchild.ts')

process.on('SIGHUP', () => {
    markTerminalLost()
})

const child = spawn('bun', ['run', GRANDCHILD_SCRIPT], {
    stdio: ['ignore', 'pipe', 'ignore']
})

fs.writeSync(1, `GRANDCHILD_PID ${child.pid}\n`)

child.stdout.on('data', (chunk: Buffer) => {
    if (chunk.toString('utf8').includes('READY')) {
        fs.writeSync(1, 'READY\n')
    }
})

child.on('exit', () => {
    void (async () => {
        // Same classification claudeLocalLauncher.ts performs on a clean
        // local-child exit — reads the flag synchronously first, then falls
        // back to the short wait so a not-yet-delivered parent SIGHUP still
        // gets a chance to land before this exit is classified.
        const isSwitch = isTerminalLost() || await waitForTerminalLoss(100)
        fs.writeSync(1, `CLASSIFICATION ${isSwitch ? 'switch' : 'exit'}\n`)
    })()
})
