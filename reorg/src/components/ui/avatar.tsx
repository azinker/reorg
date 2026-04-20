/**
 * Avatar primitive used across the Help Desk for assignees, message authors,
 * mention pickers, and the agent profile page. Accepts the compact
 * `HelpdeskUserBadge` shape and falls back gracefully through:
 *
 *   1. The user's uploaded avatar (data URL or https URL)
 *   2. A monogram derived from name/email/handle, with a deterministic colour
 *
 * The colour is hashed from the user id so the same person is always the same
 * colour across the app — useful when scanning a long list of tickets.
 */

import { cn } from "@/lib/utils";

export interface AvatarUser {
  id: string;
  name?: string | null;
  email?: string | null;
  handle?: string | null;
  avatarUrl?: string | null;
}

interface AvatarProps {
  user: AvatarUser | null | undefined;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  ring?: boolean;
  className?: string;
  /**
   * When true, an offline/inactive look is rendered (e.g. for `null` assignee
   * ⇒ unassigned). Defaults to false.
   */
  unassigned?: boolean;
}

const SIZE: Record<NonNullable<AvatarProps["size"]>, { box: string; text: string }> = {
  xs: { box: "h-5 w-5", text: "text-[9px]" },
  sm: { box: "h-7 w-7", text: "text-[11px]" },
  md: { box: "h-9 w-9", text: "text-sm" },
  lg: { box: "h-12 w-12", text: "text-lg" },
  xl: { box: "h-20 w-20", text: "text-2xl" },
};

// Pleasant, accessible palette pulled from Tailwind's 600/700 range. Each
// background is dark enough that white text passes 4.5:1 contrast.
const PALETTE = [
  "bg-rose-700",
  "bg-orange-700",
  "bg-amber-700",
  "bg-lime-700",
  "bg-emerald-700",
  "bg-teal-700",
  "bg-cyan-700",
  "bg-sky-700",
  "bg-blue-700",
  "bg-indigo-700",
  "bg-violet-700",
  "bg-purple-700",
  "bg-fuchsia-700",
  "bg-pink-700",
];

function hashToIndex(input: string, modulo: number): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % modulo;
}

function deriveMonogram(user: AvatarUser): string {
  const source = user.name || user.handle || user.email || "?";
  const tokens = source
    .replace(/@.*/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (tokens.length >= 2) {
    return (tokens[0][0] + tokens[1][0]).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

export function Avatar({
  user,
  size = "md",
  ring = false,
  className,
  unassigned = false,
}: AvatarProps) {
  const sz = SIZE[size];
  const ringClass = ring
    ? "ring-2 ring-background outline outline-1 outline-border"
    : "";

  if (!user || unassigned) {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-border bg-muted/40 text-muted-foreground",
          sz.box,
          sz.text,
          ringClass,
          className,
        )}
        aria-label="Unassigned"
        title="Unassigned"
      >
        ?
      </span>
    );
  }

  const monogram = deriveMonogram(user);
  const colourIdx = hashToIndex(user.id, PALETTE.length);
  const bg = PALETTE[colourIdx];
  const label = user.name ?? user.email ?? "user";

  if (user.avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- data URLs and tiny
      // bitmaps; the optimizer would just shuttle them through unchanged.
      <img
        src={user.avatarUrl}
        alt={label}
        title={label}
        className={cn(
          "inline-block shrink-0 rounded-full object-cover",
          sz.box,
          ringClass,
          className,
        )}
        draggable={false}
      />
    );
  }

  return (
    <span
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium text-white",
        bg,
        sz.box,
        sz.text,
        ringClass,
        className,
      )}
      aria-label={label}
      title={label}
    >
      {monogram}
    </span>
  );
}

/** Stack of overlapping avatars; useful for additional assignees. */
export function AvatarStack({
  users,
  size = "sm",
  max = 4,
  className,
}: {
  users: (AvatarUser | null)[];
  size?: AvatarProps["size"];
  max?: number;
  className?: string;
}) {
  const visible = users.slice(0, max);
  const overflow = users.length - visible.length;
  return (
    <div className={cn("flex -space-x-1.5", className)}>
      {visible.map((u, i) => (
        <Avatar key={u?.id ?? `gap-${i}`} user={u} size={size} ring />
      ))}
      {overflow > 0 ? (
        <span
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground ring-2 ring-background",
            SIZE[size!].box,
            SIZE[size!].text,
          )}
          title={`+${overflow} more`}
        >
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}
