import { cliT } from '@/i18n/cliI18n'
import packageJson from '../../package.json'
import { getCliArgs } from '@/utils/cliArgs'
import { ensureLoopbackProxyBypass } from '@/utils/proxyEnv'
import { printCliHelp } from './help'

export async function runCli(): Promise<void> {
    const args = getCliArgs()

    if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
        printCliHelp()
        return
    }

    if (args[0] === '-v' || args[0] === '--version') {
        console.log(cliT('runCli.version', { version: packageJson.version }))
        return
    }

    if (args.length === 0) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            console.error(cliT('runCli.needsInteractive'))
            printCliHelp()
            process.exitCode = 1
            return
        }

        const { selectAgent } = await import('@/ui/selectAgent')
        const selection = await selectAgent()
        if (selection.type === 'exit') {
            process.exitCode = selection.exitCode
            return
        }
        args.push(selection.agent)
    }

    const { resolveCommand } = await import('./registry')
    const resolved = resolveCommand(args)
    if (!resolved) {
        console.error(cliT(args[0].startsWith('-') ? 'runCli.unknownOption' : 'runCli.unknownCommand', { name: args[0] }))
        console.error(cliT('runCli.hint'))
        process.exitCode = 1
        return
    }

    ensureLoopbackProxyBypass()
    const { isBunCompiled } = await import('@/projectPath')
    if (isBunCompiled()) {
        process.env.DEV = 'false'
    }

    const { command, context } = resolved

    if (command.requiresRuntimeAssets) {
        const { ensureRuntimeAssets } = await import('@/runtime/assets')
        await ensureRuntimeAssets()
        const { logger } = await import('@/ui/logger')
        logger.debug('Starting hapi CLI with args: ', args)
    }

    await command.run(context)
}
