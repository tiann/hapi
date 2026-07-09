import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { isBunCompiled, projectPath, runtimePath } from '@/projectPath'

function findExecutableOnPath(name: string): string | null {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
        if (!dir.trim()) continue
        const candidate = join(isAbsolute(dir) ? dir : resolve(dir), name)
        try {
            accessSync(candidate, constants.X_OK)
            return candidate
        } catch {
            // keep searching
        }
    }
    return null
}

function nativeHelperBinaryName(): string {
    return process.platform === 'win32' ? 'hapi-local.exe' : 'hapi-local'
}

export type NativeHelperStatus = {
    status: 'found' | 'missing' | 'disabled'
    path: string | null
    candidates: string[]
    override?: string
}

export function nativeHelperStatus(): NativeHelperStatus {
    const override = process.env.HAPI_NATIVE_HELPER?.trim()
    if (override === '0') {
        return { status: 'disabled', path: null, candidates: [], override }
    }

    const binary = nativeHelperBinaryName()
    const candidates = [
        ...(override && isAbsolute(override) ? [override] : []),
        ...(isBunCompiled() ? [
            join(dirname(process.execPath), binary),
            join(runtimePath(), 'tools', 'hapi-local', binary)
        ] : []),
        join(projectPath(), '..', 'native', 'hapi-local', 'target', 'release', binary),
        join(projectPath(), '..', 'native', 'hapi-local', 'target', 'debug', binary),
        findExecutableOnPath(binary)
    ].filter((value): value is string => Boolean(value))

    const path = candidates.find(candidate => existsSync(candidate)) ?? null
    return {
        status: path ? 'found' : 'missing',
        path,
        candidates,
        ...(override ? { override } : {})
    }
}

export function nativeHelperPath(): string | null {
    return nativeHelperStatus().path
}
