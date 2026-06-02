import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
    build: {
        outDir: 'dist/main',
        emptyOutDir: false,
        target: 'node20',
        lib: {
            entry: resolve(__dirname, 'src/preload/index.ts'),
            formats: ['cjs']
        },
        rollupOptions: {
            external: ['electron'],
            output: {
                entryFileNames: 'preload.cjs'
            }
        }
    }
})
