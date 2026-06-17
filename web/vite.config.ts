import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const base = process.env.VITE_BASE_URL || '/'
const hubTarget = process.env.VITE_HUB_PROXY || 'http://127.0.0.1:3006'
const appVersion = readAppVersion()

function readAppVersion(): string {
    const buildInfoPath = resolve(__dirname, '../shared/src/buildInfo.ts')
    const buildInfo = readFileSync(buildInfoPath, 'utf8')
    const match = buildInfo.match(/export const APP_VERSION = ['"]([^'"]+)['"]/)

    if (!match) {
        throw new Error(`Could not read APP_VERSION from ${buildInfoPath}`)
    }

    return match[1]
}

function getVendorChunkName(id: string): string | undefined {
    if (!id.includes('/node_modules/')) {
        return undefined
    }

    if (id.includes('/node_modules/@xterm/')) {
        return 'vendor-terminal'
    }

    if (
        id.includes('/node_modules/@assistant-ui/')
        || id.includes('/node_modules/remark-gfm/')
        || id.includes('/node_modules/hast-util-to-jsx-runtime/')
    ) {
        return 'vendor-assistant'
    }

    if (id.includes('/node_modules/@elevenlabs/react/')) {
        return 'vendor-voice'
    }

    if (
        id.includes('/node_modules/three/')
        || id.includes('/node_modules/@react-three/')
    ) {
        return 'vendor-three'
    }

    return undefined
}

export default defineConfig(({ mode }) => {
    // In production we stub out the IWER WebXR emulator packages so they
    // don't bloat the bundle or introduce the @bufbuild/protobuf 2.x conflict.
    // In dev/test the real packages are live so IWER-based Playwright tests work.
    const stubIwer = mode === 'production'
    const iwerStub = resolve(__dirname, 'src/vendor-stubs/iwer-stub.ts')
    const iwerAliases = stubIwer
        ? { '@iwer/sem': iwerStub, '@iwer/devui': iwerStub, 'iwer': iwerStub }
        : {}

    return {
        define: {
            __APP_VERSION__: JSON.stringify(appVersion),
        },
        server: {
            host: true,
            allowedHosts: ['hapidev.weishu.me'],
            proxy: {
                '/api': {
                    target: hubTarget,
                    changeOrigin: true
                },
                '/socket.io': {
                    target: hubTarget,
                    ws: true
                }
            }
        },
        plugins: [
            react(),
            VitePWA({
                // User-controlled reload avoids mid-session surprise reloads (autoUpdate reloads all tabs).
                registerType: 'prompt',
                includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'mask-icon.svg'],
                strategies: 'injectManifest',
                srcDir: 'src',
                filename: 'sw.ts',
                manifest: {
                    name: 'HAPI',
                    short_name: 'HAPI',
                    description: 'AI-powered development assistant',
                    theme_color: '#ffffff',
                    background_color: '#ffffff',
                    display: 'standalone',
                    orientation: 'portrait',
                    scope: base,
                    start_url: base,
                    icons: [
                        {
                            src: 'pwa-64x64.png',
                            sizes: '64x64',
                            type: 'image/png',
                            purpose: 'any'
                        },
                        {
                            src: 'pwa-192x192.png',
                            sizes: '192x192',
                            type: 'image/png',
                            purpose: 'any'
                        },
                        {
                            src: 'pwa-512x512.png',
                            sizes: '512x512',
                            type: 'image/png',
                            purpose: 'any'
                        }
                    ],
                    share_target: {
                        action: '/share',
                        method: 'POST',
                        enctype: 'multipart/form-data',
                        params: {
                            title: 'title',
                            text: 'text',
                            url: 'url',
                            files: [
                                {
                                    name: 'files',
                                    accept: [
                                        'image/*',
                                        'application/pdf',
                                        'text/*',
                                        'application/json',
                                        'application/zip',
                                        '*/*'
                                    ]
                                }
                            ]
                        }
                    }
                },
                injectManifest: {
                    globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}']
                },
                devOptions: {
                    enabled: true,
                    type: 'module'
                }
            })
        ],
        base,
        resolve: {
            alias: {
                '@': resolve(__dirname, 'src'),
                ...iwerAliases,
            }
        },
        build: {
            outDir: 'dist',
            emptyOutDir: true,
            rollupOptions: {
                output: {
                    manualChunks(id) {
                        return getVendorChunkName(id)
                    }
                }
            }
        }
    }
})
