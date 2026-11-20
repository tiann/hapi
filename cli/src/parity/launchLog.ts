import { closeSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function claimLaunch(out: string, kind: 'version' | 'probe' | 'agent') {
    for (let index = 1; ; index++) {
        const file = join(out, kind + '-' + index + '.log.json')
        try {
            closeSync(openSync(file + '.claim', 'wx'))
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
            throw error
        }
        return {
            index,
            save(log: unknown) {
                writeFileSync(file + '.tmp', JSON.stringify(log))
                renameSync(file + '.tmp', file)
            }
        }
    }
}

export function readLaunches(out: string) {
    return ['version', 'probe', 'agent'].flatMap(kind => readdirSync(out)
        .filter(file => new RegExp('^' + kind + '-\\d+\\.log\\.json$').test(file))
        .sort((a, b) => parseInt(a.slice(kind.length + 1)) - parseInt(b.slice(kind.length + 1)))
        .map(file => JSON.parse(readFileSync(join(out, file), 'utf8'))))
}
