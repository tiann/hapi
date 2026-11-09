/**
 * Whether this process may hand its macOS responsibility to the detached
 * processes it spawns (see disclaimExec.ts).
 *
 * That is the case when this process is its own responsible process, as a
 * runner started directly by launchd is, or when its responsible process is the
 * npm launcher (`bin/hapi.cjs`) that launchd started and that started this
 * process. In both cases the inherited responsible pid goes away when the runner
 * or its launcher exits. A process started from Terminal or over SSH has
 * Terminal or sshd-session as its responsible process, and macOS grants their
 * descendants LAN access implicitly; those keep the inherited responsibility.
 *
 * Observed on macOS 27: once a process's responsible process has exited,
 * `responsibility_get_pid_responsible_for_pid` reports the process itself. Such a
 * spawner then counts as its own responsible process. Its tree has already lost
 * LAN access for new processes, so disclaiming its children is no worse.
 */
import { logger } from '@/ui/logger'
import { getLauncherPid } from './launcherPid'

type ResponsibleFor = (pid: number) => number

let lookup: ResponsibleFor | null | undefined

export interface ResponsibilityFacts {
    pid: number
    ppid: number
    launcherPid: number | null
    responsibleFor: ResponsibleFor
}

export function ownsResponsibility(facts: ResponsibilityFacts): boolean {
    const responsible = facts.responsibleFor(facts.pid)
    if (responsible === facts.pid) {
        return true
    }
    return facts.launcherPid !== null
        && responsible === facts.launcherPid
        && responsible === facts.ppid
        && facts.responsibleFor(responsible) === responsible
}

function warnOnce(reason: string): void {
    logger.debug(`[WARN] [DISCLAIM] macOS responsibility lookup unavailable (${reason}); detached children keep the inherited responsible process`)
}

function loadLookup(): ResponsibleFor | null {
    if (process.platform !== 'darwin') {
        return null
    }
    if (!process.versions.bun) {
        warnOnce('not running under Bun')
        return null
    }
    try {
        // Loaded lazily: this module is also imported under Node (tests), where
        // bun:ffi does not exist.
        const { dlopen, FFIType } = require('bun:ffi') as typeof import('bun:ffi')
        const { symbols } = dlopen('/usr/lib/libSystem.B.dylib', {
            responsibility_get_pid_responsible_for_pid: { args: [FFIType.i32], returns: FFIType.i32 }
        })
        return (pid) => symbols.responsibility_get_pid_responsible_for_pid(pid)
    } catch (error) {
        warnOnce(error instanceof Error ? error.message : String(error))
        return null
    }
}

/** False whenever the answer is unknown, so callers fail open to no disclaim. */
export function canDisclaimForChildren(): boolean {
    if (lookup === undefined) {
        lookup = loadLookup()
    }
    if (!lookup) {
        return false
    }
    try {
        return ownsResponsibility({ pid: process.pid, ppid: process.ppid, launcherPid: getLauncherPid(), responsibleFor: lookup })
    } catch (error) {
        warnOnce(error instanceof Error ? error.message : String(error))
        lookup = null
        return false
    }
}
