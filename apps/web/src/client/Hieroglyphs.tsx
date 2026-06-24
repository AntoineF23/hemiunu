// The "thinking" indicator while a turn runs: a single rotating excavation verb
// (ported from the CLI's WORDS). Deliberately the ONLY moving element during a
// turn — the cycling hieroglyph spinner and the inscribing-glyph row were
// removed to cut on-screen motion. The word fades softly when it changes.
import { useEffect, useState } from "react";

const WORDS = [
  "Excavating",
  "Deciphering",
  "Unearthing",
  "Decoding",
  "Surveying",
  "Translating",
  "Restoring",
  "Inscribing",
  "Divining",
  "Charting",
  "Unrolling",
  "Aligning",
];

function useTick(ms: number): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((v) => v + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return t;
}

/** The rotating excavation verb, re-keyed so it fades in on each change. */
export function StatusWord() {
  const t = useTick(3600);
  const word = WORDS[t % WORDS.length];
  return (
    <span key={word} className="word-fade">
      {word}…
    </span>
  );
}
