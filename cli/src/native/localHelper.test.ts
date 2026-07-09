import { afterEach, describe, expect, it, vi } from 'vitest'

const { existsSyncMock, accessSyncMock, projectPathMock, runtimePathMock, isBunCompiledMock } = vi.hoisted(() => ({
    existsSyncMock: vi.fn((_path: string) => false),
    accessSyncMock: vi.fn(),
    projectPathMock: vi.fn(() => '/repo/cli'),
    runtimePathMock: vi.fn(() => '/hapi/runtime'),
    isBunCompiledMock: vi.fn(() => false)
}))

vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    return { ...actual, existsSync: existsSyncMock, accessSync: accessSyncMock }
})

vi.mock('@/projectPath', () => ({
    projectPath: projectPathMock,
    runtimePath: runtimePathMock,
    isBunCompiled: isBunCompiledMock
}))

import { nativeHelperPath } from './localHelper'

const originalExecPath = process.execPath
const originalOverride = process.env.HAPI_NATIVE_HELPER

afterEach(() => {
    existsSyncMock.mockReset().mockReturnValue(false)
    accessSyncMock.mockReset()
    isBunCompiledMock.mockReset().mockReturnValue(false)
    projectPathMock.mockReset().mockReturnValue('/repo/cli')
    runtimePathMock.mockReset().mockReturnValue('/hapi/runtime')
    Object.defineProperty(process, 'execPath', { value: originalExecPath })
    if (originalOverride === undefined) {
        delete process.env.HAPI_NATIVE_HELPER
    } else {
        process.env.HAPI_NATIVE_HELPER = originalOverride
    }
})

describe('nativeHelperPath', () => {
    it('can be disabled for fallback smoke tests', () => {
        process.env.HAPI_NATIVE_HELPER = '0'
        expect(nativeHelperPath()).toBeNull()
    })

    it('finds hapi-local next to a compiled hapi binary', () => {
        isBunCompiledMock.mockReturnValue(true)
        Object.defineProperty(process, 'execPath', { value: '/app/bin/hapi' })
        existsSyncMock.mockImplementation((path: string) => path === '/app/bin/hapi-local')

        expect(nativeHelperPath()).toBe('/app/bin/hapi-local')
    })

    it('keeps runtime assets path as compiled fallback', () => {
        isBunCompiledMock.mockReturnValue(true)
        Object.defineProperty(process, 'execPath', { value: '/app/bin/hapi' })
        existsSyncMock.mockImplementation((path: string) => path === '/hapi/runtime/tools/hapi-local/hapi-local')

        expect(nativeHelperPath()).toBe('/hapi/runtime/tools/hapi-local/hapi-local')
    })
})
