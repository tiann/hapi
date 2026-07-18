import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const base = process.env.VITE_BASE_URL || '/'
const hubTarget = process.env.VITE_HUB_PROXY || 'http://127.0.0.1:3006'
const devAllowedHosts = (process.env.HAPI_DEV_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)

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

    return undefined
}

export default defineConfig({
    define: {
        __APP_VERSION__: JSON.stringify(require('../cli/package.json').version),
    },
    server: {
        host: true,
        allowedHosts: devAllowedHosts,
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
            // main.tsx owns registration through virtual:pwa-register. Keeping
            // the plugin in manual mode avoids a second dev registration path.
            injectRegister: null,
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
                ]
            },
            injectManifest: {
                globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
                globIgnores: [
                    '**/vendor-voice-*.js',
                    '**/vendor-terminal-*.js',
                    '**/vendor-terminal-*.css',
                    '**/icon.svg',
                    '**/c-*.js',
                    '**/csharp-*.js',
                    '**/css-*.js',
                    '**/diff-*.js',
                    '**/dockerfile-*.js',
                    '**/go-*.js',
                    '**/graphql-*.js',
                    '**/html-*.js',
                    '**/ini-*.js',
                    '**/java-*.js',
                    '**/javascript-*.js',
                    '**/json-*.js',
                    '**/jsx-*.js',
                    '**/kotlin-*.js',
                    '**/make-*.js',
                    '**/markdown-*.js',
                    '**/php-*.js',
                    '**/powershell-*.js',
                    '**/python-*.js',
                    '**/rust-*.js',
                    '**/scss-*.js',
                    '**/shellscript-*.js',
                    '**/sql-*.js',
                    '**/swift-*.js',
                    '**/toml-*.js',
                    '**/tsx-*.js',
                    '**/typescript-*.js',
                    '**/xml-*.js',
                    '**/yaml-*.js',
                    '**/github-dark-*.js',
                    '**/github-light-*.js'
                ]
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
            '@': resolve(__dirname, 'src')
        }
    },
    build: {
        modulePreload: {
            resolveDependencies(_filename, deps, context) {
                if (context.hostType !== 'html') {
                    return deps
                }
                return deps.filter((dep) => ![
                    'vendor-assistant-',
                    'vendor-voice-',
                    'vendor-terminal-'
                ].some((prefix) => dep.includes(prefix)))
            }
        },
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
})
