import Layout from "@/components/Layout";
import AppShowcase from "@/components/AppShowcase";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowRight, Check, Code2, Copy, Globe, Laptop, Lock, MessageSquare, Smartphone, Terminal, Zap, GitBranch, ShieldAlert, Coffee, Mountain, Footprints } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { motion, useScroll, useTransform } from "framer-motion";
import { useTranslation } from "react-i18next";
import { SEO } from "@/components/SEO";
import { useLatestVersion } from "@/hooks/useLatestVersion";

export default function Home() {
  const [copied, setCopied] = useState("");
  const { scrollY } = useScroll();
  const { t } = useTranslation();
  const version = useLatestVersion();

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(""), 2000);
  };

  return (
    <Layout>
      <SEO />
       {/* Hero Section */}
      <section className="relative pt-20 pb-20 md:pb-32 overflow-hidden">
        <div className="container relative z-10">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <div className="space-y-8">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-secondary/50 border-2 border-border text-sm font-bold text-secondary-foreground shadow-hard-sm">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
                </span>
                {t('hero.version', { version })}
              </div>

              <h1 className="text-5xl md:text-7xl lg:text-8xl font-extrabold tracking-tight leading-[1.1] mb-6" dangerouslySetInnerHTML={{ __html: t('hero.title') }} />
              
              <p className="text-xl text-muted-foreground max-w-lg leading-relaxed">
                {t('hero.subtitle')}
              </p>
              
              <div className="flex flex-col sm:flex-row gap-4 pt-4">
                <Button size="lg" className="text-lg px-8 py-6 rounded-xl shadow-hard hover:translate-y-1 hover:shadow-none transition-all border-2 border-border bg-primary text-primary-foreground hover:bg-primary/90" asChild>
                  <a href="/docs/">
                    {t('hero.startBtn')} <ArrowRight className="ml-2 h-5 w-5" />
                  </a>
                </Button>
                <Button variant="outline" size="lg" className="text-lg px-8 py-6 rounded-xl shadow-hard hover:translate-y-1 hover:shadow-none transition-all border-2 border-border bg-background" onClick={() => window.open('https://github.com/tiann/hapi', '_blank')}>
                  {t('hero.githubBtn')}
                </Button>
              </div>
            </div>

            {/* Right Content - Illustration with Parallax */}
            <div className="relative hidden lg:block perspective-1000">
              <motion.div 
                className="relative z-10"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8 }}
                style={{ y: useTransform(scrollY, [0, 500], [0, 50]) }}
              >
                <div className="absolute -inset-1 bg-gradient-to-r from-primary to-secondary rounded-[2.5rem] blur opacity-30 animate-pulse"></div>
                <img 
                  src="/images/hero-illustration.webp" 
                  alt="Vibe Coding Illustration" 
                  className="relative rounded-[2rem] border-4 border-border shadow-hard-lg bg-card transform transition-transform hover:scale-[1.02] duration-500"
                />
                
                {/* Floating Elements with Parallax */}
                <motion.div 
                  className="absolute -top-12 -right-12 w-24 h-24 bg-yellow-400 rounded-full border-4 border-border shadow-hard flex items-center justify-center z-20"
                  style={{ y: useTransform(scrollY, [0, 500], [0, -80]) }}
                >
                  <span className="text-4xl">☀️</span>
                </motion.div>
                
                <motion.div 
                  className="absolute -bottom-8 -left-8 bg-white dark:bg-slate-800 p-4 rounded-xl border-4 border-border shadow-hard flex items-center gap-3 z-20"
                  style={{ y: useTransform(scrollY, [0, 500], [0, -40]) }}
                >
                  <div className="bg-blue-100 p-2 rounded-lg">
                    <MessageSquare className="h-6 w-6 text-blue-600" />
                  </div>
                  <div>
                    <p className="font-bold text-sm">{t('hero.notification.title')}</p>
                    <p className="text-xs text-muted-foreground" dangerouslySetInnerHTML={{ __html: t('hero.notification.content') }} />
                  </div>
                </motion.div>
                
                <motion.div 
                  className="absolute top-1/2 -right-16 bg-green-500 text-white px-6 py-3 rounded-full border-4 border-border shadow-hard transform rotate-12 hover:rotate-0 transition-transform cursor-default z-20"
                  style={{ y: useTransform(scrollY, [0, 500], [0, 30]) }}
                >
                  <span className="font-bold font-mono">git push --force</span>
                </motion.div>
              </motion.div>
            </div>
          </div>
        </div>
        
        {/* Background decorative elements */}
        <div className="absolute top-20 right-0 -z-10 opacity-20">
          <svg width="400" height="400" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
            <path fill="#FF0066" d="M44.7,-76.4C58.9,-69.2,71.8,-59.1,81.6,-46.6C91.4,-34.1,98.1,-19.2,95.8,-5.3C93.5,8.6,82.2,21.5,71.6,32.8C61,44.1,51.1,53.8,39.9,62.4C28.7,71,16.2,78.5,2.3,74.5C-11.6,70.5,-26.9,55,-40.4,42.4C-53.9,29.8,-65.6,20.1,-71.6,6.8C-77.6,-6.5,-77.9,-23.4,-70.3,-37.8C-62.7,-52.2,-47.2,-64.1,-31.8,-70.5C-16.4,-76.9,-1.1,-77.8,13.8,-77.1L28.7,-76.4Z" transform="translate(100 100)" />
          </svg>
        </div>
      </section>

      {/* App Showcase Section */}
      <AppShowcase />

      {/* Lifestyle / Philosophy Section */}
      <section className="py-20 bg-secondary/20 border-y-2 border-border">
        <div className="container">
          <div className="text-center max-w-3xl mx-auto mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-6">{t('lifestyle.title')}</h2>
            <p className="text-lg text-muted-foreground mb-6">
              {t('lifestyle.subtitle')}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <Card className="border-2 border-border shadow-hard hover-lift bg-card">
              <CardHeader>
                <div className="w-12 h-12 rounded-xl bg-green-100 dark:bg-green-900/30 flex items-center justify-center mb-4 text-green-600 dark:text-green-400">
                  <Mountain className="h-6 w-6" />
                </div>
                <CardTitle>{t('lifestyle.cards.explore.title')}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground">
                  {t('lifestyle.cards.explore.desc')}
                </p>
              </CardContent>
            </Card>

            <Card className="border-2 border-border shadow-hard hover-lift bg-card">
              <CardHeader>
                <div className="w-12 h-12 rounded-xl bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center mb-4 text-orange-600 dark:text-orange-400">
                  <Coffee className="h-6 w-6" />
                </div>
                <CardTitle>{t('lifestyle.cards.sip.title')}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground">
                  {t('lifestyle.cards.sip.desc')}
                </p>
              </CardContent>
            </Card>

            <Card className="border-2 border-border shadow-hard hover-lift bg-card">
              <CardHeader>
                <div className="w-12 h-12 rounded-xl bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center mb-4 text-blue-600 dark:text-blue-400">
                  <Footprints className="h-6 w-6" />
                </div>
                <CardTitle>{t('lifestyle.cards.walk.title')}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground">
                  {t('lifestyle.cards.walk.desc')}
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="py-20">
        <div className="container">
          <div className="flex flex-col lg:flex-row gap-16 items-center">
            <div className="lg:w-1/2">
              <div className="relative rounded-[1.5rem] overflow-hidden border-2 border-border shadow-hard-lg bg-white">
                <img 
                  src="/images/multi-agent.webp" 
                  alt="Multi-Agent Support" 
                  className="w-full h-auto object-cover"
                />
              </div>
            </div>
            
            <div className="lg:w-1/2 space-y-8">
              <h2 className="text-3xl md:text-4xl font-bold">{t('features.title')}</h2>
              
              <div className="space-y-6">
                <div className="flex gap-4">
                  <div className="h-10 w-10 shrink-0 rounded-lg bg-primary/10 border-2 border-border flex items-center justify-center text-primary font-bold">
                    <MessageSquare className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold mb-2">{t('features.telegram.title')}</h3>
                    <p className="text-muted-foreground">{t('features.telegram.desc')}</p>
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="h-10 w-10 shrink-0 rounded-lg bg-red-100 border-2 border-border flex items-center justify-center text-red-600 font-bold">
                    <ShieldAlert className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold mb-2">{t('features.yolo.title')}</h3>
                    <p className="text-muted-foreground">{t('features.yolo.desc')}</p>
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="h-10 w-10 shrink-0 rounded-lg bg-secondary border-2 border-border flex items-center justify-center text-secondary-foreground font-bold">
                    <Terminal className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold mb-2">{t('features.terminal.title')}</h3>
                    <p className="text-muted-foreground">{t('features.terminal.desc')}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How it Works */}
      <section id="how-it-works" className="py-20 bg-muted/30 border-y-2 border-border">
        <div className="container">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-16">{t('howItWorks.title')}</h2>
          
          <div className="relative">
            {/* Connecting Line (Desktop) */}
            <div className="hidden md:block absolute top-1/2 left-0 w-full h-1 bg-border -translate-y-1/2 z-0"></div>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 relative z-10">
              <div className="bg-card p-6 rounded-2xl border-2 border-border shadow-hard text-center">
                <div className="w-16 h-16 mx-auto bg-primary/10 rounded-full flex items-center justify-center mb-4 border-2 border-border">
                  <Laptop className="h-8 w-8 text-primary" />
                </div>
                <h3 className="text-xl font-bold mb-2">{t('howItWorks.step1.title')}</h3>
                <p className="text-muted-foreground">{t('howItWorks.step1.desc')}</p>
              </div>
              
              <div className="bg-card p-6 rounded-2xl border-2 border-border shadow-hard text-center">
                <div className="w-16 h-16 mx-auto bg-secondary rounded-full flex items-center justify-center mb-4 border-2 border-border">
                  <Smartphone className="h-8 w-8 text-secondary-foreground" />
                </div>
                <h3 className="text-xl font-bold mb-2">{t('howItWorks.step2.title')}</h3>
                <p className="text-muted-foreground">{t('howItWorks.step2.desc')}</p>
              </div>
              
              <div className="bg-card p-6 rounded-2xl border-2 border-border shadow-hard text-center">
                <div className="w-16 h-16 mx-auto bg-green-100 rounded-full flex items-center justify-center mb-4 border-2 border-border">
                  <Zap className="h-8 w-8 text-green-600" />
                </div>
                <h3 className="text-xl font-bold mb-2">{t('howItWorks.step3.title')}</h3>
                <p className="text-muted-foreground">{t('howItWorks.step3.desc')}</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Installation */}
      <section id="installation" className="py-20">
        <div className="container max-w-4xl">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-12">{t('installation.title')}</h2>
          
          <Card className="border-2 border-border shadow-hard bg-card">
            <CardContent className="p-6 space-y-6">
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <h3 className="font-bold">{t('installation.npm.step1')}</h3>
                </div>
                <div className="bg-slate-950 text-slate-50 p-4 rounded-xl font-mono text-sm flex justify-between items-center border-2 border-slate-800">
                  <code>npx @twsxtd/hapi server --relay</code>
                  <Button variant="ghost" size="icon" className="text-slate-400 hover:text-white hover:bg-slate-800" onClick={() => copyToClipboard("npx @twsxtd/hapi server --relay", "server")}>
                    {copied === "server" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <h3 className="font-bold">{t('installation.npm.step2')}</h3>
                </div>
                <div className="bg-slate-950 text-slate-50 p-4 rounded-xl font-mono text-sm flex justify-between items-center border-2 border-slate-800">
                  <code>npx @twsxtd/hapi</code>
                  <Button variant="ghost" size="icon" className="text-slate-400 hover:text-white hover:bg-slate-800" onClick={() => copyToClipboard("npx @twsxtd/hapi", "session")}>
                    {copied === "session" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <h3 className="font-bold">{t('installation.npm.step3')}</h3>
                </div>
                <div className="bg-slate-950 text-slate-50 p-4 rounded-xl font-mono text-sm border-2 border-slate-800">
                  <code className="text-slate-400">{t('installation.npm.step3Hint')}</code>
                </div>
              </div>
            </CardContent>
          </Card>
          <p className="text-center mt-4 text-sm text-muted-foreground">{t('installation.e2ee')}</p>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 bg-slate-900 text-white dark:bg-slate-950 border-t-2 border-border">
        <div className="container text-center">
          <h2 className="text-3xl md:text-5xl font-extrabold mb-6">{t('cta.title')}</h2>
          <p className="text-xl mb-10 opacity-90 max-w-2xl mx-auto">
            {t('cta.subtitle')}
          </p>
          <div className="flex flex-col sm:flex-row justify-center gap-4">
            <Button size="lg" className="text-lg px-10 py-8 rounded-xl font-bold shadow-hard hover:translate-y-1 hover:shadow-none transition-all border-2 border-white/20 bg-primary text-primary-foreground hover:bg-primary/90" asChild>
              <a href="/docs/">
                <Globe className="mr-2 h-5 w-5" />
                {t('cta.btn')}
              </a>
            </Button>
          </div>
        </div>
      </section>
    </Layout>
  );
}
