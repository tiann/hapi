import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
    mockExistsSync,
    mockWriteFileSync,
    mockReadFileSync,
    mockUnlinkSync,
    mockReadFile,
    mockWriteFile,
    mockMkdir,
    mockOpen,
    mockUnlink,
    mockRename,
    mockStat,
    mockChmod,
    mockIsProcessAlive,
    mockLockClose,
    configurationMock,
} = vi.hoisted(() => ({
    mockExistsSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockUnlinkSync: vi.fn(),
    mockReadFile: vi.fn(),
    mockWriteFile: vi.fn(),
    mockMkdir: vi.fn(),
    mockOpen: vi.fn(),
    mockUnlink: vi.fn(),
    mockRename: vi.fn(),
    mockStat: vi.fn(),
    mockChmod: vi.fn(),
    mockIsProcessAlive: vi.fn(),
    mockLockClose: vi.fn(),
    configurationMock: {
        happyHomeDir: '/tmp/hapi-test-home',
        settingsFile: '/tmp/hapi-test-home/settings.json',
        privateKeyFile: '/tmp/hapi-test-home/access.key',
        runnerStateFile: '/tmp/hapi-test-home/runner.state.json',
        runnerLockFile: '/tmp/hapi-test-home/runner.state.json.lock',
    },
}))

vi.mock('node:fs/promises', () => ({
    FileHandle: class {},
    chmod: mockChmod,
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
    open: mockOpen,
    unlink: mockUnlink,
    rename: mockRename,
    stat: mockStat,
}))

vi.mock('node:fs', () => ({
    existsSync: mockExistsSync,
    writeFileSync: mockWriteFileSync,
    readFileSync: mockReadFileSync,
    unlinkSync: mockUnlinkSync,
}))

vi.mock('@/configuration', () => ({
    configuration: configurationMock,
}))

vi.mock('@/utils/process', () => ({
    isProcessAlive: mockIsProcessAlive,
}))

import { updateSettings, writeCredentialsDataKey, writeSettings } from './persistence'

describe('persistence permission hardening', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockExistsSync.mockImplementation(() => false)
        mockReadFile.mockResolvedValue('{}')
        mockWriteFile.mockResolvedValue(undefined)
        mockMkdir.mockResolvedValue(undefined)
        mockOpen.mockResolvedValue({ close: mockLockClose })
        mockUnlink.mockResolvedValue(undefined)
        mockRename.mockResolvedValue(undefined)
        mockStat.mockResolvedValue({ mtimeMs: Date.now() })
        mockChmod.mockResolvedValue(undefined)
        mockLockClose.mockResolvedValue(undefined)
    })

    it('writeSettings writes settings file with mode 0600 and directory mode 0700', async () => {
        await writeSettings({ cliApiToken: 'top-secret-token' })

        expect(mockMkdir).toHaveBeenCalledWith(configurationMock.happyHomeDir, { recursive: true, mode: 0o700 })
        expect(mockWriteFile).toHaveBeenCalledWith(
            configurationMock.settingsFile,
            expect.any(String),
            { mode: 0o600 }
        )
        expect(mockChmod).toHaveBeenCalledWith(configurationMock.settingsFile, 0o600)
    })

    it('updateSettings writes temp file with mode 0600 and chmods final settings file', async () => {
        const updated = await updateSettings((current) => ({
            ...current,
            machineId: 'machine-123',
        }))

        expect(updated.machineId).toBe('machine-123')
        expect(mockMkdir).toHaveBeenCalledWith(configurationMock.happyHomeDir, { recursive: true, mode: 0o700 })
        expect(mockWriteFile).toHaveBeenCalledWith(
            `${configurationMock.settingsFile}.tmp`,
            expect.any(String),
            { mode: 0o600 }
        )
        expect(mockRename).toHaveBeenCalledWith(
            `${configurationMock.settingsFile}.tmp`,
            configurationMock.settingsFile
        )
        expect(mockChmod).toHaveBeenCalledWith(configurationMock.settingsFile, 0o600)
    })

    it('writeCredentialsDataKey writes access.key with mode 0600 and chmod fallback', async () => {
        await writeCredentialsDataKey({
            publicKey: new Uint8Array([1, 2, 3]),
            machineKey: new Uint8Array([4, 5, 6]),
            token: 'secret-auth-token',
        })

        expect(mockMkdir).toHaveBeenCalledWith(configurationMock.happyHomeDir, { recursive: true, mode: 0o700 })
        expect(mockWriteFile).toHaveBeenCalledWith(
            configurationMock.privateKeyFile,
            expect.any(String),
            { mode: 0o600 }
        )
        expect(mockChmod).toHaveBeenCalledWith(configurationMock.privateKeyFile, 0o600)
    })
})
