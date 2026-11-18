import AppleMono from "@lobehub/icons/es/Apple/components/Mono";
import { APP_STORE_URL, GOOGLE_PLAY_URL } from "../const";
import { useLocale } from "../locale";

function GooglePlayLogo() {
    // Simplified four-colour Play triangle.
    return (
        <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
            <path fill="#00d7fe" d="M3.6 1.8 13.5 12l-9.9 10.2c-.3-.3-.5-.8-.5-1.3V3.1c0-.5.2-1 .5-1.3z" />
            <path fill="#ffce00" d="m16.8 8.7 3.6 2.1c.9.5.9 1.9 0 2.4l-3.6 2.1L13.5 12z" />
            <path fill="#ff3a44" d="M3.6 22.2 13.5 12l3.3 3.3L5.3 21.9c-.6.4-1.3.5-1.7.3z" />
            <path fill="#00f076" d="M3.6 1.8c.4-.2 1.1-.1 1.7.3l11.5 6.6-3.3 3.3z" />
        </svg>
    );
}

export function StoreBadges({ className = "", size = "md" }: { className?: string; size?: "md" | "lg" }) {
    const { t } = useLocale();
    return (
        <div className={`store-badges store-badges-${size} ${className}`}>
            <a className="store-badge" href={APP_STORE_URL}>
                <span className="store-logo">
                    <AppleMono size="100%" />
                </span>
                <span className="store-text">
                    <small>{t.stores.appStoreSmall}</small>
                    <b>App Store</b>
                </span>
            </a>
            <a className="store-badge" href={GOOGLE_PLAY_URL}>
                <span className="store-logo">
                    <GooglePlayLogo />
                </span>
                <span className="store-text">
                    <small>{t.stores.googlePlaySmall}</small>
                    <b>Google Play</b>
                </span>
            </a>
        </div>
    );
}
