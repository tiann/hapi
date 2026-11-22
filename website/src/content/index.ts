import { en, type Content } from "./en";
import { zh } from "./zh";

export type Locale = "en" | "zh";
export type Page = "home" | "notFound";

export const LOCALES: Locale[] = ["en", "zh"];

export const content: Record<Locale, Content> = { en, zh };

/** BCP 47 tag used for <html lang> and hreflang. */
export const LANG_TAG: Record<Locale, string> = { en: "en", zh: "zh-Hans" };

/** Site-relative path of each locale's home page. */
export const LOCALE_PATH: Record<Locale, string> = { en: "/", zh: "/zh/" };

export type { Content };
