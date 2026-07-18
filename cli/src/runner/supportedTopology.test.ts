import { describe, expect, it } from 'vitest'
import {
    createRunnerLaunchAgentLabel,
    isManagedSpawnAdmissionReady,
    isRunnerReconciliationEnforcementEnabled,
    parseRunnerLaunchctlPrint,
    verifyConfiguredRunnerLaunchAgentInstallation,
    verifyRunnerLaunchAgentIdentity,
    type RunnerEnforcementContext,
    type RunnerLaunchAgentEvidence,
} from './supportedTopology'

const hapiHome = '/Users/test/.hapi'
const homeDirectory = '/Users/test'
const programArguments = [
    '/opt/homebrew/bin/bun',
    '/Users/test/hapi/cli/src/index.ts',
    'runner',
    'start-sync',
]

describe('isManagedSpawnAdmissionReady', () => {
    it('fails closed without a healthy durable ownership journal on every platform', () => {
        expect(isManagedSpawnAdmissionReady({ journalHealth: undefined, hubAvailable: true })).toBe(false)
        expect(isManagedSpawnAdmissionReady({ journalHealth: 'degraded', hubAvailable: true })).toBe(false)
        expect(isManagedSpawnAdmissionReady({ journalHealth: 'healthy', hubAvailable: false })).toBe(false)
        expect(isManagedSpawnAdmissionReady({ journalHealth: 'healthy', hubAvailable: true })).toBe(true)
    })
})

function createContext(overrides: Partial<RunnerEnforcementContext> = {}): RunnerEnforcementContext {
    return {
        platform: 'darwin',
        supervised: 'launchd',
        parentPid: 1,
        currentPid: 321,
        currentUid: 501,
        hapiHome,
        homeDirectory,
        execPath: programArguments[0]!,
        argv: programArguments,
        workingDirectory: '/Users/test/hapi/cli',
        ...overrides,
    }
}

function createEvidence(overrides: Partial<RunnerLaunchAgentEvidence> = {}): RunnerLaunchAgentEvidence {
    const label = createRunnerLaunchAgentLabel(hapiHome)
    return {
        label,
        domain: 'gui/501',
        pid: 321,
        plistPath: `${homeDirectory}/Library/LaunchAgents/${label}.plist`,
        loadedProgramArguments: programArguments,
        installedLabel: label,
        installedProgramArguments: programArguments,
        installedEnvironmentVariables: {
            HAPI_HOME: hapiHome,
            HAPI_RUNNER_SUPERVISED: 'launchd',
        },
        installedWorkingDirectory: '/Users/test/hapi/cli',
        plistOwnerUid: 501,
        plistMode: 0o600,
        plistIsRegularFile: true,
        plistIsSymbolicLink: false,
        ...overrides,
    }
}

describe('verifyRunnerLaunchAgentIdentity', () => {
    it('accepts the exact direct per-home LaunchAgent job', async () => {
        const result = await verifyRunnerLaunchAgentIdentity(
            createContext(),
            async () => createEvidence(),
        )

        expect(result).toMatchObject({
            eligible: true,
            reason: 'verified',
            label: createRunnerLaunchAgentLabel(hapiHome),
        })
    })

    it.each([
        ['/bin/zsh', '-c', 'exec env HAPI_RUNNER_SUPERVISED=launchd bun src/index.ts runner start-sync'],
        ['/usr/bin/osascript', '-e', 'tell application "Terminal" to do script "hapi runner start-sync"'],
        ['/bin/zsh', '/Users/test/.hapi/bin/hapi-runner-monitor.sh'],
    ])('rejects a wrapper job even when the child spoofs launchd env and PPID 1: %j', async (...wrapperArgs) => {
        const result = await verifyRunnerLaunchAgentIdentity(
            createContext(),
            async () => createEvidence({
                loadedProgramArguments: wrapperArgs,
                installedProgramArguments: wrapperArgs,
            }),
        )

        expect(result).toMatchObject({
            eligible: false,
            reason: 'program-arguments-mismatch',
        })
    })

    it('rejects an environment spoof when no matching GUI-domain job exists', async () => {
        const result = await verifyRunnerLaunchAgentIdentity(createContext(), async () => null)

        expect(result).toMatchObject({
            eligible: false,
            reason: 'evidence-unavailable',
        })
    })

    it.each([
        ['wrong current PID', { pid: 999 }, 'job-pid-mismatch'],
        ['different plist path', { plistPath: '/tmp/forged.plist' }, 'plist-path-mismatch'],
        ['world-readable plist', { plistMode: 0o644 }, 'plist-security-mismatch'],
        ['different HAPI_HOME', {
            installedEnvironmentVariables: {
                HAPI_HOME: '/Users/test/.hapi-other',
                HAPI_RUNNER_SUPERVISED: 'launchd',
            },
        }, 'environment-mismatch'],
    ] as const)('rejects %s', async (_label, evidenceOverrides, reason) => {
        const result = await verifyRunnerLaunchAgentIdentity(
            createContext(),
            async () => createEvidence(evidenceOverrides),
        )

        expect(result).toMatchObject({ eligible: false, reason })
    })

    it.each([
        { platform: 'linux' },
        { supervised: 'foreground' },
        { supervised: undefined },
        { parentPid: 42 },
    ])('rejects an unsupported runtime context %# before probing launchd', async (override) => {
        let probed = false
        const result = await verifyRunnerLaunchAgentIdentity(createContext(override), async () => {
            probed = true
            return createEvidence()
        })

        expect(result.eligible).toBe(false)
        expect(probed).toBe(false)
    })
})

describe('parseRunnerLaunchctlPrint', () => {
    it('extracts the loaded plist, PID, and exact direct argv from launchctl output', () => {
        const label = createRunnerLaunchAgentLabel(hapiHome)
        const plistPath = `${homeDirectory}/Library/LaunchAgents/${label}.plist`

        expect(parseRunnerLaunchctlPrint(`gui/501/${label} = {\n\tpath = ${plistPath}\n\targuments = {\n\t\t/opt/homebrew/bin/bun\n\t\t/Users/test/HAPI Source/cli/src/index.ts\n\t\trunner\n\t\tstart-sync\n\t}\n\tpid = 321\n}`)).toEqual({
            pid: 321,
            plistPath,
            programArguments: [
                '/opt/homebrew/bin/bun',
                '/Users/test/HAPI Source/cli/src/index.ts',
                'runner',
                'start-sync',
            ],
        })
    })
})

describe('verifyConfiguredRunnerLaunchAgentInstallation', () => {
    it('gives doctor the same direct-job verdict without trusting process-name inventory', async () => {
        const result = await verifyConfiguredRunnerLaunchAgentInstallation({
            platform: 'darwin',
            currentUid: 501,
            hapiHome,
            homeDirectory,
            expectedPid: 321,
        }, async () => createEvidence())

        expect(result).toMatchObject({ eligible: true, reason: 'verified' })
    })

    it('keeps doctor report-only for a loaded shell supervisor', async () => {
        const wrapperArgs = ['/bin/zsh', '-c', 'exec hapi runner start-sync']
        const result = await verifyConfiguredRunnerLaunchAgentInstallation({
            platform: 'darwin',
            currentUid: 501,
            hapiHome,
            homeDirectory,
            expectedPid: 321,
        }, async () => createEvidence({
            loadedProgramArguments: wrapperArgs,
            installedProgramArguments: wrapperArgs,
        }))

        expect(result).toMatchObject({
            eligible: false,
            reason: 'program-arguments-mismatch',
        })
    })
})

describe('isRunnerReconciliationEnforcementEnabled', () => {
    it('keeps reconciliation in report mode unless every safety gate passes', () => {
        const eligible = {
            configuredMode: 'enforce' as const,
            killSwitch: false,
            preflightEligible: true,
            ownershipEligible: true,
            launchContextEligible: true,
        }
        expect(isRunnerReconciliationEnforcementEnabled(eligible)).toBe(true)
        expect(isRunnerReconciliationEnforcementEnabled({
            ...eligible,
            launchContextEligible: false,
        })).toBe(false)
        expect(isRunnerReconciliationEnforcementEnabled({
            ...eligible,
            killSwitch: true,
        })).toBe(false)
        expect(isRunnerReconciliationEnforcementEnabled({
            ...eligible,
            configuredMode: 'off',
        })).toBe(false)
    })
})
