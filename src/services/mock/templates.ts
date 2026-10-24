// Demo task blueprints used by the mock backend. Every result here is fabricated
// for UI preview and prefixed accordingly — nothing touches the real system.

import type { FileChange, RiskLevel, ToolResult } from "../../types";

export interface StepBlueprint {
  tool: string;
  title: string;
  description: string;
  input?: Record<string, unknown>;
  requiresApproval?: boolean;
  risk?: RiskLevel;
  durationMs: number;
  result: ToolResult;
  files?: Omit<FileChange, "simulated">[];
}

export interface TaskBlueprint {
  kind: string;
  title: string;
  intro: string;
  outro: string;
  summary: string;
  steps: StepBlueprint[];
}

const SIM = "[Simulated output — demo mode, nothing was executed]\n";

const organize: TaskBlueprint = {
  kind: "organize",
  title: "Organize Downloads folder",
  intro:
    "I'll organize your **Downloads** folder by grouping files into folders by type. Here's the plan:\n\n1. Scan the folder and list its contents\n2. Classify files by type\n3. Create category folders *(needs your approval)*\n4. Move files into them *(needs your approval)*\n\nYou can follow each step below and inspect the tool output.",
  outro: "I'll pause before any step that changes files so you can review it first.",
  summary: "Group files in ~/Downloads into Documents, Images, Archives and Installers.",
  steps: [
    {
      tool: "fs.list_directory",
      title: "Scan Downloads",
      description: "List files and sizes in ~/Downloads",
      input: { path: "~/Downloads", recursive: false },
      durationMs: 1400,
      result: {
        format: "table",
        output:
          SIM +
          "name                         size     modified\n" +
          "invoice_0423.pdf             212 KB   2d ago\n" +
          "IMG_2041.jpg                 3.1 MB   5d ago\n" +
          "IMG_2042.jpg                 2.9 MB   5d ago\n" +
          "project-assets.zip           48 MB    1w ago\n" +
          "setup-tool-2.4.exe           96 MB    2w ago\n" +
          "notes.txt                    4 KB     3w ago\n" +
          "… 31 more files",
      },
    },
    {
      tool: "ai.classify",
      title: "Classify files",
      description: "Group files into categories by extension and content",
      input: { strategy: "extension+mime" },
      durationMs: 1600,
      result: {
        format: "json",
        output:
          SIM +
          JSON.stringify(
            { Documents: 14, Images: 11, Archives: 5, Installers: 4, Other: 3 },
            null,
            2,
          ),
      },
    },
    {
      tool: "fs.create_directory",
      title: "Create category folders",
      description: "Create 5 folders inside ~/Downloads",
      input: { paths: ["Documents", "Images", "Archives", "Installers", "Other"] },
      requiresApproval: true,
      risk: "medium",
      durationMs: 900,
      result: { format: "text", output: SIM + "Would create 5 folders." },
      files: [
        { path: "~/Downloads/Documents/", kind: "created" },
        { path: "~/Downloads/Images/", kind: "created" },
        { path: "~/Downloads/Archives/", kind: "created" },
      ],
    },
    {
      tool: "fs.move",
      title: "Move files into folders",
      description: "Move 37 files into their category folders",
      input: { count: 37, conflict: "rename" },
      requiresApproval: true,
      risk: "high",
      durationMs: 2200,
      result: { format: "text", output: SIM + "Would move 37 files. 0 conflicts detected." },
      files: [
        { path: "~/Downloads/Documents/invoice_0423.pdf", kind: "moved" },
        { path: "~/Downloads/Images/IMG_2041.jpg", kind: "moved" },
        { path: "~/Downloads/Archives/project-assets.zip", kind: "moved" },
      ],
    },
  ],
};

const research: TaskBlueprint = {
  kind: "research",
  title: "Research topic and create report",
  intro:
    "I'll research the topic and compile a short report:\n\n1. Search the web for recent sources\n2. Read the most relevant pages\n3. Draft a structured summary\n4. Save it as a Markdown file *(needs your approval)*",
  outro: "Sources and the draft will appear in the task details as they come in.",
  summary: "Collect sources, summarize findings, and save a Markdown report.",
  steps: [
    {
      tool: "web.search",
      title: "Search the web",
      description: "Query search engine for recent sources",
      input: { query: "topic overview 2026", limit: 8 },
      durationMs: 1500,
      result: {
        format: "table",
        output:
          SIM +
          "#  title                                   domain\n" +
          "1  An overview of the topic                example.org\n" +
          "2  Recent developments explained           example.com\n" +
          "3  Key statistics and trends               example.net",
      },
    },
    {
      tool: "browser.read_page",
      title: "Read top sources",
      description: "Extract main content from 3 pages",
      input: { urls: 3 },
      durationMs: 2000,
      result: { format: "text", output: SIM + "Extracted ~4,200 words from 3 pages." },
    },
    {
      tool: "ai.summarize",
      title: "Draft report",
      description: "Summarize findings into sections",
      durationMs: 1800,
      result: {
        format: "text",
        output: SIM + "# Report\n## Overview\n…\n## Key findings\n- …\n## Sources\n1. example.org",
      },
    },
    {
      tool: "fs.write_file",
      title: "Save report",
      description: "Write report.md to ~/Documents/Reports",
      input: { path: "~/Documents/Reports/report.md" },
      requiresApproval: true,
      risk: "medium",
      durationMs: 700,
      result: { format: "text", output: SIM + "Would write 6.2 KB to report.md" },
      files: [{ path: "~/Documents/Reports/report.md", kind: "created" }],
    },
  ],
};

const spreadsheet: TaskBlueprint = {
  kind: "spreadsheet",
  title: "Analyze spreadsheet",
  intro:
    "I'll analyze the spreadsheet:\n\n1. Read the file and detect columns\n2. Compute summary statistics\n3. Look for trends and outliers\n\nThis is read-only, so no approval is needed.",
  outro: "Results will show up below as each step finishes.",
  summary: "Load sales.xlsx, compute statistics and highlight trends.",
  steps: [
    {
      tool: "fs.read_spreadsheet",
      title: "Read spreadsheet",
      description: "Load sheet 'Q3' from sales.xlsx",
      input: { path: "~/Documents/sales.xlsx", sheet: "Q3" },
      durationMs: 1200,
      result: {
        format: "table",
        output: SIM + "rows: 1,284   columns: region, product, units, revenue, date",
      },
    },
    {
      tool: "data.describe",
      title: "Compute statistics",
      description: "Summary statistics for numeric columns",
      durationMs: 1400,
      result: {
        format: "json",
        output:
          SIM +
          JSON.stringify(
            { revenue: { mean: 1840.2, median: 1210, max: 22100 }, units: { mean: 14.1 } },
            null,
            2,
          ),
      },
    },
    {
      tool: "data.find_trends",
      title: "Find trends",
      description: "Detect month-over-month trends and outliers",
      durationMs: 1600,
      result: {
        format: "text",
        output: SIM + "• Revenue +12% MoM in West region\n• 3 outlier orders > 3σ",
      },
    },
  ],
};

const workflow: TaskBlueprint = {
  kind: "workflow",
  title: "Design automated workflow",
  intro:
    "Let's turn that repetitive work into an automation:\n\n1. Break the workflow into steps\n2. Draft the automation\n3. Save it to **Automations** *(needs your approval)*",
  outro: "Once saved, you can schedule or run it from the Automations page.",
  summary: "Draft a reusable automation from the described workflow.",
  steps: [
    {
      tool: "ai.plan",
      title: "Break down workflow",
      description: "Identify triggers, inputs and actions",
      durationMs: 1500,
      result: {
        format: "json",
        output:
          SIM +
          JSON.stringify({ trigger: "daily 09:00", actions: ["collect", "transform", "notify"] }, null, 2),
      },
    },
    {
      tool: "automation.draft",
      title: "Draft automation",
      description: "Generate a reusable workflow definition",
      durationMs: 1300,
      result: { format: "text", output: SIM + "Drafted workflow with 3 actions." },
    },
    {
      tool: "automation.save",
      title: "Save automation",
      description: "Add the workflow to your automations",
      requiresApproval: true,
      risk: "low",
      durationMs: 600,
      result: { format: "text", output: SIM + "Would save automation 'Daily workflow'." },
    },
  ],
};

const terminal: TaskBlueprint = {
  kind: "terminal",
  title: "Run terminal commands",
  intro:
    "This needs a terminal command. Here's what I'd do:\n\n1. Inspect the environment\n2. Run the command *(needs your approval — high risk)*",
  outro: "Nothing runs without your confirmation.",
  summary: "Inspect environment and run a shell command.",
  steps: [
    {
      tool: "system.info",
      title: "Inspect environment",
      description: "Read OS, shell and working directory",
      durationMs: 900,
      result: { format: "text", output: SIM + "OS: Windows 11 · Shell: PowerShell" },
    },
    {
      tool: "shell.run",
      title: "Run command",
      description: "Execute the requested command in PowerShell",
      input: { command: "Get-ChildItem -Path . | Measure-Object" },
      requiresApproval: true,
      risk: "high",
      durationMs: 1500,
      result: { format: "text", output: SIM + "Count : 42" },
    },
  ],
};

export function pickBlueprint(prompt: string): TaskBlueprint | null {
  const p = prompt.toLowerCase();
  if (/(organi[sz]e|clean ?up|sort).*(folder|download|desktop|files)/.test(p) || p.includes("downloads"))
    return organize;
  if (/(research|report|investigate)/.test(p)) return research;
  if (/(spreadsheet|excel|csv|xlsx|analy[sz]e.*(data|sheet))/.test(p)) return spreadsheet;
  if (/(automate|workflow|repetitive|schedule)/.test(p)) return workflow;
  if (/(terminal|command|shell|powershell|run )/.test(p)) return terminal;
  return null;
}

/** Plain conversational replies when the prompt is not a task. */
export function chatReply(prompt: string): string {
  const p = prompt.toLowerCase();
  if (/(code|script|function|python|typescript|javascript)/.test(p)) {
    return [
      "Here's a small example. Once real tools are connected I could also run it for you.",
      "",
      "```python",
      "from pathlib import Path",
      "",
      "def group_by_extension(folder: str) -> dict[str, list[str]]:",
      '    """Return file names grouped by extension."""',
      "    groups: dict[str, list[str]] = {}",
      "    for f in Path(folder).iterdir():",
      "        if f.is_file():",
      "            groups.setdefault(f.suffix or 'none', []).append(f.name)",
      "    return groups",
      "```",
      "",
      "| Part | What it does |",
      "| --- | --- |",
      "| `Path.iterdir()` | Lists entries in the folder |",
      "| `setdefault` | Creates the group on first use |",
    ].join("\n");
  }
  if (/^(hi|hello|hey|hlo|yo)\b/.test(p)) {
    return "Hi! I can help you plan and automate work on your PC — organizing files, researching, analyzing data, or building repeatable workflows.\n\nTry one of the suggestions, or describe a task in your own words.";
  }
  return [
    "Here's how I'd approach that:",
    "",
    "- **Clarify the goal** — what the finished result should look like",
    "- **Identify the tools** needed (files, browser, terminal, apps)",
    "- **Plan the steps**, asking for approval before anything changes your system",
    "",
    "> Tip: phrases like *“organize my Downloads”*, *“research … and write a report”* or *“analyze this spreadsheet”* will start a demo task so you can preview the execution view.",
  ].join("\n");
}
