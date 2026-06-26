import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/* A docked, non-modal side panel. Unlike a modal sheet it renders inline in the
   layout flow, as a single column right of the rail that reduces the main area.
   Same color as the rail, so the whole left zone stays coherent. The API mirrors
   the old shadcn sheet (open / onOpenChange / Header / Title / Description).

   It keeps itself mounted through a closing animation: when `open` flips false it
   plays the exit animation, then unmounts on animationend — so open AND close are
   both smooth. */

const SheetCtx = React.createContext<{
  state: "open" | "closed";
  onOpenChange: (open: boolean) => void;
  onExited: () => void;
}>({ state: "closed", onOpenChange: () => {}, onExited: () => {} });

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
  const [state, setState] = React.useState<"open" | "closed">(open ? "open" : "closed");

  React.useEffect(() => {
    if (open) {
      setMounted(true);
      setState("open");
    } else {
      setState("closed");
    }
  }, [open]);

  const ctx = React.useMemo(
    () => ({
      state,
      onOpenChange: onOpenChange ?? (() => {}),
      onExited: () => setMounted(false),
    }),
    [state, onOpenChange],
  );

  if (!mounted) return null;
  return <SheetCtx.Provider value={ctx}>{children}</SheetCtx.Provider>;
}

function SheetContent({
  className,
  children,
  // `side` is accepted for API compatibility but docked panels are always left.
  side: _side,
  ...props
}: React.ComponentProps<"aside"> & { side?: "top" | "bottom" | "left" | "right" }) {
  const { state, onOpenChange, onExited } = React.useContext(SheetCtx);
  // Outer slot animates its WIDTH (so the layout space itself opens/closes and
  // main slides smoothly); the inner panel keeps a fixed width and is clipped by
  // the slot, so its content never reflows mid-animation. Unmount when the slot's
  // close animation ends.
  return (
    <div
      className="panel-slot"
      data-state={state}
      onAnimationEnd={(e) => {
        if (state === "closed" && e.target === e.currentTarget) onExited();
      }}
    >
      <aside
        data-slot="sheet-content"
        className={cn(
          "relative flex h-full w-[440px] flex-col overflow-y-auto bg-rail p-6",
          className,
        )}
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
    </div>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-header" className={cn("flex flex-col gap-1", className)} {...props} />;
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
