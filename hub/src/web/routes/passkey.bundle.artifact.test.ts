import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'

/**
 * `Bun.build({ compile })` writes a `<hash>-00000000.bun-build` intermediate
 * next to its outfile and renames it when it is done. The executable case of
 * `passkey.bundle.test.ts` compiles into this package's directory, so a
 * failure (or a killed run) leaves a ~60 MB Mach-O behind next to the
 * sources; one was swept into a commit by `git add -A` once. The ignore rule
 * in the repository's `.gitignore` is what keeps it out: this pins it, and
 * that no such file is tracked.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')

function git(...args: string[]): { exitCode: number; stdout: string } {
    const result = Bun.spawnSync(['git', ...args], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'ignore' })
    return { exitCode: result.exitCode, stdout: result.stdout.toString().trim() }
}

const inWorkTree = git('rev-parse', '--is-inside-work-tree').exitCode === 0

describe.skipIf(!inWorkTree)('Bun build intermediates', () => {
    it('the artifact the passkey test may leave in this directory is ignored', () => {
        // Exit 0: the path matches an ignore rule; 1: it does not.
        expect(git('check-ignore', '-q', join(import.meta.dir, '.00000000-00000000.bun-build')).exitCode).toBe(0)
    })

    it('no *.bun-build file is tracked', () => {
        expect(git('ls-files', '--', '*.bun-build').stdout).toBe('')
    })
})
