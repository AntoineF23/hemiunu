import {
  Boxes,
  type LucideIcon,
  MessagesSquare,
  PanelLeft,
  Plus,
  Settings,
  SquareSlash,
  Users,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type Panel = "conversations" | "teams" | "prototypes" | "skills" | "settings";

interface RailProps {
  collapsed: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  activePanel: Panel | null;
  onSelectPanel: (p: Panel) => void;
  team: string | null;
  user: string | null;
}

interface NavItem {
  key: Panel;
  label: string;
  icon: LucideIcon;
}

// Top group (no label) + a labelled "Workspace" group, mirroring the reference's
// grouped sidebar — without inventing items beyond the ones we already have.
const TOP: NavItem[] = [{ key: "conversations", label: "Conversations", icon: MessagesSquare }];
const WORKSPACE: NavItem[] = [
  { key: "teams", label: "Teams", icon: Users },
  { key: "prototypes", label: "Prototypes", icon: Boxes },
  { key: "skills", label: "Commands & skills", icon: SquareSlash },
  { key: "settings", label: "Settings", icon: Settings },
];

const STROKE = 1.5; // thin, minimalist line icons

export function Rail({
  collapsed,
  onToggle,
  onNewChat,
  activePanel,
  onSelectPanel,
  team,
  user,
}: RailProps) {
  const avatarInitial = (user ?? team?.split("/")[1] ?? "H").charAt(0).toUpperCase();

  return (
    <aside
      className={cn(
        "flex h-full flex-col bg-rail transition-[width] duration-200",
        collapsed ? "w-[60px] items-center px-2 py-3" : "w-[264px] px-3 py-3",
      )}
    >
      {/* Header: wordmark + collapse toggle */}
      <div
        className={cn(
          "mb-2 flex h-9 items-center",
          collapsed ? "justify-center" : "justify-between pl-1.5",
        )}
      >
        {!collapsed && <span className="font-serif text-xl tracking-tight text-ink">Hemiunu</span>}
        <RailButton
          icon={PanelLeft}
          label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          collapsed={collapsed}
          iconOnly
          onClick={onToggle}
        />
      </div>

      {/* New chat */}
      <RailButton icon={Plus} label="New chat" collapsed={collapsed} circled onClick={onNewChat} />

      {TOP.map((item) => (
        <RailButton
          key={item.key}
          icon={item.icon}
          label={item.label}
          collapsed={collapsed}
          active={activePanel === item.key}
          onClick={() => onSelectPanel(item.key)}
        />
      ))}

      {!collapsed && <p className="mb-1 mt-4 px-2.5 text-xs font-medium text-ink-4">Workspace</p>}
      {collapsed && <div className="my-2 h-px w-5 bg-border" />}

      {WORKSPACE.map((item) => (
        <RailButton
          key={item.key}
          icon={item.icon}
          label={item.label}
          collapsed={collapsed}
          active={activePanel === item.key}
          onClick={() => onSelectPanel(item.key)}
        />
      ))}

      <div className="flex-1" />

      {/* User / team profile row */}
      <button
        onClick={() => onSelectPanel("teams")}
        title={team ?? "Local workspace"}
        className={cn(
          "flex items-center gap-2.5 rounded-lg py-1.5 transition-colors hover:bg-white/[0.04]",
          collapsed ? "justify-center px-0" : "px-1.5",
        )}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-clay text-sm font-semibold text-primary-foreground">
          {avatarInitial}
        </span>
        {!collapsed && (
          <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
            <span className="truncate text-sm text-ink">{user ?? "You"}</span>
            <span className="truncate text-xs text-ink-4">{team ?? "Local workspace"}</span>
          </span>
        )}
      </button>
    </aside>
  );
}

interface RailButtonProps {
  icon: LucideIcon;
  label: string;
  collapsed: boolean;
  active?: boolean;
  iconOnly?: boolean;
  /** Render the icon inside a thin outlined circle (the "New chat" affordance). */
  circled?: boolean;
  onClick: () => void;
}

function RailButton({
  icon: Icon,
  label,
  collapsed,
  active,
  iconOnly,
  circled,
  onClick,
}: RailButtonProps) {
  const glyph = circled ? (
    <span className="grid size-[26px] place-items-center rounded-full border border-border">
      <Icon className="size-[15px] shrink-0" strokeWidth={STROKE} />
    </span>
  ) : (
    <Icon className="size-[19px] shrink-0" strokeWidth={STROKE} />
  );

  const btn = (
    <button
      onClick={onClick}
      aria-label={label}
      className={cn(
        "flex items-center gap-3 rounded-lg text-[15px] transition-colors",
        collapsed || iconOnly ? "size-9 justify-center" : "h-9 w-full px-2.5",
        active ? "bg-white/[0.06] text-ink" : "text-ink-2 hover:bg-white/[0.04] hover:text-ink",
      )}
    >
      {glyph}
      {!collapsed && !iconOnly && <span className="truncate">{label}</span>}
    </button>
  );

  if (!collapsed) return btn;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
