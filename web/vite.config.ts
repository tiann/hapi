import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync, readdirSync } from 'node:fs'
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

    const grammar = id.match(/\/node_modules\/@shikijs\/(?:langs|themes)\/dist\/([^/]+)\.mjs$/)
    if (grammar) return `shiki-${grammar[1]}`

    // Keep the React runtime in its own eager chunk: any manual chunk rule
    // that claims a package react also depends on (assistant-ui did) makes
    // rollup merge react INTO that feature chunk, which then becomes part of
    // the entry preload closure. A dedicated react chunk keeps the eager set
    // to exactly {entry, vendor-react, vendor-ui}.
    if (
        id.includes('/node_modules/react/')
        || id.includes('/node_modules/react-dom/')
        || id.includes('/node_modules/scheduler/')
    ) {
        return 'vendor-react'
    }

    // Shared UI primitives (radix, qrcode, cva/clsx/tailwind-merge) are used
    // by both the entry (SessionList dialogs/buttons, promo QR) and the lazy
    // assistant-ui chunk; without their own group rollup merges them into
    // vendor-assistant, dragging that whole chunk into the entry preload.
    if (
        id.includes('/node_modules/@radix-ui/')
        || id.includes('/node_modules/qrcode/')
        || id.includes('/node_modules/class-variance-authority/')
        || id.includes('/node_modules/clsx/')
        || id.includes('/node_modules/tailwind-merge/')
    ) {
        return 'vendor-ui'
    }

    if (id.includes('/node_modules/@xterm/')) {
        return 'vendor-terminal'
    }

    // NOTE: @assistant-ui used to be pinned to a manual 'vendor-assistant'
    // chunk. With route-level splitting that pin backfired twice: rollup
    // merges every module shared with a manual chunk INTO that chunk (react
    // and radix included), and the chunk-level CJS interop helper its remark
    // modules host made the entry statically depend on the whole markdown
    // stack. Left unclaimed, assistant-ui/markdown land in the lazy shared
    // chunks rollup auto-creates for the chat surface (MarkdownRenderer-*).

    if (id.includes('/node_modules/@elevenlabs/react/')) {
        return 'vendor-voice'
    }

    return undefined
}

function copyKaTeXFonts(): Plugin {
    return {
        name: 'copy-katex-fonts',
        apply: 'build',
        generateBundle() {
            const fontsDir = resolve(__dirname, 'node_modules/katex/dist/fonts')
            for (const fileName of readdirSync(fontsDir)) {
                if (!/\.(?:ttf|woff|woff2)$/i.test(fileName)) continue
                this.emitFile({
                    type: 'asset',
                    fileName: `assets/fonts/${fileName}`,
                    source: readFileSync(resolve(fontsDir, fileName))
                })
            }
        }
    }
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
        copyKaTeXFonts(),
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
                // An installed Android WebAPK stores theme_color once at install time and uses it
                // as a fixed toolbar color, so any value here pins the status bar to one appearance.
                // With none, Chrome falls back to white in light mode and black in dark mode. That
                // follows the Android system uiMode, not the in-app appearance setting, so the bar
                // and the app diverge while an appearance override is active. `undefined` is
                // explicit because the plugin fills in its own #42b883 default otherwise, and the
                // resulting "theme_color is missing" build warning is wrong: theme_color is
                // optional for installability.
                theme_color: undefined,
                // Splash background stays light; only the status bar needed to become adaptive.
                background_color: '#ffffff',
                display: 'standalone',
                orientation: 'portrait',
                scope: base,
                start_url: base,
                icons: [
                    {
                        src: 'pwa-16x16.png',
                        sizes: '16x16',
                        type: 'image/png',
                        purpose: 'any'
                    },
                    {
                        src: 'pwa-24x24.png',
                        sizes: '24x24',
                        type: 'image/png',
                        purpose: 'any'
                    },
                    {
                        src: 'pwa-32x32.png',
                        sizes: '32x32',
                        type: 'image/png',
                        purpose: 'any'
                    },
                    {
                        src: 'pwa-48x48.png',
                        sizes: '48x48',
                        type: 'image/png',
                        purpose: 'any'
                    },
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
                    },
                    {
                        src: 'pwa-maskable-192x192.png',
                        sizes: '192x192',
                        type: 'image/png',
                        purpose: 'maskable'
                    },
                    {
                        src: 'pwa-maskable-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'maskable'
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
                // KaTeX fonts keep their stable filenames across releases, so
                // they must NOT match the default dontCacheBustURLsMatching
                // (/^assets\//): Workbox then gives each font a content-hash
                // revision, and a same-named font that changed after an
                // upgrade gets a new precache key that refreshes existing
                // installations instead of surviving worker updates forever.
                dontCacheBustURLsMatching: /^assets\/(?!fonts\/)/,
                // Optional syntax grammars are cached after use, not during PWA installation.
                globIgnores: ['**/shiki-*.js'],
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
