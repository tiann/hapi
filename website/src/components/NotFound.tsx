import { ArrowRight, BookOpen } from "lucide-react";
import { useLocale } from "../locale";
import { DOCS } from "../const";

export function NotFound() {
    const { t, home } = useLocale();
    return (
        <section className="hero" aria-labelledby="nf-title">
            <div className="hero-bg" aria-hidden />
            <div className="wrap relative flex flex-col items-center py-20 text-center md:py-28">
                <img src="/images/mascots.webp" width={880} height={473} alt="" className="w-72 max-w-full md:w-96" decoding="async" />
                <p className="kicker mt-8">404</p>
                <h1 id="nf-title" className="section-title">
                    {t.notFound.title}
                </h1>
                <p className="section-lead max-w-md">{t.notFound.body}</p>
                <div className="mt-8 flex flex-wrap justify-center gap-3">
                    <a className="btn btn-primary" href={home}>
                        {t.notFound.home}
                        <ArrowRight aria-hidden size={18} />
                    </a>
                    <a className="btn btn-secondary" href={DOCS.home}>
                        <BookOpen aria-hidden size={18} />
                        {t.notFound.docs}
                    </a>
                </div>
            </div>
        </section>
    );
}
