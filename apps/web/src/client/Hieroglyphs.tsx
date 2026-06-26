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

/** The rotating excavation verb, re-keyed so it fades in on each change. An
 *  elapsed-seconds counter is appended once a wait runs long, so a quiet,
 *  slow step (e.g. generating a prototype) visibly keeps progressing rather
 *  than looking frozen. */
export function StatusWord() {
  const t = useTick(3600);
  const secs = useTick(1000); // ticks ≈ seconds since this wait started
  const word = WORDS[t % WORDS.length];
  return (
    <span key={word} className="word-fade">
      {word}…{secs >= 3 ? ` ${secs}s` : ""}
    </span>
  );
}
