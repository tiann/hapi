import packageJson from '../../package.json'
import version from '../version.generated'
import { ensureRuntimeAssets } from '@/runtime/assets'
import { isBunCompiled } from '@/projectPath'
import { logger } from '@/ui/logger'
import { getCliArgs } from '@/utils/cliArgs'
import { resolveCommand } from './registry'

export async function runCli(): Promise<void> {
    const args = getCliArgs()

    if (args.includes('-v') || args.includes('--version')) {
        console.log(`hapi version: ${packageJson.version}`)
        console.log(`git: ${version.gitDescribe}${version.isDirty ? ' (dirty)' : ''}`)
        console.log(`commit: ${version.shortSha} (${new Date(version.commitTime).toLocaleString()})`)
        console.log(`built: ${new Date(version.buildTime).toLocaleString()}`)
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
