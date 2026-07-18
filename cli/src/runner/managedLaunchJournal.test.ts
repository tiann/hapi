import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OwnershipJournal } from './ownershipJournal'
import { ManagedLaunchJournal } from './managedLaunchJournal'

const homes: string[] = []
afterEach(async () => Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))))

describe('ManagedLaunchJournal', () => {
    it('carries a fresh launch profile before the provider reports its native id', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-managed-launch-'))
        homes.push(home)
        const journal = await OwnershipJournal.open({ home, writerId: 'writer' })
        let observedNonce = 'pending'
        const launches = new ManagedLaunchJournal({
            journal,
            runnerInstanceId: 'runner-1', runnerPid: 10, runnerBirthToken: 'r',
            helperPid: 11, helperBirthToken: 'h', bootId: 'boot', runtimeRealpath: '/hapi',
            readIdentity: async (pid) => ({
                pid, uid: 501, birthToken: 'child-birth', pgid: pid,
                executableRealpath: '/hapi', evidenceSource: 'kernel',
                argv: ['hapi', '--hapi-launch-nonce', observedNonce, '--hapi-runner-instance', 'runner-1']
            })
        })

        const launch = await launches.reserve('hermes-moa', {
            resumeProfileFingerprint: 'profile-1'
        })
        observedNonce = launch.launchNonce
        expect(launch).toMatchObject({ resumeProfileFingerprint: 'profile-1' })
        expect(Object.values((await journal.snapshot()).leases)).toHaveLength(0)

        await launches.commitSpawn(launch, 1234)
        await launches.recordNativeIdentity(1234, {
            nativeResumeId: 'native-created', resumeProfileFingerprint: 'profile-1'
        })

        const snapshot = await journal.snapshot()
        expect(snapshot.launches[launch.launchNonce]).toMatchObject({
            nativeResumeId: 'native-created', resumeProfileFingerprint: 'profile-1'
        })
        expect(Object.values(snapshot.leases)).toHaveLength(1)
    })

    it('durably reserves before spawn and binds the observed process identity after spawn', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-managed-launch-'))
        homes.push(home)
        const journal = await OwnershipJournal.open({ home, writerId: 'writer' })
        let observedNonce = 'pending'
        const launches = new ManagedLaunchJournal({
            journal,
            runnerInstanceId: 'runner-1',
            runnerPid: 10,
            runnerBirthToken: 'runner-birth',
            helperPid: 11,
            helperBirthToken: 'helper-birth',
            bootId: 'boot-1',
            runtimeRealpath: '/opt/hapi/bin/hapi',
            readGroupEvidence: async () => ({ members: [], complete: true }),
            readIdentity: async (pid) => ({
                pid, uid: 501, birthToken: 'child-birth', pgid: pid,
                executableRealpath: '/opt/hapi/bin/hapi',
                argv: ['hapi', '--hapi-launch-nonce', observedNonce, '--hapi-runner-instance', 'runner-1']
            })
        })

        const launch = await launches.reserve(
            'codex',
            undefined,
            '11111111-1111-4111-8111-111111111111'
        )
        observedNonce = launch.launchNonce
        expect((await journal.snapshot()).launches[launch.launchNonce]).toMatchObject({
            lifecycle: 'admitted',
            spawnRequestId: '11111111-1111-4111-8111-111111111111'
        })

        await launches.commitSpawn(launch, 1234)
        expect((await journal.snapshot()).launches[launch.launchNonce]).toMatchObject({
            lifecycle: 'spawned', pid: 1234, uid: 501, birthToken: 'child-birth', pgid: 1234
        })

        await launches.recordWebhook(1234, 'hapi-session')
        await launches.writeRecycleIntent(1234)
        expect((await journal.snapshot()).launches[launch.launchNonce].recycleIntent).toMatchObject({
            pid: 1234, birthToken: 'child-birth', reason: 'runner-recycle'
        })
        await expect(launches.recordExit(1234, 0)).resolves.toBe(true)
        expect((await journal.snapshot()).launches[launch.launchNonce]).toMatchObject({
            lifecycle: 'stopped', hapiSessionId: 'hapi-session', exitCode: 0,
            processGroupProvenEmptyAt: expect.any(String)
        })
    })

    it('waits for the same kernel process to finish exec before validating managed arguments', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-managed-launch-'))
        homes.push(home)
        const journal = await OwnershipJournal.open({ home, writerId: 'writer' })
        let reads = 0
        let observedNonce = 'pending'
        const launches = new ManagedLaunchJournal({
            journal,
            runnerInstanceId: 'runner-1', runnerPid: 10, runnerBirthToken: 'r',
            helperPid: 11, helperBirthToken: 'h', bootId: 'boot', runtimeRealpath: '/hapi',
            readIdentity: async (pid) => {
                reads += 1
                return {
                    pid, uid: 501, birthToken: 'child-birth', pgid: pid,
                    executableRealpath: '/hapi', evidenceSource: 'kernel' as const,
                    argv: reads === 1
                        ? ['hapi', 'src/index.ts', 'runner', 'start-sync']
                        : ['hapi', 'src/index.ts', '--hapi-launch-nonce', observedNonce, '--hapi-runner-instance', 'runner-1']
                }
            }
        })
        const launch = await launches.reserve('claude')
        observedNonce = launch.launchNonce

        await expect(launches.commitSpawn(launch, 1234)).resolves.toMatchObject({
            pid: 1234,
            birthToken: 'child-birth',
            evidenceSource: 'kernel'
        })
        expect(reads).toBe(2)
        expect((await journal.snapshot()).launches[launch.launchNonce]).toMatchObject({
            lifecycle: 'spawned', pid: 1234, birthToken: 'child-birth', pgid: 1234
        })
    })

    it('fails closed if the kernel process identity changes while managed arguments settle', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-managed-launch-'))
        homes.push(home)
        const journal = await OwnershipJournal.open({ home, writerId: 'writer' })
        let reads = 0
        let observedNonce = 'pending'
        const launches = new ManagedLaunchJournal({
            journal,
            runnerInstanceId: 'runner-1', runnerPid: 10, runnerBirthToken: 'r',
            helperPid: 11, helperBirthToken: 'h', bootId: 'boot', runtimeRealpath: '/hapi',
            readIdentity: async (pid) => {
                reads += 1
                return {
                    pid, uid: 501, birthToken: reads === 1 ? 'original-birth' : 'reused-birth', pgid: pid,
                    executableRealpath: '/hapi', evidenceSource: 'kernel' as const,
                    argv: reads === 1
                        ? ['hapi', 'src/index.ts', 'runner', 'start-sync']
                        : ['hapi', 'src/index.ts', '--hapi-launch-nonce', observedNonce, '--hapi-runner-instance', 'runner-1']
                }
            }
        })
        const launch = await launches.reserve('claude')
        observedNonce = launch.launchNonce

        await expect(launches.commitSpawn(launch, 1234)).rejects.toThrow(
            'kernel identity changed before ownership arguments settled'
        )
        expect((await journal.snapshot()).launches[launch.launchNonce].lifecycle).toBe('admitted')
        expect(launches.launchNonceForPid(1234)).toBeUndefined()
    })

    it('fails closed when post-spawn identity cannot be read', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-managed-launch-'))
        homes.push(home)
        const journal = await OwnershipJournal.open({ home, writerId: 'writer' })
        const launches = new ManagedLaunchJournal({
            journal,
            runnerInstanceId: 'runner-1', runnerPid: 10, runnerBirthToken: 'r',
            helperPid: 11, helperBirthToken: 'h', bootId: 'boot', runtimeRealpath: '/hapi',
            readIdentity: async () => null
        })
        const launch = await launches.reserve('claude')

        await expect(launches.commitSpawn(launch, 1234)).rejects.toThrow('identity unavailable')
        expect((await journal.snapshot()).launches[launch.launchNonce].lifecycle).toBe('admitted')
    })

    it('durably binds kernel identity before rejecting a mismatched runtime', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-managed-launch-'))
        homes.push(home)
        const journal = await OwnershipJournal.open({ home, writerId: 'writer' })
        const launches = new ManagedLaunchJournal({
            journal,
            runnerInstanceId: 'runner-1', runnerPid: 10, runnerBirthToken: 'r',
            helperPid: 11, helperBirthToken: 'h', bootId: 'boot', runtimeRealpath: '/hapi',
            readIdentity: async (pid) => ({
                pid, uid: 501, birthToken: 'child-birth', pgid: pid,
                executableRealpath: '/unexpected',
                argv: ['unexpected']
            })
        })
        const launch = await launches.reserve('codex')

        await expect(launches.commitSpawn(launch, 1234)).rejects.toThrow('runtime identity mismatch')

        expect((await journal.snapshot()).launches[launch.launchNonce]).toMatchObject({
            lifecycle: 'spawned', pid: 1234, birthToken: 'child-birth', pgid: 1234
        })
        expect(launches.launchNonceForPid(1234)).toBe(launch.launchNonce)
        await expect(launches.writeSpawnRejectionIntent(1234)).rejects.toThrow('rejected spawn identity mismatch')
    })

    it('retains the native lease when process-group evidence is incomplete', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-managed-launch-'))
        homes.push(home)
        const journal = await OwnershipJournal.open({ home, writerId: 'writer' })
        let observedNonce = 'pending'
        const launches = new ManagedLaunchJournal({
            journal,
            runnerInstanceId: 'runner-1', runnerPid: 10, runnerBirthToken: 'r',
            helperPid: 11, helperBirthToken: 'h', bootId: 'boot', runtimeRealpath: '/hapi',
            readIdentity: async (pid) => ({
                pid, uid: 501, birthToken: 'child-birth', pgid: 91234,
                executableRealpath: '/hapi',
                argv: ['hapi', '--hapi-launch-nonce', observedNonce, '--hapi-runner-instance', 'runner-1']
            }),
            readGroupEvidence: async () => ({ members: [], complete: false })
        })
        const launch = await launches.reserve('claude', {
            nativeResumeId: 'native-1', resumeProfileFingerprint: 'profile-1'
        })
        observedNonce = launch.launchNonce
        await launches.commitSpawn(launch, 1234)

        await expect(launches.recordExit(1234, 0)).resolves.toBe(false)

        const snapshot = await journal.snapshot()
        expect(Object.values(snapshot.leases)).toHaveLength(1)
        expect(snapshot.launches[launch.launchNonce]).toMatchObject({ lifecycle: 'stopped' })
        expect(snapshot.launches[launch.launchNonce].processGroupProvenEmptyAt).toBeUndefined()

        await expect(launches.recordWebhookByIdentity({
            pid: 1234,
            launchNonce: launch.launchNonce,
            runnerInstanceId: 'runner-1',
            hapiSessionId: 'late-canonical-session'
        })).resolves.toBe(true)
        expect((await journal.snapshot()).launches[launch.launchNonce]).toMatchObject({
            lifecycle: 'stopped',
            hapiSessionId: 'late-canonical-session'
        })
        await expect(launches.recordWebhookByIdentity({
            pid: 1235,
            launchNonce: launch.launchNonce,
            runnerInstanceId: 'runner-1',
            hapiSessionId: 'wrong-pid-session'
        })).resolves.toBe(false)
        await expect(launches.recordWebhookByIdentity({
            pid: 1234,
            launchNonce: launch.launchNonce,
            runnerInstanceId: 'runner-other',
            hapiSessionId: 'wrong-runner-session'
        })).resolves.toBe(false)
        await expect(launches.recordWebhookByIdentity({
            pid: 1234,
            launchNonce: launch.launchNonce,
            runnerInstanceId: 'runner-1',
            hapiSessionId: 'conflicting-session'
        })).rejects.toThrow(/different HAPI session/)
    })

    it('does not misclassify a committed live spawn as a pre-spawn failure', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-managed-launch-'))
        homes.push(home)
        const journal = await OwnershipJournal.open({ home, writerId: 'writer' })
        let observedNonce = 'pending'
        const launches = new ManagedLaunchJournal({
            journal,
            runnerInstanceId: 'runner-1', runnerPid: 10, runnerBirthToken: 'r',
            helperPid: 11, helperBirthToken: 'h', bootId: 'boot', runtimeRealpath: '/hapi',
            readIdentity: async (pid) => ({
                pid, uid: 501, birthToken: 'child-birth', pgid: pid,
                executableRealpath: '/hapi',
                argv: ['hapi', '--hapi-launch-nonce', observedNonce, '--hapi-runner-instance', 'runner-1']
            })
        })
        const launch = await launches.reserve('codex')
        observedNonce = launch.launchNonce
        await launches.commitSpawn(launch, 1234)

        await launches.recordSpawnFailure(launch, null)

        expect((await journal.snapshot()).launches[launch.launchNonce].lifecycle).toBe('spawned')
    })

    it('rejects a resumed child that reports a different native identity without leaking a second lease', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-managed-launch-'))
        homes.push(home)
        const journal = await OwnershipJournal.open({ home, writerId: 'writer' })
        let observedNonce = 'pending'
        const launches = new ManagedLaunchJournal({
            journal,
            runnerInstanceId: 'runner-1', runnerPid: 10, runnerBirthToken: 'r',
            helperPid: 11, helperBirthToken: 'h', bootId: 'boot', runtimeRealpath: '/hapi',
            readIdentity: async (pid) => ({
                pid, uid: 501, birthToken: 'child-birth', pgid: pid,
                executableRealpath: '/hapi',
                argv: ['hapi', '--hapi-launch-nonce', observedNonce, '--hapi-runner-instance', 'runner-1']
            })
        })
        const launch = await launches.reserve('claude', {
            nativeResumeId: 'native-requested', resumeProfileFingerprint: 'profile-1'
        })
        observedNonce = launch.launchNonce
        await launches.commitSpawn(launch, 1234)

        await expect(launches.recordNativeIdentity(1234, {
            nativeResumeId: 'native-different', resumeProfileFingerprint: 'profile-1'
        })).rejects.toThrow('native identity mismatch')
        expect(Object.values((await journal.snapshot()).leases)).toHaveLength(1)
    })

    it('atomically rebinds the native lease after a verified child rotates its confirmed session id', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-managed-launch-'))
        homes.push(home)
        const journal = await OwnershipJournal.open({ home, writerId: 'writer' })
        let observedNonce = 'pending'
        const launches = new ManagedLaunchJournal({
            journal,
            runnerInstanceId: 'runner-1', runnerPid: 10, runnerBirthToken: 'r',
            helperPid: 11, helperBirthToken: 'h', bootId: 'boot', runtimeRealpath: '/hapi',
            readIdentity: async (pid) => ({
                pid, uid: 501, birthToken: 'child-birth', pgid: pid,
                executableRealpath: '/hapi', evidenceSource: 'kernel',
                argv: ['hapi', '--hapi-launch-nonce', observedNonce, '--hapi-runner-instance', 'runner-1']
            })
        })
        const launch = await launches.reserve('claude', {
            nativeResumeId: 'native-original', resumeProfileFingerprint: 'profile-1'
        })
        observedNonce = launch.launchNonce
        await launches.commitSpawn(launch, 1234)
        await launches.recordNativeIdentity(1234, {
            nativeResumeId: 'native-original', resumeProfileFingerprint: 'profile-1'
        })

        await launches.recordNativeIdentity(1234, {
            nativeResumeId: 'native-after-clear', resumeProfileFingerprint: 'profile-1'
        })

        const snapshot = await journal.snapshot()
        expect(snapshot.launches[launch.launchNonce]).toMatchObject({
            nativeResumeId: 'native-after-clear', resumeProfileFingerprint: 'profile-1'
        })
        expect(Object.values(snapshot.leases)).toHaveLength(1)
        expect(Object.values(snapshot.leases)[0]).toMatchObject({ launchNonce: launch.launchNonce, pid: 1234 })
    })

    it('terminalizes and releases a resume lease after startup proves the launch absent', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-managed-launch-'))
        homes.push(home)
        const journal = await OwnershipJournal.open({ home, writerId: 'writer' })
        const launches = new ManagedLaunchJournal({
            journal,
            runnerInstanceId: 'runner-1', runnerPid: 10, runnerBirthToken: 'r',
            helperPid: 11, helperBirthToken: 'h', bootId: 'boot', runtimeRealpath: '/hapi',
            readIdentity: async () => null
        })
        const launch = await launches.reserve('codex', {
            nativeResumeId: 'native-1', resumeProfileFingerprint: 'profile-1'
        })

        await launches.terminalizeVerifiedAbsent(launch.launchNonce)

        const snapshot = await journal.snapshot()
        expect(snapshot.launches[launch.launchNonce].lifecycle).toBe('stopped')
        expect(Object.values(snapshot.leases)).toHaveLength(0)
    })

    it('adopts an exact predecessor launch after verified ownership transfer', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-managed-launch-'))
        homes.push(home)
        const journal = await OwnershipJournal.open({ home, writerId: 'writer' })
        const launches = new ManagedLaunchJournal({
            journal,
            runnerInstanceId: 'runner-new', runnerPid: 10, runnerBirthToken: 'r',
            helperPid: 11, helperBirthToken: 'h', bootId: 'boot', runtimeRealpath: '/hapi'
        })
        await expect(launches.adopt({
            launchNonce: 'old-launch', runnerInstanceId: 'runner-old', runnerPid: 20, runnerBirthToken: 'old-r',
            helperPid: 21, helperBirthToken: 'old-h', bootId: 'boot', provider: 'codex', runtimeRealpath: '/hapi',
            argvNonce: 'old-launch', launchPublicKey: 'key', createdAt: new Date().toISOString(), lifecycle: 'spawned',
            pid: 123, uid: 501, birthToken: 'birth', pgid: 123
        }, {
            pid: 123, uid: 501, birthToken: 'birth', pgid: 123, executableRealpath: '/hapi', evidenceSource: 'kernel',
            argv: ['hapi', '--hapi-launch-nonce', 'old-launch', '--hapi-runner-instance', 'runner-old']
        })).resolves.toBeUndefined()
        expect(launches.launchNonceForPid(123)).toBe('old-launch')
    })
})
