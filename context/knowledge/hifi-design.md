# High-fidelity design craft

How to turn a validated wireframe (or a clear brief) into a **high-fidelity,
on-brand, near-production** prototype. The wireframe settled *structure and flow*;
your job now is *craft* — real components, colour, type, spacing, states, and
motion. These are judgment forces, not a rote checklist. Quality over quantity:
a few screens done to a production bar beat many rough ones.

## Design system first — it's the source of truth
- If a design-system MCP is connected, it OUTRANKS everything here. Read its
  overview/tokens/styles guidelines and set up its stack exactly as prescribed
  (usually React + TypeScript + Tailwind).
- For every UI element, fetch the matching component and **recreate every file it
  returns at its given path**, imports unchanged. Never skip files, redraw SVG
  icons, hand-roll markup, hardcode hex, or guess class names.
- Use its real tokens, typography classes, and fonts. Pull the fonts asset — without
  it brand typefaces silently fall back. Only build something new when no component
  fits, and then build from its tokens and type, not raw values.

## No design system → the default stack (Vite + React + TS + Tailwind v4)
- A real, multi-file project — not a single-file CDN page. It runs the project's own
  dev server with hot reload and deploys as a real app.
- Minimal shape: `package.json` (with a `dev` script), `vite.config.ts`
  (react + @tailwindcss/vite), `index.html` → `/src/main.tsx`, `src/App.tsx`,
  `src/index.css` (`@import "tailwindcss";` + your token layer), `src/components/*.tsx`.
- Keep components small, typed, and composable. Lift shared UI (Button, Card, Field,
  Badge) into `components/` rather than repeating markup.

## Tokens, not magic numbers
- Define a token layer once (CSS variables surfaced to Tailwind): a small **colour**
  set (background/surface, text, accent, border, plus semantic success/warn/danger),
  a **type scale** (a handful of steps, consistent line-height), a **spacing** scale
  (a single rhythm, e.g. 4px base), **radius**, and **shadow/elevation**.
- Reference tokens everywhere; don't scatter raw hex or arbitrary pixel values. One
  accent, used deliberately, reads more premium than many competing colours.

## Hierarchy & layout
- Establish hierarchy through size, weight, colour, and spacing — the eye should land
  on the primary action first. One clear primary action per view; secondaries quieter.
- Use whitespace as structure, not filler. Align to a grid; consistent gutters and
  section rhythm. Responsive by default — design the small screen, then let it expand.
- Real content from the brief (real labels, headings, sample rows) — never lorem.

## Components & states
- A component isn't done until its states are: **default, hover, focus, active,
  disabled, loading, empty, and error**. Empty and loading states are part of the
  design, not an afterthought.
- Buttons, inputs, and links must show clear focus rings and hit targets. Forms show
  inline validation and preserve input on error (forgiveness).

## Accessibility (non-negotiable craft)
- Semantic HTML (`button`, `nav`, `main`, `label`-bound inputs, heading order).
- Meet contrast (≈4.5:1 for body text); never rely on colour alone to convey meaning.
- Fully keyboard-operable; visible focus; respect `prefers-reduced-motion`.

## Motion & delight (restraint)
- Motion clarifies cause and effect — entrances, state changes, transitions — fast
  (≈150–250ms) and purposeful. No gratuitous animation; nothing that blocks input.
- Delight is the *sum* of the craft above done well, not bolted-on confetti. Pick the
  feeling the product should evoke and reinforce it consistently.

## What you return to the coordinator
One or two lines: what you built, the stack used (DS name or the Vite fallback), and
the key craft decisions (palette, type, notable components/states). The preview is
shown to the user automatically — don't describe it screen-by-screen.
