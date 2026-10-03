import { cliT } from '@/i18n/cliI18n'
import { CREATABLE_AGENT_FLAVORS, getFlavorLabel } from '@hapi/protocol'

export function printCliHelp(): void {
    const agents = [...CREATABLE_AGENT_FLAVORS].sort().map((agent) => (
        `  ${`hapi ${agent}`.padEnd(26)} ${getFlavorLabel(agent)}`
    )).join('\n')

    console.log(cliT('cli.help', { agents }))
}
