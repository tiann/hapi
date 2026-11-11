// Prints this process's identity for the darwin re-exec tests.
import { dlopen, FFIType } from 'bun:ffi'
import { canDisclaimForChildren } from '../responsibility'
import { DISCLAIM_RESPONSIBILITY_ENV } from '../disclaimExec'

const { symbols } = dlopen('/usr/lib/libSystem.B.dylib', {
    responsibility_get_pid_responsible_for_pid: { args: [FFIType.i32], returns: FFIType.i32 },
    getpgrp: { args: [], returns: FFIType.i32 }
})

export function report(extra: Record<string, unknown> = {}): void {
    console.log(JSON.stringify({
        pid: process.pid,
        responsible: symbols.responsibility_get_pid_responsible_for_pid(process.pid),
        ownResponsible: canDisclaimForChildren(),
        pgid: symbols.getpgrp(),
        cwd: process.cwd(),
        probe: process.env.HAPI_DISCLAIM_TEST_PROBE ?? null,
        request: process.env[DISCLAIM_RESPONSIBILITY_ENV] ?? null,
        args: process.argv.slice(2),
        ...extra
    }))
}
