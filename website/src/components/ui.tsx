import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import {
    Bell,
    CalendarClock,
    Check,
    CircleCheck,
    CirclePlus,
    Code,
    Copy,
    Gauge,
    GitBranch,
    KeyRound,
    ListChecks,
    Lock,
    MessageSquarePlus,
    Mic,
    Search,
    Server,
    Smartphone,
    SquareTerminal,
    Users,
    type LucideIcon,
} from "lucide-react";

export const ICONS: Record<string, LucideIcon> = {
    smartphone: Smartphone,
    terminal: SquareTerminal,
    plus: CirclePlus,
    "calendar-clock": CalendarClock,
    mic: Mic,
    bell: Bell,
    check: CircleCheck,
    steer: MessageSquarePlus,
    gauge: Gauge,
    branch: GitBranch,
    users: Users,
    list: ListChecks,
    search: Search,
    server: Server,
    lock: Lock,
    key: KeyRound,
    code: Code,
};

/** Renders copy text, turning `backtick` spans into <code>. */
export function Rich({ text }: { text: string }) {
    const parts = text.split("`");
    return (
        <>
            {parts.map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>))}
        </>
    );
}

export function SectionHeading({
    id,
    kicker,
    title,
    children,
    center = false,
}: {
    id: string;
    kicker?: string;
    title: string;
    children?: ReactNode;
    center?: boolean;
}) {
    return (
        <div className={center ? "mx-auto max-w-3xl text-center" : "max-w-3xl"}>
            {kicker && <p className="kicker">{kicker}</p>}
            <h2 id={id} className="section-title">
                {title}
            </h2>
            {children && <div className="section-lead">{children}</div>}
        </div>
    );
}

export function CopyButton({ value, copy, copied }: { value: string; copy: string; copied: string }) {
    const [done, setDone] = useState(false);
    const timer = useRef<number | undefined>(undefined);
    useEffect(() => () => window.clearTimeout(timer.current), []);

    return (
        <button
            type="button"
            className="copy-btn"
            onClick={() => {
                navigator.clipboard?.writeText(value).then(() => {
                    setDone(true);
                    window.clearTimeout(timer.current);
                    timer.current = window.setTimeout(() => setDone(false), 1600);
                });
            }}
        >
            {done ? <Check aria-hidden size={15} /> : <Copy aria-hidden size={15} />}
            <span>{done ? copied : copy}</span>
        </button>
    );
}

export function Command({ cmd, copy, copied }: { cmd: string; copy: string; copied: string }) {
    return (
        <div className="cmd">
            <code>
                <span className="cmd-prompt" aria-hidden>
                    $
                </span>
                {cmd}
            </code>
            <CopyButton value={cmd} copy={copy} copied={copied} />
        </div>
    );
}

/** HAPI robot mark with `< >` handoff ports (assets/brand/svg/hapi-mark.svg). */
export function Mark({ className, title }: { className?: string; title?: string }) {
    return (
        <svg viewBox="30 76 452 352" className={className} role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
            {title && <title>{title}</title>}
            <g fill="currentColor">
                <rect x="72" y="240" width="24" height="12" rx="6" />
                <rect x="416" y="240" width="24" height="12" rx="6" />
                <path
                    fillRule="evenodd"
                    d="M50 227H66A12 12 0 0 1 78 239V253A12 12 0 0 1 66 265H50A12 12 0 0 1 38 253V239A12 12 0 0 1 50 227ZM62 235L47 246L62 257H69L55 246L69 235Z"
                />
                <path
                    transform="translate(512 0) scale(-1 1)"
                    fillRule="evenodd"
                    d="M50 227H66A12 12 0 0 1 78 239V253A12 12 0 0 1 66 265H50A12 12 0 0 1 38 253V239A12 12 0 0 1 50 227ZM62 235L47 246L62 257H69L55 246L69 235Z"
                />
                <path
                    fillRule="evenodd"
                    d="M160 84H352A82 82 0 0 1 434 166V338A82 82 0 0 1 352 420H160A82 82 0 0 1 78 338V166A82 82 0 0 1 160 84ZM160 116H352A50 50 0 0 1 402 166V338A50 50 0 0 1 352 388H160A50 50 0 0 1 110 338V166A50 50 0 0 1 160 116Z"
                />
                <circle cx="190" cy="226" r="27" />
                <circle cx="322" cy="226" r="27" />
                <path d="M153 306Q256 402 359 306L337 306Q256 362 175 306Z" />
                <circle cx="164" cy="306" r="11" />
                <circle cx="348" cy="306" r="11" />
            </g>
        </svg>
    );
}

export function GitHubIcon({ size = 18 }: { size?: number }) {
    return (
        <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
    );
}
