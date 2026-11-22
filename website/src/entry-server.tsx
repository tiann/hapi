import { renderToString } from "react-dom/server";
import { StrictMode } from "react";
import { App } from "./App";
import type { Locale, Page } from "./content";

export { renderHead } from "./seo";
export { LANG_TAG, LOCALES, LOCALE_PATH } from "./content";

export function render(locale: Locale, page: Page): string {
    return renderToString(
        <StrictMode>
            <App locale={locale} page={page} />
        </StrictMode>,
    );
}
