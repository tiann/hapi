import { BookOpen, Moon, Sun } from "lucide-react";
import { useLocale } from "../locale";
import { LANG_TAG, LOCALE_PATH, type Page } from "../content";
import { DOCS, GITHUB_URL } from "../const";
import { GitHubIcon, Mark } from "./ui";

function toggleTheme() {
    const root = document.documentElement;
    const current =
        root.dataset.theme ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try {
        localStorage.setItem("hapi-theme", next);
    } catch {
        // Ignore storage errors
    }
}

export function SiteHeader({ page }: { page: Page }) {
    const { t, locale, home } = useLocale();
    const other = locale === "en" ? "zh" : "en";
    // Section links point at the home page so they also work from the 404 page.
    const base = page === "home" ? "" : home;
    const links = [
        ["#how-it-works", t.nav.howItWorks],
        ["#features", t.nav.features],
        ["#security", t.nav.security],
        ["#apps", t.nav.apps],
        ["#install", t.nav.install],
        ["#faq", t.nav.faq],
    ] as const;

    return (
        <header className="site-header">
            <a className="skip-link" href="#main">
                {t.nav.skip}
            </a>
            <div className="wrap flex h-16 items-center gap-6">
                <a href={home} className="brand" aria-label="HAPI">
                    <Mark className="h-7 w-auto text-coral" />
                    <span className="brand-word">HAPI</span>
                </a>
                <nav aria-label={t.nav.primary} className="hidden flex-1 lg:block">
                    <ul className="flex items-center gap-1">
                        {links.map(([hash, label]) => (
                            <li key={hash}>
                                <a className="nav-link" href={`${base}${hash}`}>
                                    {label}
                                </a>
                            </li>
                        ))}
                    </ul>
                </nav>
                <div className="ml-auto flex items-center gap-1.5 lg:ml-0">
                    <a className="docs-btn" href={DOCS.home}>
                        <BookOpen aria-hidden size={16} />
                        {t.nav.docs}
                    </a>
                    <a
                        className="icon-btn text-sm font-semibold"
                        href={LOCALE_PATH[other]}
                        hrefLang={LANG_TAG[other]}
                        lang={LANG_TAG[other]}
                        aria-label={t.nav.otherLanguageLabel}
                    >
                        {t.nav.otherLanguage}
                    </a>
                    <button type="button" className="icon-btn" onClick={toggleTheme} aria-label={t.nav.themeToggle}>
                        <Sun aria-hidden size={18} className="theme-icon-light" />
                        <Moon aria-hidden size={18} className="theme-icon-dark" />
                    </button>
                    <a className="icon-btn" href={GITHUB_URL} aria-label={t.nav.github}>
                        <GitHubIcon />
                    </a>
                </div>
            </div>
        </header>
    );
}
