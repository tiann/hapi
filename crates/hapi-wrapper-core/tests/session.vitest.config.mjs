import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const path = relative => fileURLToPath(new URL(relative, import.meta.url))
const cliRequire = createRequire(path('../../../cli/package.json'))

export default {
    root: path('../../../'),
    resolve: {
        alias: {
            '@': path('../../../cli/src'),
            vitest: path('../../../cli/node_modules/vitest/dist/index.js'),
            'socket.io-client': cliRequire.resolve('socket.io-client')
        }
    },
    test: { include: ['crates/hapi-wrapper-core/tests/session_vectors.test.ts'] }
}
