import { Button } from "@/components/ui/button";
import { ExternalLink, Menu, X } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { ModeToggle } from "./ModeToggle";
import { LanguageToggle } from "./LanguageToggle";
import { useTranslation } from "react-i18next";

export default function Layout({ children }: { children: React.ReactNode }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { t } = useTranslation();

  return (
    <div className="min-h-screen flex flex-col bg-background font-sans selection:bg-primary selection:text-primary-foreground">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b-2 border-border bg-background/70 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between">
          <div className="flex items-center gap-2">
            <Link href="/" className="flex items-center gap-2 group">
              <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center border-2 border-border shadow-hard-sm group-hover:translate-y-0.5 group-hover:shadow-none transition-all">
                <span className="text-primary-foreground font-bold text-lg">H</span>
              </div>
              <span className="font-bold text-xl tracking-tight">HAPI</span>
            </Link>
          </div>

          {/* Desktop Nav */}
          <nav className="hidden md:flex items-center gap-6">
            <div className="flex items-center gap-4">
              <LanguageToggle />
              <ModeToggle />
              <a href="https://github.com/tiann/hapi" target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground transition-colors">
                <ExternalLink className="h-5 w-5" />
              </a>
              <Button className="font-bold shadow-hard hover:translate-y-0.5 hover:shadow-none transition-all border-2 border-border" asChild>
                <a href="/docs/">{t('nav.getStarted')}</a>
              </Button>
            </div>
          </nav>

          {/* Mobile Menu Toggle */}
          <div className="flex items-center gap-4 md:hidden">
            <LanguageToggle />
            <ModeToggle />
            <button className="p-2" onClick={() => setIsMenuOpen(!isMenuOpen)}>
              {isMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>
          </div>
        </div>

        {/* Mobile Nav */}
        {isMenuOpen && (
          <div className="md:hidden border-b-2 border-border bg-background p-4">
            <nav className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Button className="w-full font-bold shadow-hard border-2 border-border" asChild>
                  <a href="/docs/">{t('nav.getStarted')}</a>
                </Button>
                <a href="https://github.com/tiann/hapi" target="_blank" rel="noreferrer" className="flex items-center justify-center gap-2 text-sm font-medium p-2 hover:bg-muted rounded-md">
                  <ExternalLink className="h-4 w-4" /> {t('nav.viewOnGithub')}
                </a>
              </div>
            </nav>
          </div>
        )}
      </header>

      {/* Main Content */}
      <main className="flex-1">
        {children}
      </main>

      {/* Footer */}
      <footer className="border-t-2 border-border bg-muted/30 py-12">
        <div className="container">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            <div className="col-span-1 md:col-span-2">
              <div className="flex items-center gap-2 mb-4">
                <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center border-2 border-border shadow-hard-sm">
                  <span className="text-primary-foreground font-bold text-lg">H</span>
                </div>
                <span className="font-bold text-xl tracking-tight">HAPI</span>
              </div>
              <p className="text-muted-foreground text-sm max-w-xs leading-relaxed" dangerouslySetInnerHTML={{ __html: t('footer.desc') }} />
            </div>
            
            <div>
              <h3 className="font-bold mb-4">{t('footer.product')}</h3>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><a href="#features" className="hover:text-foreground transition-colors">{t('nav.features')}</a></li>
                <li><a href="#how-it-works" className="hover:text-foreground transition-colors">{t('nav.howItWorks')}</a></li>
                <li><a href="#installation" className="hover:text-foreground transition-colors">{t('nav.installation')}</a></li>
              </ul>
            </div>

            <div>
              <h3 className="font-bold mb-4">{t('footer.community')}</h3>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><a href="https://github.com/tiann/hapi" target="_blank" rel="noreferrer" className="hover:text-foreground transition-colors">GitHub</a></li>
                <li><a href="https://github.com/tiann/hapi/issues" target="_blank" rel="noreferrer" className="hover:text-foreground transition-colors">Issues</a></li>
                <li><a href="https://twitter.com/tiann" target="_blank" rel="noreferrer" className="hover:text-foreground transition-colors">Twitter</a></li>
              </ul>
            </div>
          </div>
          
          <div className="mt-12 pt-8 border-t-2 border-border flex flex-col md:flex-row justify-between items-center gap-4 text-sm text-muted-foreground">
            <p>{t('footer.copyright', { year: new Date().getFullYear() })}</p>
            <p dangerouslySetInnerHTML={{ __html: t('footer.designedWith') }} />
          </div>
        </div>
      </footer>
    </div>
  );
}
