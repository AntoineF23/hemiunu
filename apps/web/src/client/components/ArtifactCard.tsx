import { useEffect, useRef, useState } from "react";
import { ExternalLink, RotateCw, SquarePen } from "lucide-react";

interface ArtifactCardProps {
  url: string;
  title: string;
}

// Render the prototype at a real desktop viewport, then scale it down to fit —
// so a responsive page shows its DESKTOP layout (not the mobile breakpoint it
// would hit at the panel's narrow width), framed like a computer screen.
const VIEWPORT_W = 1280;
const SCREEN_RATIO = 10 / 16; // 16:10, a laptop/monitor-like screen
const VIEWPORT_H = Math.round(VIEWPORT_W * SCREEN_RATIO); // 800

/**
 * An inline, live preview of the current wireframe / prototype — the localhost
 * preview server embedded in a scaled desktop "screen". Edits the agent makes
 * hot-reload in place; Reload re-loads, ↗ opens it full-window.
 */
export function ArtifactCard({ url, title }: ArtifactCardProps) {
  const [nonce, setNonce] = useState(0);
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);

  // Scale the 1280px-wide viewport down to the card's current width.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / VIEWPORT_W));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-lg">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <SquarePen className="size-4 text-sun" strokeWidth={1.8} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{title}</span>
        <span className="hidden truncate font-mono text-xs text-ink-4 sm:inline">{url}</span>
        <button
          onClick={() => setNonce((n) => n + 1)}
          title="Reload"
          aria-label="Reload preview"
          className="rounded p-1 text-ink-3 transition-colors hover:bg-accent hover:text-ink"
        >
          <RotateCw className="size-4" />
        </button>
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          title="Open in new tab"
          aria-label="Open in new tab"
          className="rounded p-1 text-ink-3 transition-colors hover:bg-accent hover:text-ink"
        >
          <ExternalLink className="size-4" />
        </a>
      </div>
      {/* 16:10 screen; the iframe is rendered at desktop size and scaled to fit. */}
      <div
        ref={frameRef}
        className="relative w-full overflow-hidden bg-white"
        style={{ aspectRatio: "16 / 10" }}
      >
        <iframe
          key={nonce}
          src={url}
          title={title}
          style={{
            width: VIEWPORT_W,
            height: VIEWPORT_H,
            border: 0,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        />
      </div>
    </div>
  );
}
