// Turn raw tool ids into plain-language labels + a minimalist line icon for
// non-technical users. "Reading your files", not "mcp__filesystem__read_file".
// A UI lookup only — the engine and its tool ids are untouched.
import {
  type LucideIcon,
  FolderOpen,
  GitBranch,
  Globe,
  ClipboardList,
  Layers,
  Link2,
  ListTodo,
  Map,
  MessageSquare,
  NotebookPen,
  PencilLine,
  Search,
  Settings2,
  Share2,
  Users,
} from "lucide-react";

interface Rule {
  test: RegExp;
  label: string;
  icon: LucideIcon;
}

const RULES: Rule[] = [
  { test: /web.*search|search.*web/i, label: "Searching the web", icon: Globe },
  { test: /web.*fetch|fetch.*url|read.*url/i, label: "Reading a web page", icon: Link2 },
  {
    test: /enter.?plan.?mode|exit.?plan.?mode|plan.?mode/i,
    label: "Planning the work",
    icon: ClipboardList,
  },
  { test: /todo.?write|todo.?list/i, label: "Updating the plan", icon: ListTodo },
  {
    test: /server-filesystem|read_file|list_directory|read_text/i,
    label: "Reading your files",
    icon: FolderOpen,
  },
  { test: /save_prototype/i, label: "Building the prototype", icon: Layers },
  { test: /commit_prototype/i, label: "Saving to the repo", icon: GitBranch },
  { test: /deploy_prototype/i, label: "Publishing a shareable link", icon: Link2 },
  { test: /search_workspace/i, label: "Searching the prototype files", icon: Search },
  // A spilled-tool-result read (synthetic name from the server) — reading back a
  // large earlier result from disk, NOT prototype work. Must precede the generic
  // workspace rule so it isn't swallowed by it.
  { test: /read_saved_result/i, label: "Reading a saved result", icon: FolderOpen },
  {
    test: /iterate_prototype|write_workspace|read_workspace|list_workspace/i,
    label: "Working on the prototype",
    icon: Layers,
  },
  {
    test: /add_prototype_note|update_prototype|get_prototype/i,
    label: "Updating feature notes",
    icon: NotebookPen,
  },
  { test: /remember/i, label: "Noting that down", icon: PencilLine },
  { test: /ask_model/i, label: "Asking another model", icon: MessageSquare },
  { test: /get_source_map|save_source_map|scan/i, label: "Mapping a data source", icon: Map },
  { test: /create_team|switch_team|list_teams/i, label: "Managing teams", icon: Users },
  { test: /^parallel$/i, label: "Working in parallel", icon: Share2 },
];

/** mcp__filesystem__read_file → "filesystem · read_file" (last-resort label). */
function prettyTool(name: string): string {
  if (name.startsWith("mcp__")) {
    const rest = name.slice(5);
    const i = rest.indexOf("__");
    if (i >= 0) return `${rest.slice(0, i)} · ${rest.slice(i + 2)}`;
  }
  return name;
}

export function friendlyTool(name: string): { label: string; icon: LucideIcon } {
  for (const r of RULES) if (r.test.test(name)) return { label: r.label, icon: r.icon };
  return { label: prettyTool(name), icon: Settings2 };
}
