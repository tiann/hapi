import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { shareTargetPathnameFromBase } from './src/lib/sharePath'

function spaFallback(): Plugin {
    return {
        name: 'spa-fallback',
        configureServer(server) {
            server.middlewares.use((req, _res, next) => {
                const url = (req.url ?? '').split('?')[0]
                if (url === '/' || url === '' || url.includes('.') || url.startsWith('/@') || url.startsWith('/api') || url.startsWith('/socket.io') || url.startsWith('/src/')) {
                    next()
                    return
                }
                req.url = '/index.html'
                next()
            })
        }
    }
}

const base = process.env.VITE_BASE_URL || '/'
const shareAction = shareTargetPathnameFromBase(base)
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

    return undefined
}

export default defineConfig({
    appType: 'spa',
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
        spaFallback(),
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
                // Web Share Target — Android Chrome routes POSTs to /share
                // when the user picks HAPI in the system share sheet. The
                // service worker (`web/src/sw.ts`) intercepts POST /share,
                // stashes the multipart payload in IndexedDB, and 303-
                // redirects to /share?id=<transferId> for the SPA picker.
                // `*/*` is the broad fallback; explicit MIME prefixes stay
                // first because some Chrome versions only honor declared
                // prefixes when surfacing in the share sheet.
                share_target: {
                    action: shareAction,
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
                globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
                // The SPA entry contains the complete multi-agent control surface.
                // Keep it available offline after adding Pi history import instead
                // of silently dropping the entry chunk from the PWA precache.
                maximumFileSizeToCacheInBytes: 3 * 1024 * 1024
            },
            devOptions: {
                enabled: true,
                type: 'module'
            }
        })
    ],
    base,
    optimizeDeps: {
        // dev 下 VitePWA 会给每个页面注入 service worker 注册，而 sw.ts 里的
        // workbox 依赖要等 SW 真正注册后才被 Vite 发现，触发一次「optimized
        // dependencies changed → reloading」的整页刷新。这个刷新会打断当时
        // 正在跑的 e2e（表现为元素凭空消失）。提前声明即可在启动时一次预构建。
        include: [
            'workbox-precaching',
            'workbox-routing',
            'workbox-strategies',
            'workbox-expiration'
        ]
    },
    resolve: {
        // 单例 React 兜底：workspace 里个别依赖（如 @radix-ui/react-popover）
        // 没被链进 web/node_modules，只能从仓库根解析，于是拿到与应用代码
        // 不同的那份 react 实例。两份 React 同时存在会让带 hook 的第三方
        // 组件在渲染时抛 "Invalid hook call"，并连累整棵 React 树卸载。
        dedupe: ['react', 'react-dom'],
        alias: {
            '@': resolve(__dirname, 'src')
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
})
