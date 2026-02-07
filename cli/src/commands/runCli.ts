import packageJson from '../../package.json'
import { ensureRuntimeAssets } from '@/runtime/assets'
import { isBunCompiled } from '@/projectPath'
import { logger } from '@/ui/logger'
import { getCliArgs } from '@/utils/cliArgs'
import { resolveCommand } from './registry'

export async function runCli(): Promise<void> {
    // When spawned by the runner in dev mode, HAPI_AGENT_CWD contains the
    // actual working directory. The process starts in the CLI project root
    // so Bun can resolve @/ path aliases via tsconfig.json. We defer the
    // chdir until all dynamic imports (which also use @/) have completed.
    // See claude.ts where the deferred chdir happens.

    const args = getCliArgs()

    if (args.includes('-v') || args.includes('--version')) {
        console.log(`hapi version: ${packageJson.version}`)
        process.exit(0)
    }

    if (isBunCompiled()) {
        process.env.DEV = 'false'
    }

    const { command, context } = resolveCommand(args)

    if (command.requiresRuntimeAssets) {
        await ensureRuntimeAssets()
        logger.debug('Starting hapi CLI with args: ', process.argv)
    }

    await command.run(context)
}
