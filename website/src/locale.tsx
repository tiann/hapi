import { createContext, useContext, type ReactNode } from "react";
import { content, LANG_TAG, LOCALE_PATH, type Content, type Locale } from "./content";

type LocaleValue = { locale: Locale; t: Content; lang: string; home: string };

const LocaleContext = createContext<LocaleValue | null>(null);

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
    const value = { locale, t: content[locale], lang: LANG_TAG[locale], home: LOCALE_PATH[locale] };
    return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleValue {
    const value = useContext(LocaleContext);
    if (!value) throw new Error("useLocale must be used inside LocaleProvider");
    return value;
}
