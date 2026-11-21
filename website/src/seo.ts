// Builds the per-page <head> markup at prerender time (scripts/prerender.ts).
// Everything crawlers and link unfurlers need lives here as static HTML.
import { content, LANG_TAG, LOCALE_PATH, LOCALES, type Locale, type Page } from "./content";
import { APP_STORE_URL, DOCS, GITHUB_URL, GOOGLE_PLAY_URL, NPM_URL, SITE_URL, SUPPORTED_AGENTS } from "./const";

export const HERO_IMAGE = "/images/iphone-chat.webp";
const OG_IMAGE = `${SITE_URL}/images/og-image.jpg`;

function esc(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const plain = (text: string) => text.replace(/`/g, "");

// Applied before first paint so a stored dark/light choice never flashes.
const THEME_SCRIPT =
    "try{var t=localStorage.getItem('hapi-theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t}catch(e){}";

function jsonLd(locale: Locale): string {
    const t = content[locale];
    const url = `${SITE_URL}${LOCALE_PATH[locale]}`;
    const graph = [
        {
            "@type": "Organization",
            "@id": `${SITE_URL}/#organization`,
            name: "HAPI",
            url: `${SITE_URL}/`,
            logo: `${SITE_URL}/apple-touch-icon-180x180.png`,
            sameAs: [GITHUB_URL, NPM_URL],
        },
        {
            "@type": "WebSite",
            "@id": `${SITE_URL}/#website`,
            name: "HAPI",
            url: `${SITE_URL}/`,
            inLanguage: LANG_TAG[locale],
            publisher: { "@id": `${SITE_URL}/#organization` },
        },
        {
            "@type": "SoftwareApplication",
            "@id": `${SITE_URL}/#software`,
            name: "HAPI",
            url,
            description: t.meta.description,
            applicationCategory: "DeveloperApplication",
            operatingSystem: "macOS, Linux, Windows",
            license: "https://www.gnu.org/licenses/agpl-3.0.html",
            isAccessibleForFree: true,
            offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
            downloadUrl: NPM_URL,
            installUrl: `${SITE_URL}${DOCS.quickStart}`,
            softwareHelp: { "@type": "CreativeWork", url: `${SITE_URL}${DOCS.home}` },
            codeRepository: GITHUB_URL,
            image: OG_IMAGE,
            featureList: SUPPORTED_AGENTS.map((agent) => `${agent} remote control`).join(", "),
            publisher: { "@id": `${SITE_URL}/#organization` },
            sameAs: [GITHUB_URL, APP_STORE_URL, GOOGLE_PLAY_URL],
        },
        {
            "@type": "FAQPage",
            "@id": `${url}#faq`,
            inLanguage: LANG_TAG[locale],
            mainEntity: t.faq.items.map((item) => ({
                "@type": "Question",
                name: item.q,
                acceptedAnswer: { "@type": "Answer", text: plain(item.a) },
            })),
        },
    ];
    // `<` is escaped so the JSON can never close the script element.
    return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
}

export function renderHead(locale: Locale, page: Page): string {
    const t = content[locale];
    const common = [
        `<meta name="theme-color" content="#fff8f6" media="(prefers-color-scheme: light)" />`,
        `<meta name="theme-color" content="#1b1517" media="(prefers-color-scheme: dark)" />`,
        `<meta name="color-scheme" content="light dark" />`,
        `<script>${THEME_SCRIPT}</script>`,
    ];

    if (page === "notFound") {
        return [
            `<title>${esc(t.meta.notFoundTitle)}</title>`,
            `<meta name="robots" content="noindex" />`,
            ...common,
        ].join("\n    ");
    }

    const url = `${SITE_URL}${LOCALE_PATH[locale]}`;
    const alternates = LOCALES.map(
        (l) => `<link rel="alternate" hreflang="${LANG_TAG[l]}" href="${SITE_URL}${LOCALE_PATH[l]}" />`,
    );
    const otherLocales = LOCALES.filter((l) => l !== locale).map(
        (l) => `<meta property="og:locale:alternate" content="${content[l].meta.ogLocale}" />`,
    );

    return [
        `<title>${esc(t.meta.title)}</title>`,
        `<meta name="description" content="${esc(t.meta.description)}" />`,
        `<link rel="canonical" href="${url}" />`,
        ...alternates,
        `<link rel="alternate" hreflang="x-default" href="${SITE_URL}/" />`,
        `<link rel="alternate" type="text/plain" title="llms.txt" href="${SITE_URL}/llms.txt" />`,
        `<link rel="preload" as="image" href="${HERO_IMAGE}" type="image/webp" fetchpriority="high" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:site_name" content="HAPI" />`,
        `<meta property="og:url" content="${url}" />`,
        `<meta property="og:title" content="${esc(t.meta.title)}" />`,
        `<meta property="og:description" content="${esc(t.meta.description)}" />`,
        `<meta property="og:locale" content="${t.meta.ogLocale}" />`,
        ...otherLocales,
        `<meta property="og:image" content="${OG_IMAGE}" />`,
        `<meta property="og:image:width" content="1200" />`,
        `<meta property="og:image:height" content="630" />`,
        `<meta property="og:image:alt" content="${esc(t.cta.mascotsAlt)}" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:creator" content="@tiann" />`,
        `<meta name="twitter:title" content="${esc(t.meta.title)}" />`,
        `<meta name="twitter:description" content="${esc(t.meta.description)}" />`,
        `<meta name="twitter:image" content="${OG_IMAGE}" />`,
        ...common,
        `<script type="application/ld+json">${jsonLd(locale)}</script>`,
    ].join("\n    ");
}
