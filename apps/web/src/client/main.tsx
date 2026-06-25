import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Fonts (bundled, offline): Inter for UI, Newsreader for agent prose, JetBrains
// Mono for code. Variable weights so we can use any weight without extra files.
import "@fontsource-variable/inter";
import "@fontsource-variable/newsreader";
import "@fontsource-variable/jetbrains-mono";
// Noto Egyptian Hieroglyphs — so the glyph spinner / inscribing animation render
// on any OS (macOS ships no hieroglyph font by default).
import "@fontsource/noto-sans-egyptian-hieroglyphs";
// Syntax-highlight theme for code blocks (Atom One Dark — dark in both UI modes,
// matching the gold-standard chat UIs).
import "highlight.js/styles/atom-one-dark.css";
import { TooltipProvider } from "./components/ui/tooltip";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
// theme.css owns the design tokens + base; styles.css the chat thread + prose.
import "./theme.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ErrorBoundary>
  </StrictMode>,
);
