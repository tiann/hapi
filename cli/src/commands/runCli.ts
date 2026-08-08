import packageJson from '../../package.json'
import { isBunCompiled } from '@/projectPath'
import { logger } from '@/ui/logger'
import { getCliArgs } from '@/utils/cliArgs'
import { ensureLoopbackProxyBypass } from '@/utils/proxyEnv'
import { resolveCommand } from './registry'
import {
    clearUpgradeTarget,
    isAuthorizedRunnerHandoff,
    isRunnerStartCliArgs,
    isUpgradeTargetStaleRelativeToCli,
    readUpgradeTarget,
    shouldDelegateToUpgradeTarget,
} from '@/upgrade/upgradeTarget'
import { waitForRunnerHandoff } from '@/runner/controlClient'
import { readRunnerState } from '@/persistence'
import { isProcessAlive, killProcessByChildProcess } from '@/utils/process'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import crossSpawn from 'cross-spawn'

/** Wait for delegated child exit; reject on spawn error so caller can clear the marker. */
export function waitForDelegatedRunner(child: ChildProcess): Promise<number> {
    // Already-settled children (detached launcher exit already awaited) must not
    // hang on a fresh 'exit' listener that will never fire again.
    if (child.signalCode != null) {
        return Promise.resolve(1)
    }
    if (child.exitCode != null) {
        return Promise.resolve(child.exitCode)
    }
    return new Promise<number>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (status, signal) => {
            if (signal) {
                resolve(1)
                return
            }
            resolve(status ?? 1)
        })
    })
}

/**
 * After spawning a durable upgrade target, require a live runner with hubReadyAt
 * before treating the marker as successful. Spawn-only success still restart-loops
 * under Restart=always when the target dies before publishing runner state.
 *
 * Uses waitForRunnerHandoff(wrapperPid): Windows .cmd shims make child.pid the
 * cmd.exe wrapper, while the real runner PID is a grandchild.
 *
 * Detached `runner start` launches start-sync then exits; racing that launcher
 * exit against hubReadyAt falsely clears the durable marker. For that path,
 * wait for a clean launcher exit, then for the grandchild hubReadyAt — and do
 * not force-kill the process group (grandchild may still be connecting).
 */
export async function settleDurableDelegate(options: {
    child: ChildProcess
    wrapperPid: number
    useProcessGroup: boolean
    /** True when argv is `runner start` (detached launcher, not start-sync). */
    detachedLauncher?: boolean
    timeoutMs?: number
    waitForExit?: (child: ChildProcess) => Promise<number>
    waitForReady?: (
        oldPid: number,
        opts?: { timeoutMs?: number },
    ) => Promise<boolean>
    killChild?: (child: ChildProcess, force?: boolean) => Promise<boolean>
    readState?: () => Promise<{ pid?: number } | null>
    isAlive?: (pid: number) => boolean
}): Promise<
    | { ready: true; exitCode: number }
    | { ready: false; safeToFallback: boolean }
> {
    const waitForExit = options.waitForExit ?? waitForDelegatedRunner
    const waitForReady = options.waitForReady ?? waitForRunnerHandoff
    const killChild = options.killChild ?? killProcessByChildProcess
    const readState = options.readState ?? readRunnerState
    const isAlive = options.isAlive ?? isProcessAlive
    const timeoutMs = options.timeoutMs ?? 30_000

    if (options.detachedLauncher) {
        const exitCode = await waitForExit(options.child)
        if (exitCode !== 0) {
            return { ready: false, safeToFallback: true }
        }
        const ready = await waitForReady(options.wrapperPid, { timeoutMs })
        if (ready) {
            return { ready: true, exitCode }
        }
        // Launcher exited; only suppress fallback while a different live PID is
        // still connecting. A dead grandchild must clear the marker and fall through.
        const state = await readState()
        const replacementAlive = Boolean(
            state
            && typeof state.pid === 'number'
            && state.pid !== options.wrapperPid
            && isAlive(state.pid),
        )
        return { ready: false, safeToFallback: !replacementAlive }
    }

    const exitPromise = waitForExit(options.child)
    const outcome = await Promise.race([
        waitForReady(options.wrapperPid, { timeoutMs }).then(
            (ready) => (ready ? 'ready' as const : 'timeout' as const),
        ),
        exitPromise.then(() => 'exited' as const),
    ])
    if (outcome === 'ready') {
        return { ready: true, exitCode: await exitPromise }
    }
    if (outcome === 'exited') {
        return { ready: false, safeToFallback: true }
    }
    // Timeout: force-kill tree. Only fall back to current CLI when the
    // candidate is confirmed gone — otherwise it can still take the lock later.
    const stopped = await killChild(options.child, true).catch(() => false)
    await Promise.race([
        exitPromise.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ])
    return { ready: false, safeToFallback: stopped }
}

/**
 * Spawn the durable upgrade-target binary for runner restart.
 * Windows npm shims (.cmd/.bat) use cross-spawn — never shell:true — so
 * preserved argv (e.g. --workspace-root with cmd metacharacters) stays one arg.
 */
export function spawnDurableUpgradeDelegate(
    upgradePath: string,
    args: readonly string[],
    options: {
        platform?: NodeJS.Platform
        env?: NodeJS.ProcessEnv
        spawnImpl?: typeof spawn
        crossSpawnImpl?: typeof crossSpawn
    } = {},
): ChildProcess {
    const platform = options.platform ?? process.platform
    const env = options.env ?? process.env
    const spawnImpl = options.spawnImpl ?? spawn
    const crossSpawnImpl = options.crossSpawnImpl ?? crossSpawn
    const useProcessGroup = platform !== 'win32'
    const isWindowsShim = platform === 'win32' && /\.(cmd|bat)$/i.test(upgradePath)
    const spawnOptions: SpawnOptions = {
        stdio: 'inherit',
        env: {
            ...env,
            HAPI_CLI_EXECUTABLE: upgradePath,
        },
        detached: useProcessGroup,
    }
    return (isWindowsShim ? crossSpawnImpl : spawnImpl)(
        upgradePath,
        [...args],
        spawnOptions,
    ) as ChildProcess
}

export async function runCli(): Promise<void> {
    ensureLoopbackProxyBypass()

    const args = getCliArgs()

    // Hub-artifact binaries are runner-only (empty embedded web). Only redirect
    // systemd `runner start` / `start-sync` so `hapi hub` / doctor stay on the
    // general-purpose entrypoint.
    // Spawn (not spawnSync) and forward SIGTERM/SIGINT so KillMode=process still
    // stops the upgraded runner when systemd signals the wrapper PID.
    // During an authorized handoff the child is already the candidate binary —
    // do not bounce it back to a previous durable marker target.
    const upgradeTarget = !isAuthorizedRunnerHandoff() && isRunnerStartCliArgs(args)
        ? readUpgradeTarget()
        : null
    // A later npm/binary install can leave an older hub-artifact marker behind.
    // Clear it so Restart=always does not keep launching the stale generation.
    // Also clear when the target path is gone: shouldDelegate returns false for
    // missing paths, and falling through without clearing would leave
    // targetGeneration advertised from a deleted binary (false-current skew).
    const targetMissing = Boolean(upgradeTarget && (!upgradeTarget.path || !existsSync(upgradeTarget.path)))
    if (targetMissing && upgradeTarget) {
        clearUpgradeTarget()
        logger.debug('[UPGRADE] Cleared durable target whose path is missing', {
            markerVersion: upgradeTarget.targetVersion,
            markerPath: upgradeTarget.path,
        })
    } else if (upgradeTarget && isUpgradeTargetStaleRelativeToCli(upgradeTarget)) {
        clearUpgradeTarget()
        logger.debug('[UPGRADE] Cleared durable target older than current CLI', {
            markerVersion: upgradeTarget.targetVersion,
            currentVersion: packageJson.version,
        })
    } else if (upgradeTarget && shouldDelegateToUpgradeTarget(upgradeTarget)) {
        // Unix: new process group so SIGTERM under KillMode=process reaches the
        // npm shim AND its execFileSync grandchild runner, not just the shim PID.
        const useProcessGroup = process.platform !== 'win32'
        const child = spawnDurableUpgradeDelegate(upgradeTarget.path, args)
        const forward = (signal: NodeJS.Signals): void => {
            try {
                if (useProcessGroup && child.pid) {
                    process.kill(-child.pid, signal)
                } else {
                    child.kill(signal)
                }
            } catch {
                // child may already be gone
            }
        }
        process.on('SIGTERM', forward)
        process.on('SIGINT', forward)
        try {
            const settled = await settleDurableDelegate({
                child,
                wrapperPid: process.pid,
                useProcessGroup,
                // `runner start` exits after spawning start-sync; do not treat
                // that launcher exit as target failure (grandchild still connecting).
                detachedLauncher: args[0] === 'runner' && args[1] === 'start',
            })
            if (!settled.ready) {
                if (!settled.safeToFallback) {
                    // Candidate may still hold or acquire the runner lock —
                    // wait it out; do not clear the marker and start a second runner.
                    logger.debug('[UPGRADE] Durable target still alive after failed handoff; waiting')
                    await waitForDelegatedRunner(child).catch(() => undefined)
                    return
                }
                clearUpgradeTarget()
                logger.debug('[UPGRADE] Durable target never became ready; using current CLI')
                // Fall through to the current CLI's normal command dispatch.
            } else {
                process.exit(settled.exitCode)
            }
        } catch (error) {
            clearUpgradeTarget()
            logger.debug('[UPGRADE] Durable target failed to spawn; using current CLI', error)
            // Fall through to the current CLI's normal command dispatch.
        } finally {
            process.off('SIGTERM', forward)
            process.off('SIGINT', forward)
        }
    }

    if (args.includes('-v') || args.includes('--version')) {
        console.log(`hapi version: ${packageJson.version}`)
        process.exit(0)
    }

    if (isBunCompiled()) {
        process.env.DEV = 'false'
    }

    const { command, context } = resolveCommand(args)

    if (command.requiresRuntimeAssets) {
        const { ensureRuntimeAssets } = await import('@/runtime/assets')
        await ensureRuntimeAssets()
        logger.debug('Starting hapi CLI with args: ', process.argv)
    }

    await command.run(context)
}
