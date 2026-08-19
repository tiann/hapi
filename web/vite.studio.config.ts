import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
    appType: 'spa',
    base: '/',
    plugins: [react()],
    resolve: {
        dedupe: ['react', 'react-dom'],
        alias: {
            '@': resolve(__dirname, 'src')
        }
    },
    build: {
        outDir: 'dist-studio',
        emptyOutDir: true,
        rollupOptions: {
            input: resolve(__dirname, 'studio.html'),
            output: {
                entryFileNames: 'studio-assets/studio-[hash].js',
                chunkFileNames: 'studio-assets/studio-chunk-[hash].js',
                assetFileNames: 'studio-assets/studio-[hash][extname]'
            }
        }
    }
})
