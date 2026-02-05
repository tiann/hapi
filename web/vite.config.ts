import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

const base = process.env.VITE_BASE_URL || '/'

// Import version info from generated file (created by prebuild script)
// This ensures all components (server, CLI, web) use the same version source
function getVersionInfo() {
    try {
        // Import is synchronous here because this runs at build time
        const versionModule = require('./src/version.generated.ts')
        return versionModule.default
    } catch (error) {
        console.warn('Failed to load version.generated.ts, using fallback:', error)
        return {
            sha: 'unknown',
            shortSha: 'unknown',
            buildTime: new Date().toISOString(),
            isDirty: false,
            gitDescribe: 'unknown'
        }
    }
}

// Plugin to inject version into HTML
function injectVersionPlugin(): Plugin {
    const version = getVersionInfo()
    return {
        name: 'inject-version',
        transformIndexHtml(html) {
            return html.replace(
                '</head>',
                `    <meta name="app-version" content="${version.sha}" />\n    <meta name="app-version-short" content="${version.shortSha}" />\n    <meta name="app-build-time" content="${version.buildTime}" />\n    <meta name="app-version-dirty" content="${version.isDirty}" />\n    <meta name="app-version-describe" content="${version.gitDescribe}" />\n  </head>`
            )
        },
    }
}

export default defineConfig({
    server: {
        host: true,
        allowedHosts: ['hapidev.weishu.me'],
        proxy: {
            '/api': {
                target: process.env.VITE_API_TARGET || 'http://127.0.0.1:3006',
                changeOrigin: true,
                secure: true
            },
            '/socket.io': {
                target: process.env.VITE_API_TARGET || 'http://127.0.0.1:3006',
                changeOrigin: true,
                secure: true,
                ws: true
            }
        }
    },
    plugins: [
        react(),
        injectVersionPlugin(),
        VitePWA({
            registerType: 'autoUpdate',
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
                        type: 'image/png'
                    },
                    {
                        src: 'pwa-192x192.png',
                        sizes: '192x192',
                        type: 'image/png'
                    },
                    {
                        src: 'pwa-512x512.png',
                        sizes: '512x512',
                        type: 'image/png'
                    },
                    {
                        src: 'maskable-icon-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'maskable'
                    }
                ]
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
            '@': resolve(__dirname, 'src')
        }
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true
    }
})
