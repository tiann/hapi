import { ArrowRight, Coffee, Footprints, Mountain, Plus } from "lucide-react";
import { useLocale } from "../locale";
import { AGENTS, DOCS, GITHUB_URL, RELEASES_URL } from "../const";
import { AgentIcon } from "./AgentIcon";
import { StoreBadges } from "./StoreBadges";
import { HERO_IMAGE } from "../seo";
import { useLatestVersion } from "../hooks/useLatestVersion";
import { Command, GitHubIcon, ICONS, Rich, SectionHeading } from "./ui";

export function Home() {
    return (
        <>
            <Hero />
            <Agents />
            <HowItWorks />
            <Life />
            <Features />
            <Security />
            <Apps />
            <Install />
            <Faq />
            <FinalCta />
        </>
    );
}

function ReleasePill() {
    const { t } = useLocale();
    const version = useLatestVersion();
    return (
        <a className="release-pill" href={RELEASES_URL}>
            <span className="release-dot" aria-hidden />
            <span>{version ? t.hero.releaseAvailable.replace("{version}", version) : t.hero.releasePlaceholder}</span>
            <ArrowRight aria-hidden size={14} />
        </a>
    );
}

function Hero() {
    const { t } = useLocale();
    return (
        <section className="hero" aria-labelledby="hero-title">
            <div className="hero-bg" aria-hidden>
                <span className="orb orb-1" />
                <span className="orb orb-2" />
                <span className="orb orb-3" />
            </div>
            <div className="wrap relative grid items-center gap-14 pt-12 pb-16 md:pt-16 lg:grid-cols-[1.1fr_1fr] lg:gap-12 lg:pt-20 lg:pb-24">
                <div>
                    <ReleasePill />
                    <h1 id="hero-title" className="hero-title">
                        <span className="block">{t.hero.titleA}</span>
                        <span className="block text-accent">{t.hero.titleB}</span>
                    </h1>
                    <p className="hero-lead">{t.hero.lead}</p>
                    <StoreBadges className="mt-8" size="lg" />
                    <div className="mt-8 max-w-md">
                        <p className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{t.hero.tryLabel}</p>
                        <Command cmd="npx @twsxtd/hapi hub --relay" copy={t.install.copy} copied={t.install.copied} />
                        <p className="mt-3 text-sm text-muted">
                            {t.hero.eyebrow}
                        </p>
                    </div>
                </div>
                <HandoffDemo />
            </div>
        </section>
    );
}

function HandoffDemo() {
    const { t } = useLocale();
    return (
        <figure className="demo" aria-label={t.hero.demoLabel}>
            <div className="terminal" aria-hidden>
                <div className="terminal-bar">
                    <span className="dot bg-[#ff5f57]" />
                    <span className="dot bg-[#febc2e]" />
                    <span className="dot bg-[#28c840]" />
                    <span className="terminal-title">{t.hero.terminalTitle}</span>
                </div>
                <div className="terminal-body">
                    <p>
                        <span className="text-[#7ee2a8]">~/focusflow</span> <span className="text-white/50">$</span> hapi codex
                    </p>
                    <p className="mt-3 text-white">› {t.hero.terminalLines[0]}</p>
                    <p className="text-white/60">
                        <span className="text-[#7ee2a8]">✓</span> {t.hero.terminalLines[1]}
                    </p>
                    <p className="text-white/60">
                        <span className="text-[#7ee2a8]">✓</span> {t.hero.terminalLines[2]}
                    </p>
                    <p className="mt-3 flex items-center gap-1 text-white/80">
                        › <span className="caret" />
                    </p>
                </div>
                <div className="terminal-status">
                    <span className="status-local">● {t.hero.terminalLocal}</span>
                    <span className="status-remote">● {t.hero.terminalRemote}</span>
                </div>
            </div>
            <div className="handoff-link" aria-hidden>
                <span className="handoff-track">
                    <span className="handoff-packet" />
                </span>
                <span className="handoff-chip">
                    <b>&lt;</b> {t.hero.handoff} <b>&gt;</b>
                </span>
            </div>
            <div className="phone">
                <img
                    src={HERO_IMAGE}
                    width={600}
                    height={1298}
                    alt={t.hero.phoneAlt}
                    fetchPriority="high"
                    decoding="async"
                />
            </div>
        </figure>
    );
}

function Agents() {
    const { t } = useLocale();
    return (
        <section className="agents-band" aria-labelledby="agents-title">
            <div className="wrap grid gap-8 py-14 lg:grid-cols-[minmax(0,19rem)_1fr_1.15fr] lg:items-center lg:gap-10">
                <img
                    className="agents-mascots"
                    src="/images/mascots.webp"
                    width={880}
                    height={473}
                    alt={t.cta.mascotsAlt}
                    loading="lazy"
                    decoding="async"
                />
                <div>
                    <h2 id="agents-title" className="text-xl font-semibold tracking-tight md:text-2xl">
                        {t.agents.title}
                    </h2>
                    <p className="mt-3 text-[15px] leading-relaxed text-muted">
                        <Rich text={t.agents.body} />
                    </p>
                    <a className="text-link mt-3 inline-flex" href={DOCS.agents}>
                        {t.agents.link} <ArrowRight aria-hidden size={14} />
                    </a>
                </div>
                <ul className="flex flex-wrap gap-2">
                    {AGENTS.map((agent) => (
                        <li key={agent.flavor} className="agent-chip">
                            <AgentIcon flavor={agent.flavor} />
                            {agent.name}
                        </li>
                    ))}
                </ul>
            </div>
        </section>
    );
}

function HowItWorks() {
    const { t } = useLocale();
    const d = t.how.diagram;
    return (
        <section id="how-it-works" className="section" aria-labelledby="how-title">
            <div className="wrap">
                <SectionHeading id="how-title" kicker={t.how.kicker} title={t.how.title}>
                    <Rich text={t.how.body} />
                </SectionHeading>

                <div className="flow" aria-hidden>
                    <div className="flow-node">
                        <strong>{d.machine}</strong>
                        <span>{d.machineSub}</span>
                    </div>
                    <div className="flow-wire">
                        <span className="flow-packet" />
                    </div>
                    <div className="flow-node flow-node-hub">
                        <strong>{d.hub}</strong>
                        <span>{d.hubSub}</span>
                    </div>
                    <div className="flow-wire">
                        <span className="flow-packet flow-packet-back" />
                    </div>
                    <div className="flow-node">
                        <strong>{d.clients}</strong>
                        <span>{d.clientsSub}</span>
                    </div>
                </div>

                <ol className="mt-10 grid gap-4 md:grid-cols-3">
                    {t.how.steps.map((step, i) => (
                        <li key={step.title} className="card p-6">
                            <span className="step-num">{String(i + 1).padStart(2, "0")}</span>
                            <h3 className="mt-4 text-lg font-semibold tracking-tight">{step.title}</h3>
                            <p className="mt-2 text-[15px] leading-relaxed text-muted">
                                <Rich text={step.body} />
                            </p>
                        </li>
                    ))}
                </ol>
                <p className="mt-6 text-sm text-muted">{t.how.codex}</p>
            </div>
        </section>
    );
}

const LIFE_ICONS = [Mountain, Coffee, Footprints];

function Life() {
    const { t } = useLocale();
    return (
        <section className="section life" aria-labelledby="life-title">
            <div className="wrap">
                <div className="mx-auto max-w-2xl text-center">
                    <p className="kicker">{t.life.kicker}</p>
                    <h2 id="life-title" className="section-title">
                        {t.life.title}
                    </h2>
                    <p className="section-lead">{t.life.lead}</p>
                </div>
                <ul className="mt-12 grid gap-5 md:grid-cols-3">
                    {t.life.cards.map((card, i) => {
                        const Icon = LIFE_ICONS[i];
                        return (
                            <li key={card.title} className={`life-card life-card-${i}`}>
                                <span className="life-icon" aria-hidden>
                                    <Icon size={24} />
                                </span>
                                <h3 className="mt-5 text-lg font-bold tracking-tight">{card.title}</h3>
                                <p className="mt-2 text-[15px] leading-relaxed text-muted">{card.body}</p>
                            </li>
                        );
                    })}
                </ul>
            </div>
        </section>
    );
}

function Features() {
    const { t } = useLocale();
    return (
        <section id="features" className="section bg-subtle" aria-labelledby="features-title">
            <div className="wrap">
                <SectionHeading id="features-title" kicker={t.features.kicker} title={t.features.title} />
                <div className="mt-12 grid gap-5 lg:grid-cols-3">
                    {t.features.groups.map((group) => (
                        <section key={group.id} className="card p-6 md:p-7" aria-labelledby={`group-${group.id}`}>
                            <h3 id={`group-${group.id}`} className="group-title">
                                {group.title}
                            </h3>
                            <ul className="mt-5 space-y-5">
                                {group.items.map((item) => {
                                    const Icon = ICONS[item.icon];
                                    return (
                                        <li key={item.title} className="flex gap-3.5">
                                            <span className="feature-icon">
                                                <Icon aria-hidden size={18} />
                                            </span>
                                            <div>
                                                <h4 className="font-semibold">{item.title}</h4>
                                                <p className="mt-1 text-sm leading-relaxed text-muted">
                                                    <Rich text={item.body} />
                                                </p>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    ))}
                </div>
            </div>
        </section>
    );
}

function Security() {
    const { t } = useLocale();
    return (
        <section id="security" className="section security" aria-labelledby="security-title">
            <div className="wrap grid gap-12 lg:grid-cols-[1fr_1.25fr]">
                <div>
                    <SectionHeading id="security-title" kicker={t.security.kicker} title={t.security.title}>
                        <Rich text={t.security.body} />
                    </SectionHeading>
                    <p className="mt-6 text-sm leading-relaxed opacity-70">
                        {t.security.note}{" "}
                        <a className="underline underline-offset-4" href={DOCS.privacy}>
                            {t.security.privacyLink}
                        </a>
                    </p>
                </div>
                <ul className="grid gap-4 sm:grid-cols-2">
                    {t.security.points.map((point) => {
                        const Icon = ICONS[point.icon];
                        return (
                            <li key={point.title} className="security-card">
                                <Icon aria-hidden size={20} className="text-[#ff8a94]" />
                                <h3 className="mt-4 font-semibold">{point.title}</h3>
                                <p className="mt-2 text-sm leading-relaxed opacity-75">
                                    <Rich text={point.body} />
                                </p>
                            </li>
                        );
                    })}
                </ul>
            </div>
        </section>
    );
}

function Shot({
    src,
    width,
    height,
    alt,
    caption,
    className = "",
}: {
    src: string;
    width: number;
    height: number;
    alt: string;
    caption: string;
    className?: string;
}) {
    return (
        <figure className={`shot ${className}`}>
            <div className="shot-frame">
                <img src={src} width={width} height={height} alt={alt} loading="lazy" decoding="async" />
            </div>
            <figcaption>{caption}</figcaption>
        </figure>
    );
}

function Apps() {
    const { t } = useLocale();
    const s = t.apps.shots;
    return (
        <section id="apps" className="section" aria-labelledby="apps-title">
            <div className="wrap">
                <SectionHeading id="apps-title" kicker={t.apps.kicker} title={t.apps.title}>
                    {t.apps.body}
                </SectionHeading>

                <div className="phones mt-12">
                    <Shot src="/images/iphone-tools.webp" width={480} height={1039} alt={s.tools.alt} caption={s.tools.caption} className="shot-phone" />
                    <Shot src="/images/iphone-diff.webp" width={480} height={1039} alt={s.diff.alt} caption={s.diff.caption} className="shot-phone" />
                    <Shot src="/images/iphone-changes.webp" width={480} height={1039} alt={s.changes.alt} caption={s.changes.caption} className="shot-phone" />
                </div>
                <div className="gallery-wide mt-8 grid items-end gap-6 md:grid-cols-[1.55fr_1fr]">
                    <Shot src="/images/foldable-chat.webp" width={1200} height={844} alt={s.foldable.alt} caption={s.foldable.caption} className="shot-wide" />
                    <Shot src="/images/ipad-chat.webp" width={900} height={1200} alt={s.ipad.alt} caption={s.ipad.caption} className="shot-tablet" />
                </div>

                <ul className="mt-12 grid gap-4 md:grid-cols-3">
                    {t.apps.plans.map((plan) => (
                        <li key={plan.name} className="card p-6">
                            <h3 className="font-semibold">{plan.name}</h3>
                            <p className="mt-2 text-sm leading-relaxed text-muted">{plan.body}</p>
                        </li>
                    ))}
                </ul>
                <StoreBadges className="mt-6" />
            </div>
        </section>
    );
}

function Install() {
    const { t } = useLocale();
    const i = t.install;
    return (
        <section id="install" className="section bg-subtle" aria-labelledby="install-title">
            <div className="wrap grid gap-12 lg:grid-cols-[1.35fr_1fr]">
                <div>
                    <SectionHeading id="install-title" kicker={i.kicker} title={i.title}>
                        <Rich text={i.body} />
                    </SectionHeading>
                    <ol className="install-steps mt-8">
                        {i.steps.map((step, n) => (
                            <li key={step.cmd}>
                                <span className="step-num">{n + 1}</span>
                                <div className="min-w-0 flex-1">
                                    <h3 className="font-semibold">{step.title}</h3>
                                    <div className="mt-3">
                                        <Command cmd={step.cmd} copy={i.copy} copied={i.copied} />
                                    </div>
                                </div>
                            </li>
                        ))}
                        <li>
                            <span className="step-num">3</span>
                            <div className="min-w-0 flex-1">
                                <h3 className="font-semibold">{i.step3Title}</h3>
                                <p className="mt-2 text-[15px] leading-relaxed text-muted">{i.step3Body}</p>
                            </div>
                        </li>
                    </ol>
                </div>
                <aside className="card self-start p-6 md:p-7" aria-labelledby="global-title">
                    <h3 id="global-title" className="font-semibold">
                        {i.globalTitle}
                    </h3>
                    <div className="mt-4 space-y-2.5">
                        {i.globalCmds.map((cmd) => (
                            <Command key={cmd} cmd={cmd} copy={i.copy} copied={i.copied} />
                        ))}
                    </div>
                    <p className="mt-4 text-sm leading-relaxed text-muted">
                        <Rich text={i.globalBody} />
                    </p>
                    <a className="text-link mt-5 inline-flex" href={DOCS.quickStart}>
                        {i.guide} <ArrowRight aria-hidden size={14} />
                    </a>
                </aside>
            </div>
        </section>
    );
}

function Faq() {
    const { t } = useLocale();
    return (
        <section id="faq" className="section" aria-labelledby="faq-title">
            <div className="wrap grid gap-10 lg:grid-cols-[1fr_1.6fr]">
                <div>
                    <SectionHeading id="faq-title" kicker={t.faq.kicker} title={t.faq.title} />
                    <a className="text-link mt-5 inline-flex" href={DOCS.faq}>
                        {t.faq.more} <ArrowRight aria-hidden size={14} />
                    </a>
                </div>
                <div className="faq-list">
                    {t.faq.items.map((item, idx) => (
                        <details key={item.q} className="faq-item" open={idx === 0}>
                            <summary>
                                <h3>{item.q}</h3>
                                <Plus aria-hidden size={18} className="faq-icon" />
                            </summary>
                            <p>
                                <Rich text={item.a} />
                            </p>
                        </details>
                    ))}
                </div>
            </div>
        </section>
    );
}

function FinalCta() {
    const { t } = useLocale();
    return (
        <section className="pb-20 md:pb-28" aria-labelledby="cta-title">
            <div className="wrap">
                <div className="cta">
                    <img
                        className="cta-mascots"
                        src="/images/mascots.webp"
                        width={880}
                        height={473}
                        alt={t.cta.mascotsAlt}
                        loading="lazy"
                        decoding="async"
                    />
                    <h2 id="cta-title" className="section-title">
                        {t.cta.title}
                    </h2>
                    <p className="section-lead mx-auto max-w-xl">{t.cta.body}</p>
                    <div className="mt-8 flex flex-wrap justify-center gap-3">
                        <a className="btn btn-primary" href="#install">
                            {t.cta.primary}
                            <ArrowRight aria-hidden size={18} />
                        </a>
                        <a className="btn btn-secondary" href={GITHUB_URL}>
                            <GitHubIcon />
                            {t.cta.secondary}
                        </a>
                    </div>
                </div>
            </div>
        </section>
    );
}
