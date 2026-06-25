import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface AvatarProps {
  /** GitHub login — its avatar is loaded from github.com/<login>.png. */
  login?: string | null;
  /** Fallback shown until/unless the photo loads (usually an initial). */
  fallback: string;
  /** Shape + size + fallback colors, e.g. "size-8 rounded-md bg-clay …". */
  className?: string;
}

/** A profile picture: the GitHub avatar when available, else the fallback glyph. */
export function Avatar({ login, fallback, className }: AvatarProps) {
  const [failed, setFailed] = useState(false);

  // Reset the error state if the login changes (e.g. after sign-in).
  useEffect(() => setFailed(false), [login]);

  const showPhoto = !!login && !failed;
  return (
    <span className={cn("relative grid shrink-0 place-items-center overflow-hidden", className)}>
      {showPhoto ? (
        <img
          src={`https://github.com/${login}.png?size=80`}
          alt={login ?? ""}
          className="absolute inset-0 size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        fallback
      )}
    </span>
  );
}
