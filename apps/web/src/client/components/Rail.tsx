import {
  Boxes,
  Brain,
  Check,
  type LucideIcon,
  MapPin,
  MessagesSquare,
  PanelLeft,
  Plug,
  PlusCircle,
  Settings,
  SquareSlash,
  Users,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Avatar } from "./Avatar";

export type Panel =
  | "conversations"
  | "teams"
  | "prototypes"
  | "atlas"
  | "memory"
  | "skills"
  | "mcp"
  | "settings";

interface RailProps {
  collapsed: boolean;
  /** Animate width changes (smooth manual toggle); off so opening a panel
      collapses the rail instantly and the panel content doesn't slide. */
  animate: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  /** Panel(s) currently open (highlighted in the rail). One at a time today. */
  openPanels: Panel[];
  onSelectPanel: (p: Panel) => void;
  team: string | null;
  user: string | null;
  githubLogin: string | null;
  /** Connected GitHub account logins, for the profile switcher. */
  accounts: string[];
  onSwitchAccount: (login: string) => void;
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
  { key: "atlas", label: "Atlas", icon: MapPin },
  { key: "memory", label: "Memory", icon: Brain },
  { key: "skills", label: "Commands & skills", icon: SquareSlash },
  { key: "mcp", label: "MCP servers", icon: Plug },
  { key: "settings", label: "Settings", icon: Settings },
];

const STROKE = 1.5; // thin, minimalist line icons

export function Rail({
  collapsed,
  animate,
  onToggle,
  onNewChat,
  openPanels,
  onSelectPanel,
  team,
  user,
  githubLogin,
  accounts,
  onSwitchAccount,
}: RailProps) {
  const avatarInitial = (githubLogin ?? user ?? team?.split("/")[1] ?? "H").charAt(0).toUpperCase();

  return (
    <aside
      className={cn(
        "flex h-full flex-col bg-rail",
        animate && "transition-[width] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
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
      <RailButton icon={PlusCircle} label="New chat" collapsed={collapsed} onClick={onNewChat} />

      {TOP.map((item) => (
        <RailButton
          key={item.key}
          icon={item.icon}
          label={item.label}
          collapsed={collapsed}
          active={openPanels.includes(item.key)}
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
          active={openPanels.includes(item.key)}
          onClick={() => onSelectPanel(item.key)}
        />
      ))}

      <div className="flex-1" />

      {/* User / account profile row — click to switch GitHub profile */}
      <DropdownMenu>
        <DropdownMenuTrigger
          title={githubLogin ?? "Not signed in"}
          className={cn(
            "flex items-center gap-2.5 rounded-lg py-1.5 outline-none transition-colors hover:bg-white/[0.04]",
            collapsed ? "justify-center px-0" : "px-1.5",
          )}
        >
          <Avatar
            login={githubLogin}
            fallback={avatarInitial}
            className="size-8 rounded-md bg-sun text-sm font-semibold text-primary-foreground"
          />
          {!collapsed && (
            <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
              <span className="truncate text-sm text-ink">{githubLogin ?? user ?? "You"}</span>
              <span className="truncate text-xs text-ink-4">{team ?? "Local workspace"}</span>
            </span>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="min-w-56">
          <DropdownMenuLabel>GitHub account</DropdownMenuLabel>
          {accounts.length === 0 && (
            <DropdownMenuItem disabled>No account connected</DropdownMenuItem>
          )}
          {accounts.map((login) => (
            <DropdownMenuItem key={login} onSelect={() => onSwitchAccount(login)}>
              <Avatar
                login={login}
                fallback={login.charAt(0).toUpperCase()}
                className="size-5 rounded bg-raised text-[10px] font-semibold text-ink-2"
              />
              <span className="flex-1 truncate">{login}</span>
              {login === githubLogin && <Check className="size-4 text-sun" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onSelectPanel("teams")}>
            Manage accounts & teams…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </aside>
  );
}

interface RailButtonProps {
  icon: LucideIcon;
  label: string;
  collapsed: boolean;
  active?: boolean;
  iconOnly?: boolean;
  onClick: () => void;
}

function RailButton({ icon: Icon, label, collapsed, active, iconOnly, onClick }: RailButtonProps) {
  const glyph = <Icon className="rail-icon size-[19px] shrink-0" strokeWidth={STROKE} />;

  return (
    <button
      onClick={onClick}
      aria-label={label}
      data-active={active ? "true" : undefined}
      className={cn(
        "rail-btn flex items-center gap-3 rounded-lg text-[15px] transition-colors",
        collapsed || iconOnly ? "size-9 justify-center" : "h-9 w-full px-2.5",
        active ? "bg-white/[0.06] text-ink" : "text-ink-2 hover:bg-white/[0.04] hover:text-ink",
      )}
    >
      {glyph}
      {!collapsed && !iconOnly && <span className="truncate">{label}</span>}
    </button>
  );
}
