import { killRunawayHappyProcesses } from '@/runner/doctor'
import type { CommandDefinition } from './types'

function parseDoctorReportOptions(commandArgs: string[]): { json: boolean; limit?: number } {
    const reportArgs = commandArgs.slice(1)
    const limitFlagIndex = reportArgs.indexOf('--limit')
    const limitValue = limitFlagIndex >= 0 ? Number.parseInt(reportArgs[limitFlagIndex + 1] ?? '', 10) : undefined

    return {
        json: reportArgs.includes('--json'),
        limit: typeof limitValue === 'number' && Number.isFinite(limitValue) && limitValue > 0 ? limitValue : undefined
    }
}

function parseDoctorOptions(commandArgs: string[]): { fullArgs: boolean } {
    return {
        fullArgs: commandArgs.includes('--full-args') || commandArgs.includes('--verbose')
    }
}

export const doctorCommand: CommandDefinition = {
    name: 'doctor',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        if (commandArgs[0] === 'perf') {
            const { runDoctorPerf } = await import('@/ui/doctorPerf')
            await runDoctorPerf(parseDoctorReportOptions(commandArgs))
            return
        }

        if (commandArgs[0] === 'storage') {
            const { runDoctorStorage } = await import('@/ui/doctorStorage')
            await runDoctorStorage(parseDoctorReportOptions(commandArgs))
            return
        }

        if (commandArgs[0] === 'clean') {
            const result = await killRunawayHappyProcesses()
            console.log(`Cleaned up ${result.killed} runaway processes`)
            if (result.errors.length > 0) {
                console.log('Errors:', result.errors)
            }
            process.exit(0)
        }
        const { runDoctorCommand } = await import('@/ui/doctor')
        await runDoctorCommand('all', parseDoctorOptions(commandArgs))
    }
}
