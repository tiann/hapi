import { randomUUID } from 'node:crypto'
import { configuration } from '@/configuration'
import { updateSettings } from '@/persistence'

export async function authAndSetupMachineIfNeeded(): Promise<{
    token: string
    machineId: string
}> {
    if (!configuration.cliApiToken) {
        throw new Error('CLI_API_TOKEN is required')
    }

    const settings = await updateSettings((current) => {
        if (!current.machineId) {
            return {
                ...current,
                machineId: randomUUID()
            }
        }
        return current
    })

    if (!settings.machineId) {
        throw new Error('Failed to initialize machineId')
    }

    return { token: configuration.cliApiToken, machineId: settings.machineId }
}

