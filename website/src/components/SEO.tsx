import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";

// Static meta tags, Open Graph and JSON-LD live in index.html so crawlers that don't run
// JavaScript still see them. Only the language-dependent bits are managed here.
export function SEO({ title }: { title?: string }) {
  const { i18n } = useTranslation();

  return (
    <Helmet>
      <html lang={i18n.language} />
      <title>{title ? `${title} | HAPI` : "HAPI - Vibe Coding Anytime, Anywhere"}</title>
    </Helmet>
  );
}
