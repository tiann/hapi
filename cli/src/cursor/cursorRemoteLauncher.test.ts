import { describe, expect, it } from 'vitest'
import { buildCursorRemoteSpawnSpec } from './cursorRemoteLauncher'

describe('Cursor remote spawn command', () => {
    it('builds the child process spec with cursor-agent, not generic agent', () => {
        expect(buildCursorRemoteSpawnSpec(['-p', 'hello'], '/tmp/project', {
            HOME: '/Users/example',
        })).toMatchObject({
            command: 'cursor-agent',
            args: ['-p', 'hello'],
            options: {
                cwd: '/tmp/project',
            },
        })
    })

    it('honors HAPI_CURSOR_PATH through the shared resolver', () => {
        expect(buildCursorRemoteSpawnSpec([], '/tmp/project', {
            HAPI_CURSOR_PATH: '/opt/cursor-agent',
        }).command).toBe('/opt/cursor-agent')
    })
})
