import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/* A docked, non-modal side panel: a single column right of the rail that reduces
   main. It slides open/closed by transitioning the slot's WIDTH (so main moves
   smoothly and no empty column flashes), keeps the inner panel a fixed width so
   its content never reflows mid-animation, and is user-resizable from the right
   edge (persisted). Every panel opens at the same width. */

const WIDTH_KEY = "hemiunu.panel.width";
const MIN_W = 360;
const MAX_W = 760;
const DEFAULT_W = 440;

function readWidth(): number {
  const v = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(v) && v >= MIN_W && v <= MAX_W ? v : DEFAULT_W;
}

const SheetCtx = React.createContext<{
  shown: boolean;
  onOpenChange: (open: boolean) => void;
  onExited: () => void;
}>({ shown: false, onOpenChange: () => {}, onExited: () => {} });

function Sheet({
  open,
  onOpenChange,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = React.useState(!!open);
  const [shown, setShown] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setMounted(true);
      // Mount at width 0, then expand on the next frame so the open transitions.
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
  }, [open]);

  const ctx = React.useMemo(
    () => ({ shown, onOpenChange: onOpenChange ?? (() => {}), onExited: () => setMounted(false) }),
    [shown, onOpenChange],
  );

  if (!mounted) return null;
  return <SheetCtx.Provider value={ctx}>{children}</SheetCtx.Provider>;
}

function SheetContent({
  className,
  children,
  side: _side,
  ...props
}: React.ComponentProps<"aside"> & { side?: "top" | "bottom" | "left" | "right" }) {
  const { shown, onOpenChange, onExited } = React.useContext(SheetCtx);
  const [w, setW] = React.useState(readWidth);
  const [dragging, setDragging] = React.useState(false);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    const startX = e.clientX;
    const startW = w;
    const move = (ev: PointerEvent) => {
      setW(Math.min(MAX_W, Math.max(MIN_W, startW + (ev.clientX - startX))));
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setW((cur) => {
        localStorage.setItem(WIDTH_KEY, String(cur));
        return cur;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      className="panel-slot"
      style={{
        width: shown ? w : 0,
        transition: dragging ? "none" : "width 0.4s cubic-bezier(0.22, 1, 0.36, 1)",
      }}
      onTransitionEnd={(e) => {
        if (!shown && e.propertyName === "width" && e.target === e.currentTarget) onExited();
      }}
    >
      <aside
        data-slot="sheet-content"
        style={{ width: w }}
        className={cn("relative flex h-full flex-col overflow-y-auto bg-rail p-6", className)}
        {...props}
      >
        <button
          type="button"
          aria-label="Close"
          onClick={() => onOpenChange(false)}
          className="absolute right-4 top-4 text-ink-3 opacity-70 outline-none transition-opacity hover:opacity-100 focus:outline-none focus-visible:outline-none"
        >
          <X className="size-4" />
        </button>
        {children}
      </aside>
      {/* Drag the right edge to widen / narrow the panel. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        onPointerDown={startResize}
        className="panel-resize"
      />
    </div>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="sheet-header" className={cn("flex flex-col gap-1", className)} {...props} />
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      data-slot="sheet-title"
      className={cn("font-serif text-2xl leading-tight text-ink", className)}
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription };
