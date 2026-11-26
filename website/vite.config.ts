import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";

const BUILD_YEAR = String(new Date().getFullYear());

// Dev only: server-render the page the same way scripts/prerender.ts does for
// production builds, so `vite dev` exercises hydration too.
function devSsr(): Plugin {
    let server: ViteDevServer;
    return {
        name: "hapi-dev-ssr",
        apply: "serve",
        configureServer(s) {
            server = s;
        },
        transformIndexHtml: {
            order: "pre",
            async handler(html, ctx) {
                const mod = await server.ssrLoadModule("/src/entry-server.tsx");
                const locale = (ctx.originalUrl ?? ctx.path).startsWith("/zh") ? "zh" : "en";
                return html
                    .replace("<!--app-lang-->", mod.LANG_TAG[locale])
                    // In dev, Vite injects CSS from JS, so the server-rendered markup would paint
                    // unstyled until the module runs. A render-blocking link matches production.
                    .replace(
                        "<!--app-head-->",
                        `${mod.renderHead(locale, "home")}\n<link rel="stylesheet" href="/src/index.css" />`,
                    )
                    .replace("<!--app-html-->", mod.render(locale, "home"));
            },
        },
    };
}

export default defineConfig({
    plugins: [react(), tailwindcss(), devSsr()],
    define: {
        __BUILD_YEAR__: JSON.stringify(BUILD_YEAR),
    },
    resolve: {
        alias: {
            "@": path.resolve(import.meta.dirname, "src"),
        },
    },
    // Bundle the icon package into the SSR build: its deep ESM paths aren't
    // resolvable by Node's loader at prerender time.
    ssr: {
        noExternal: ["@lobehub/icons"],
    },
    build: {
        outDir: path.resolve(import.meta.dirname, "dist/public"),
        emptyOutDir: true,
    },
    server: {
        port: 3000,
        strictPort: false, // Will find next available port if 3000 is busy
        host: true,
        allowedHosts: ["localhost", "127.0.0.1"],
        fs: {
            strict: true,
            deny: ["**/.*"],
        },
    },
});
