// Prerenders the static pages from the client build's index.html and the SSR bundle:
//   dist/public/index.html      English home (/)
//   dist/public/zh/index.html   Simplified Chinese home (/zh/)
//   dist/public/404.html        Not-found page (served with status 404)
// Run after `vite build` and `vite build --ssr` (see package.json "build").
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Locale = "en" | "zh";
type Page = "home" | "notFound";
type ServerEntry = {
    render: (locale: Locale, page: Page) => string;
    renderHead: (locale: Locale, page: Page) => string;
    LANG_TAG: Record<Locale, string>;
    LOCALES: Locale[];
    LOCALE_PATH: Record<Locale, string>;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "dist/public");
const ssrDir = resolve(root, "dist/ssr");

const template = await readFile(resolve(outDir, "index.html"), "utf8");
const entry = (await import(pathToFileURL(resolve(ssrDir, "entry-server.js")).href)) as ServerEntry;

for (const marker of ["<!--app-lang-->", "<!--app-head-->", '<div id="root"><!--app-html--></div>']) {
    if (!template.includes(marker)) throw new Error(`index.html template is missing ${marker}`);
}

function page(locale: Locale, kind: Page): string {
    const rootAttrs = kind === "notFound" ? ' data-page="notFound"' : "";
    return template
        .replace("<!--app-lang-->", entry.LANG_TAG[locale])
        .replace("<!--app-head-->", entry.renderHead(locale, kind))
        .replace('<div id="root"><!--app-html--></div>', `<div id="root"${rootAttrs}>${entry.render(locale, kind)}</div>`);
}

const outputs: [string, string][] = [
    ...entry.LOCALES.map((locale): [string, string] => [`${entry.LOCALE_PATH[locale]}index.html`, page(locale, "home")]),
    ["/404.html", page("en", "notFound")],
];

for (const [path, html] of outputs) {
    const target = resolve(outDir, `.${path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, html);
    console.log(`prerendered ${path} (${(html.length / 1024).toFixed(1)} KiB)`);
}

await rm(ssrDir, { recursive: true, force: true });
