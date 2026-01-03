import { killRunawayHappyProcesses } from '@/daemon/doctor'
import { runDoctorCommand } from '@/ui/doctor'
import type { CommandDefinition } from './types'

export const doctorCommand: CommandDefinition = {
    name: 'doctor',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        if (commandArgs[0] === 'clean') {
            const result = await killRunawayHappyProcesses()
            console.log(`Cleaned up ${result.killed} runaway processes`)
            if (result.errors.length > 0) {
                console.log('Errors:', result.errors)
            }
            process.exit(0)
        }
        await runDoctorCommand()
    }
}
