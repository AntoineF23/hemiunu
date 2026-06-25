import { useCallback, useEffect, useState } from "react";
import { getJSON } from "./lib/api";

export interface SkillMeta {
  name: string;
  description: string;
  argumentHint?: string;
  path: string;
}

/** Fetch the user's saved skills, with a refresh hook (re-read after edits). */
export function useSkills() {
  const [skills, setSkills] = useState<SkillMeta[]>([]);

  const refresh = useCallback(async () => {
    try {
      const { skills } = await getJSON<{ skills: SkillMeta[] }>("/api/skills");
      setSkills(skills);
    } catch {
      /* worker not up yet */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { skills, refresh };
}
