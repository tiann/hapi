import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
    build: {
        outDir: 'dist/main',
        emptyOutDir: true,
        target: 'node20',
        lib: {
            entry: resolve(__dirname, 'src/main/index.ts'),
            formats: ['es']
        },
        rollupOptions: {
            external: [
                'electron',
                'node:child_process',
                'node:crypto',
                'node:events',
                'node:fs',
                'node:fs/promises',
                'node:net',
                'node:os',
                'node:path',
                'node:url'
            ],
            output: {
                entryFileNames: 'index.js'
            }
        }
    }
})
