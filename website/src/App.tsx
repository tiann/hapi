import { LocaleProvider } from "./locale";
import type { Locale, Page } from "./content";
import { SiteHeader } from "./components/SiteHeader";
import { SiteFooter } from "./components/SiteFooter";
import { Home } from "./components/Home";
import { NotFound } from "./components/NotFound";

export function App({ locale, page }: { locale: Locale; page: Page }) {
    return (
        <LocaleProvider locale={locale}>
            <SiteHeader page={page} />
            <main id="main">{page === "home" ? <Home /> : <NotFound />}</main>
            <SiteFooter />
        </LocaleProvider>
    );
}
