import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.each(['bundle', 'executable'] as const)('loads passkey routes from a dynamic Bun %s in a fresh process', async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), 'hapi-passkey-bundle-'))
    try {
        const entrypoint = join(dir, 'entry.ts')
        await writeFile(entrypoint, `
            // The compiled CLI dynamically imports the hub; static imports alone
            // do not reproduce Bun's transitive polyfill initialization order.
            const { createPasskeyLoginRoutes } = await import(${JSON.stringify(join(import.meta.dir, 'passkey.ts'))})
            if (typeof createPasskeyLoginRoutes !== 'function') throw new Error('Missing passkey routes')
            console.log('PASSKEY_IMPORT_OK')
        `)
        const output = join(dir, mode === 'bundle' ? 'bundle.mjs' : `passkey${process.platform === 'win32' ? '.exe' : ''}`)
        const build = await Bun.build({
            entrypoints: [entrypoint],
            target: 'bun',
            ...(mode === 'executable'
                ? { compile: { outfile: output, autoloadDotenv: false } }
                : { outdir: dir, naming: 'bundle.mjs' })
        })
        if (!build.success) {
            throw new AggregateError(build.logs, 'Failed to bundle passkey routes')
        }

        // Do not run in the test process: another test may have already
        // initialized Reflect metadata and masked the startup regression.
        const result = Bun.spawnSync(mode === 'executable' ? [output] : [process.execPath, output], {
            cwd: dir,
            timeout: 10_000
        })
        expect({
            exitCode: result.exitCode,
            stdout: result.stdout.toString().trim(),
            stderr: result.stderr.toString().trim()
        }).toEqual({ exitCode: 0, stdout: 'PASSKEY_IMPORT_OK', stderr: '' })
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}, 15_000)
