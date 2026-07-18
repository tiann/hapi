import packageJson from '../../package.json'
import { getCliArgs } from '@/utils/cliArgs'
import { consumeManagedLaunchArgs } from '@/runner/managedLaunchArgs'

export async function runCli(): Promise<void> {
    const args = consumeManagedLaunchArgs(getCliArgs())

    if (args.includes('-v') || args.includes('--version')) {
        console.log(`hapi version: ${packageJson.version}`)
        process.exit(0)
    }

    if (args[0] === 'doctor' && args[1] === 'storage') {
        const { doctorCommand } = await import('./doctor')
        await doctorCommand.run({
            args,
            subcommand: 'doctor',
            commandArgs: args.slice(1)
        })
        return
    }

    if (args[0] === 'hub' || args[0] === 'server') {
        // Hub owns its strict option parsing and must be able to print help (or
        // reject invalid input) before importing logger/configuration modules
        // that create HAPI_HOME runtime state.
        const { hubCommand } = await import('./hub')
        await hubCommand.run({
            args,
            subcommand: args[0],
            commandArgs: args.slice(1),
        })
        return
    }

    const { isBunCompiled } = await import('@/projectPath')
    if (isBunCompiled()) {
        process.env.DEV = 'false'
    }

    const { resolveCommand } = await import('./registry')
    const { command, context } = resolveCommand(args)

    if (command.requiresRuntimeAssets) {
        const { ensureRuntimeAssets } = await import('@/runtime/assets')
        const { logger } = await import('@/ui/logger')
        await ensureRuntimeAssets()
        logger.debug('Starting hapi CLI with args: ', process.argv)
    }

    await command.run(context)
}
