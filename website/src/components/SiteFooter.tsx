import { useLocale } from "../locale";
import { DOCS, GITHUB_URL, ISSUES_URL, RELEASES_URL } from "../const";
import { Mark } from "./ui";

export function SiteFooter() {
    const { t, home } = useLocale();
    const columns = [
        {
            title: t.footer.product,
            links: [
                [`${home}#how-it-works`, t.nav.howItWorks],
                [`${home}#features`, t.nav.features],
                [`${home}#apps`, t.nav.apps],
                [`${home}#install`, t.nav.install],
                [`${home}#faq`, t.nav.faq],
            ],
        },
        {
            title: t.footer.resources,
            links: [
                [DOCS.quickStart, t.footer.quickStart],
                [DOCS.agents, t.footer.agents],
                [DOCS.nativeApps, t.footer.nativeApps],
                [DOCS.whyHapi, t.footer.whyHapi],
                ["/llms.txt", t.footer.llms],
            ],
        },
        {
            title: t.footer.community,
            links: [
                [GITHUB_URL, "GitHub"],
                [RELEASES_URL, t.footer.releases],
                [ISSUES_URL, t.footer.issues],
                [DOCS.privacy, t.footer.privacy],
            ],
        },
    ];

    return (
        <footer className="site-footer">
            <div className="wrap grid grid-cols-2 gap-10 py-14 md:grid-cols-[1.4fr_repeat(3,1fr)]">
                <div className="col-span-2 max-w-xs md:col-span-1">
                    <a href={home} className="brand" aria-label="HAPI">
                        <Mark className="h-7 w-auto text-coral" />
                        <span className="brand-word">HAPI</span>
                    </a>
                    <p className="mt-4 text-sm leading-relaxed text-muted">{t.footer.tagline}</p>
                </div>
                {columns.map((col) => (
                    <nav key={col.title} aria-label={col.title}>
                        <h2 className="text-sm font-semibold">{col.title}</h2>
                        <ul className="mt-3 space-y-2 text-sm">
                            {col.links.map(([href, label]) => (
                                <li key={href}>
                                    <a className="footer-link" href={href}>
                                        {label}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </nav>
                ))}
            </div>
            <div className="wrap">
                <p className="border-t border-line py-6 text-xs text-muted">
                    © {__BUILD_YEAR__} HAPI · {t.footer.license}
                </p>
            </div>
        </footer>
    );
}
