import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { corpus, names, run } from './run'

for (const name of process.argv.length > 2 ? process.argv.slice(2) : names) {
    const transcript = await run(name)
    writeFileSync(join(corpus, name, 'golden.ts.json'), JSON.stringify(transcript, null, 2) + '\n')
    console.log(name)
}
