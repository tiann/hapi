import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";

interface SEOProps {
  title?: string;
  description?: string;
  image?: string;
  url?: string;
}

export function SEO({ title, description, image, url }: SEOProps) {
  const { t, i18n } = useTranslation();
  const currentLang = i18n.language;
  const baseLang = currentLang.toLowerCase().split(/[-_]/)[0];

  const siteTitle = t("meta.title");
  const defaultDescription = t("meta.description");
  const siteUrl = "https://hapi.manus.space";
  const defaultImage = "/images/og-image.png"; // We need to create this or use an existing one

  const metaTitle = title ? `${title} | HAPI` : siteTitle;
  const metaDescription = description || defaultDescription;
  const metaImage = image ? `${siteUrl}${image}` : `${siteUrl}${defaultImage}`;
  const metaUrl = url ? `${siteUrl}${url}` : siteUrl;

  // Structured Data for Software Application
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "HAPI",
    operatingSystem: "Windows, macOS, Linux",
    applicationCategory: "DeveloperApplication",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
    description: metaDescription,
    softwareVersion: "0.3.1",
  };

  return (
    <Helmet>
      {/* Basic Meta Tags */}
      <html lang={currentLang} />
      <title>{metaTitle}</title>
      <meta name="description" content={metaDescription} />
      <link rel="canonical" href={metaUrl} />

      {/* Hreflang Tags for SEO */}
      <link rel="alternate" hrefLang="en" href={`${siteUrl}?lng=en`} />
      <link rel="alternate" hrefLang="zh" href={`${siteUrl}?lng=zh`} />
      <link rel="alternate" hrefLang="ru" href={`${siteUrl}?lng=ru`} />
      <link rel="alternate" hrefLang="x-default" href={siteUrl} />

      {/* Open Graph / Facebook */}
      <meta property="og:type" content="website" />
      <meta property="og:url" content={metaUrl} />
      <meta property="og:title" content={metaTitle} />
      <meta property="og:description" content={metaDescription} />
      <meta property="og:image" content={metaImage} />
      <meta
        property="og:locale"
        content={
          baseLang === "zh" ? "zh_CN" : baseLang === "ru" ? "ru_RU" : "en_US"
        }
      />
      <meta property="og:site_name" content="HAPI" />

      {/* Twitter */}
      <meta property="twitter:card" content="summary_large_image" />
      <meta property="twitter:url" content={metaUrl} />
      <meta property="twitter:title" content={metaTitle} />
      <meta property="twitter:description" content={metaDescription} />
      <meta property="twitter:image" content={metaImage} />
      <meta name="twitter:creator" content="@tiann" />

      {/* Structured Data */}
      <script type="application/ld+json">
        {JSON.stringify(structuredData)}
      </script>
    </Helmet>
  );
}
