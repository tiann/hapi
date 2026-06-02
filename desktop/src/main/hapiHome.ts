import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function getHapiHome(): string {
    const configured = process.env.HAPI_HOME
    if (!configured) {
        return join(homedir(), '.hapi')
    }
    if (configured === '~') {
        return homedir()
    }
    if (configured.startsWith('~/') || configured.startsWith('~\\')) {
        return join(homedir(), configured.slice(2))
    }
    return resolve(configured)
}
