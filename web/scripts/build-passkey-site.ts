import { cp, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

// Independent output: never deploy the marketing app/scripts to this origin.
const outdir = resolve(import.meta.dir, '../../website/dist/auth')
await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })
await cp(resolve(import.meta.dir, '../passkey-site'), outdir, { recursive: true })
const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, '../src/passkey-site/main.ts')],
    outdir, target: 'browser', minify: true, naming: 'main.js'
})
if (!result.success) throw new AggregateError(result.logs, 'Passkey site build failed')
console.log(`Static passkey site: ${outdir} (deploy only this directory to auth.hapi.run)`)
