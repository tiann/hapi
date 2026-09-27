import chalk from 'chalk'
import { initializeToken, TokenInitializationError } from '@/ui/tokenInit'
import { listMachineTargets, SpawnPeerError, exitCodeForSpawnPeerError } from '@/modules/spawnPeer/spawnPeer'
import type { CommandDefinition } from './types'

export const machinesCommand: CommandDefinition = {
    name: 'machines',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        let machineId: string | undefined
        let json = false
        try {
            for (let i = 0; i < commandArgs.length; i++) {
                const arg = commandArgs[i]!
                if (arg === '--help' || arg === '-h') {
                    console.log('Usage: hapi machines [--machine <exact-machine-id>] [--json]')
                    return
                }
                if (arg === '--json') json = true
                else if (arg === '--machine') {
                    const value = commandArgs[++i]
                    if (!value || value.startsWith('-')) throw new SpawnPeerError('bad_args', '--machine requires an exact id')
                    machineId = value
                }
                else if (arg.startsWith('--machine=')) machineId = arg.slice('--machine='.length)
                else throw new SpawnPeerError('bad_args', `unexpected argument: ${arg}`)
            }
            if (machineId !== undefined && !machineId) throw new SpawnPeerError('bad_args', '--machine requires an exact id')
            await initializeToken({ interactive: !json })
            const machines = await listMachineTargets({ machineId })
            console.log(json
                ? JSON.stringify({ ok: true, machines })
                : machines.map((machine) => `${machine.id}  ${machine.displayName ?? machine.host ?? '(unnamed)'}  workspaces=${machine.workspaceRoots.join(',') || '(unrestricted)'}`).join('\n'))
        } catch (error) {
            const useJson = json || commandArgs.includes('--json')
            const code = error instanceof SpawnPeerError || error instanceof TokenInitializationError ? error.code : 'internal'
            const message = error instanceof Error ? error.message : 'Unknown error'
            const output = useJson
                ? JSON.stringify({ ok: false, error: { code, message } })
                : `${chalk.red('hapi machines:')} ${message}`
            useJson ? console.log(output) : console.error(output)
            process.exit(error instanceof TokenInitializationError ? 2 : error instanceof SpawnPeerError ? exitCodeForSpawnPeerError(error) : 1)
        }
    }
}
