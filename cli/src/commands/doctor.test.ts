import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
    killRunawayHappyProcessesMock,
    runDoctorCommandMock,
    runDoctorPerfMock,
    runDoctorStorageMock
} = vi.hoisted(() => ({
    killRunawayHappyProcessesMock: vi.fn(),
    runDoctorCommandMock: vi.fn(),
    runDoctorPerfMock: vi.fn(),
    runDoctorStorageMock: vi.fn()
}))

vi.mock('@/runner/doctor', () => ({
    killRunawayHappyProcesses: killRunawayHappyProcessesMock
}))

vi.mock('@/ui/doctor', () => ({
    runDoctorCommand: runDoctorCommandMock
}))

vi.mock('@/ui/doctorPerf', () => ({
    runDoctorPerf: runDoctorPerfMock
}))

vi.mock('@/ui/doctorStorage', () => ({
    runDoctorStorage: runDoctorStorageMock
}))

import { doctorCommand } from './doctor'

describe('doctorCommand', () => {
    beforeEach(() => {
        killRunawayHappyProcessesMock.mockReset()
        runDoctorCommandMock.mockReset()
        runDoctorPerfMock.mockReset()
        runDoctorStorageMock.mockReset()
    })

    it('routes doctor perf flags to the lightweight perf diagnostic', async () => {
        await doctorCommand.run({
            args: ['doctor', 'perf', '--json', '--limit', '12'],
            subcommand: 'doctor',
            commandArgs: ['perf', '--json', '--limit', '12']
        })

        expect(runDoctorPerfMock).toHaveBeenCalledWith({ json: true, limit: 12 })
        expect(runDoctorCommandMock).not.toHaveBeenCalled()
    })

    it('routes doctor storage flags to the read-only storage diagnostic', async () => {
        await doctorCommand.run({
            args: ['doctor', 'storage', '--json', '--limit', '7'],
            subcommand: 'doctor',
            commandArgs: ['storage', '--json', '--limit', '7']
        })

        expect(runDoctorStorageMock).toHaveBeenCalledWith({ json: true, limit: 7 })
        expect(runDoctorCommandMock).not.toHaveBeenCalled()
    })

    it('threads full-args through the default doctor command only when explicitly requested', async () => {
        await doctorCommand.run({
            args: ['doctor', '--full-args'],
            subcommand: 'doctor',
            commandArgs: ['--full-args']
        })

        expect(runDoctorCommandMock).toHaveBeenCalledWith('all', { fullArgs: true })
    })
})
