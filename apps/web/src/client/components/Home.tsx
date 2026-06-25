import type { ReactNode } from "react";
import { FileText, type LucideIcon, NotebookPen, Search, Wand2 } from "lucide-react";

interface Suggestion {
  label: string;
  icon: LucideIcon;
  /** Text dropped into the composer when the chip is clicked. */
  prompt: string;
}

const SUGGESTIONS: Suggestion[] = [
  {
    label: "Research",
    icon: Search,
    prompt: "Research this for me across our connected sources: ",
  },
  { label: "New prototype", icon: Wand2, prompt: "Let's prototype a feature: " },
  { label: "Add a decision", icon: NotebookPen, prompt: "Record this decision in the prototype: " },
  { label: "Spec for devs", icon: FileText, prompt: "Write a dev-ready spec for: " },
];

interface HomeProps {
  name: string | null;
  team: string | null;
  onPick: (prompt: string) => void;
  /** The composer, placed between the greeting and the suggestion chips. */
  children: ReactNode;
}

/** The Claude.ai-style landing: team chip · serif greeting · composer · chips. */
export function Home({ name, team, onPick, children }: HomeProps) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-6 pb-[12vh]">
      <div className="mb-7 flex justify-center">
        <span className="inline-flex items-center gap-2 rounded-lg bg-card px-3 py-1.5 text-sm text-ink-2 shadow-sm">
          <span className="size-1.5 rounded-full bg-sage" />
          {team ?? "Local workspace"}
        </span>
      </div>

      <h1 className="mb-9 text-center font-serif text-[40px] font-medium leading-tight tracking-tight text-ink">
        {name ? `Hello, ${name}` : "What are we building?"}
      </h1>

      {children}

      <div className="mt-5 flex flex-wrap justify-center gap-2.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            onClick={() => onPick(s.prompt)}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2 text-sm text-ink-2 transition-colors hover:bg-raised hover:text-ink"
          >
            <s.icon className="size-4 text-ink-3" strokeWidth={1.6} />
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
