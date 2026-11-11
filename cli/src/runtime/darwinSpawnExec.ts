/**
 * bun:ffi binding for an in-place `posix_spawn(POSIX_SPAWN_SETEXEC)` on macOS.
 *
 * Kept separate from disclaimExec.ts so `bun:ffi` is only loaded when a disclaim
 * was actually requested (and never under Node/vitest).
 */
import { dlopen, FFIType, ptr, read, type Pointer } from 'bun:ffi'
import type { SpawnExecNative } from './disclaimExec'

const LIBSYSTEM = '/usr/lib/libSystem.B.dylib'
export const DISCLAIM_SYMBOL = 'responsibility_spawnattrs_setdisclaim'

const POSIX_SPAWN_SETSIGDEF = 0x04
const POSIX_SPAWN_SETSIGMASK = 0x08
const POSIX_SPAWN_SETEXEC = 0x40
const SIGKILL = 9
const SIGSTOP = 17

// Buffers whose addresses are handed to native code. Bun's FFI requires them to
// stay reachable while native code may read them; exec only returns on failure.
let pinned: unknown[] = []

function cString(value: string): Buffer {
    return Buffer.from(`${value}\0`, 'utf8')
}

export function loadDarwinSpawnExec(options: { disclaimSymbol?: string } = {}): SpawnExecNative {
    const core = dlopen(LIBSYSTEM, {
        posix_spawnattr_init: { args: [FFIType.ptr], returns: FFIType.i32 },
        posix_spawnattr_destroy: { args: [FFIType.ptr], returns: FFIType.i32 },
        posix_spawnattr_setflags: { args: [FFIType.ptr, FFIType.i16], returns: FFIType.i32 },
        posix_spawnattr_setsigmask: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        posix_spawnattr_setsigdefault: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        posix_spawn: {
            args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
            returns: FFIType.i32
        },
        _NSGetEnviron: { args: [], returns: FFIType.ptr },
        getenv: { args: [FFIType.ptr], returns: FFIType.ptr },
        setenv: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
        unsetenv: { args: [FFIType.ptr], returns: FFIType.i32 }
    }).symbols

    // Private libSystem symbol: resolve it on its own so its absence only disables
    // the disclaim, not the exec.
    const disclaimSymbol = options.disclaimSymbol ?? DISCLAIM_SYMBOL
    let setDisclaim: ((attr: BigUint64Array, disclaim: number) => number) | null = null
    try {
        const optional = dlopen(LIBSYSTEM, {
            [disclaimSymbol]: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 }
        }).symbols as Record<string, (attr: BigUint64Array, disclaim: number) => number>
        setDisclaim = optional[disclaimSymbol] ?? null
    } catch {
        setDisclaim = null
    }

    return {
        canDisclaim: setDisclaim !== null,
        // The libc environment is what the exec passes on; process.env writes do not reach it.
        unsetenv(name: string): boolean {
            const key = cString(name)
            core.unsetenv(key)
            return core.getenv(key) === null
        },
        setenv(name: string, value: string): void {
            core.setenv(cString(name), cString(value), 1)
        },
        exec(path: string, argv: readonly string[], disclaim: boolean): number {
            // posix_spawnattr_t is an opaque pointer on Darwin.
            const attr = new BigUint64Array(1)
            let rc = core.posix_spawnattr_init(attr)
            if (rc !== 0) {
                return rc
            }
            try {
                if (disclaim) {
                    if (!setDisclaim) {
                        return -1
                    }
                    rc = setDisclaim(attr, 1)
                    if (rc !== 0) {
                        return rc
                    }
                }
                // Reset every catchable signal to its default action and clear the
                // mask, so the new image does not inherit the dispositions this Bun
                // runtime installed for itself.
                const emptyMask = new Uint32Array([0])
                const allCatchable = new Uint32Array([0xffffffff & ~((1 << (SIGKILL - 1)) | (1 << (SIGSTOP - 1)))])
                rc = core.posix_spawnattr_setsigmask(attr, emptyMask)
                    || core.posix_spawnattr_setsigdefault(attr, allCatchable)
                    || core.posix_spawnattr_setflags(attr, POSIX_SPAWN_SETEXEC | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK)
                if (rc !== 0) {
                    return rc
                }

                const pathBuffer = cString(path)
                const strings = argv.map(cString)
                const argvArray = new BigUint64Array(strings.length + 1)
                strings.forEach((value, index) => {
                    argvArray[index] = BigInt(ptr(value))
                })
                const environPointer = core._NSGetEnviron()
                if (!environPointer) {
                    return -1
                }
                const environ = read.ptr(environPointer, 0) as Pointer
                pinned = [pathBuffer, strings, argvArray, attr, emptyMask, allCatchable]
                // Returns only on failure; on success this process image is replaced.
                return core.posix_spawn(null, pathBuffer, null, attr, argvArray, environ)
            } finally {
                pinned = []
                core.posix_spawnattr_destroy(attr)
            }
        }
    }
}
