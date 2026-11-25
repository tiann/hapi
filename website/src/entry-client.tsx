import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { App } from "./App";
import type { Locale, Page } from "./content";
import "./index.css";

// Locale and page come from the prerendered markup (derived from the URL at build
// time), never from browser language detection, so hydration always matches.
const root = document.getElementById("root")!;
const locale: Locale = document.documentElement.lang.startsWith("zh") ? "zh" : "en";
const page: Page = root.dataset.page === "notFound" ? "notFound" : "home";

hydrateRoot(
    root,
    <StrictMode>
        <App locale={locale} page={page} />
    </StrictMode>,
);
