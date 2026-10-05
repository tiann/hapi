import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";

const LANGUAGES = ["en", "zh", "ru"] as const;
type Language = (typeof LANGUAGES)[number];

const LABELS: Record<Language, string> = {
  en: "EN",
  zh: "中",
  ru: "RU",
};

function currentLanguage(language: string): Language {
  if (language.startsWith("zh")) return "zh";
  if (language.startsWith("ru")) return "ru";
  return "en";
}

export function LanguageToggle() {
  const { i18n } = useTranslation();

  const current = currentLanguage(i18n.language);
  const next = LANGUAGES[(LANGUAGES.indexOf(current) + 1) % LANGUAGES.length];

  const toggleLanguage = () => {
    i18n.changeLanguage(next);
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={toggleLanguage}
      title={LABELS[next]}
      className="font-bold border-2 border-border shadow-hard hover:translate-y-0.5 hover:shadow-none transition-all w-12"
    >
      {LABELS[next]}
    </Button>
  );
}
