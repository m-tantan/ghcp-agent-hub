# GHCP-Agent-Hub Feature Gaps & Parity Status

## Current Status: ✅ Near-Full Feature Parity

Last Updated: 2026-02-15

## Feature Comparison

| Feature | AgentHub (macOS) | GHCP-Agent-Hub (Windows) | Status |
|---------|------------------|--------------------------|--------|
| View sessions | ✅ | ✅ | ✅ Complete |
| Session status indicators | ✅ | ✅ | ✅ Complete |
| Activity panel | ✅ | ✅ | ✅ Complete |
| Add Repository | ✅ | ✅ Folder picker | ✅ Complete |
| Repository tree view | ✅ | ✅ Sidebar with worktrees | ✅ Complete |
| Create Worktree | ✅ | ✅ Modal with branch picker | ✅ Complete |
| Delete Worktree | ✅ | ✅ | ✅ Complete |
| New Session (terminal) | ✅ `onOpenTerminal` | ✅ Opens cmd with `gh copilot` | ✅ Complete |
| Resume Session | ✅ | ✅ `gh copilot -r <id>` | ✅ Complete |
| Search sessions | ✅ | ✅ | ✅ Complete |
| Real-time file watching | ✅ DispatchSource | ✅ chokidar | ✅ Complete |
| System tray | ✅ | ✅ | ✅ Complete |
| **Embedded terminal** | ✅ SwiftTerm | ✅ xterm.js + node-pty | ✅ Complete |
| **Start in Hub** | ✅ Embedded terminal | ✅ Embedded terminal | ✅ Complete |
| **Interactive terminal** | ✅ SwiftTerm | ✅ xterm.js + node-pty | ✅ Complete |
| **Menu bar stats** | ✅ | ✅ Tray context menu | ✅ Complete |
| **Git diff view** | ✅ | ✅ Diff panel (unstaged/staged) | ✅ Complete |
| **Code changes view** | ✅ | ✅ File list on session cards | ✅ Complete |
| **Pending changes preview** | ✅ | ✅ View Changes button + diff panel | ✅ Complete |
| **Session naming/renaming** | ✅ | ✅ | ✅ Complete |
| **Session filters** | ✅ | ✅ All/Active/Needs Input | ✅ Complete |
| **Global stats dashboard** | ✅ | ✅ Token stats panel | ✅ Complete |
| **Context window bar** | ✅ | ✅ Per-session progress bar | ✅ Complete |
| **Deep search** | ✅ | ✅ Full-text across events.jsonl | ✅ Complete |
| **Approval notifications** | ✅ | ✅ Windows toast + beep | ✅ Complete |
| **Markdown rendering** | ✅ | ✅ Inline markdown in activity | ✅ Complete |
| **Auto-updates** | ✅ Sparkle | ✅ electron-updater | ✅ Complete |
| Quick start with mission | ✅ | ✅ Mission modal | ✅ Complete |
| Persist repo config | ✅ | ✅ JSON config | ✅ Complete |
| Inline diff editor | ✅ | ❌ | 🔲 Deferred |
| Intelligence/Orchestration | ✅ | ❌ | 🔲 Deferred |

## Deferred Features

### Inline Diff Editor
- macOS has `InlineEditorView` for suggesting edits on diff lines
- Requires tight Monaco/CodeMirror integration — the read-only diff view covers 80% of the need
- Can be added later if demand arises

### Intelligence / Orchestration
- macOS has Claude-powered parallel worktree orchestration (`WorktreeOrchestrationService`)
- Requires Claude Code SDK integration and is a major standalone feature
- Manual worktree creation already available in the Hub

## Technical Differences

| Aspect | AgentHub | GHCP-Agent-Hub |
|--------|----------|----------------|
| Platform | macOS only | Windows/Mac/Linux |
| UI Framework | SwiftUI | Electron + HTML/CSS |
| Language | Swift | TypeScript |
| Terminal | SwiftTerm (native) | External cmd (gap) |
| File watching | DispatchSource | chokidar |
| Session path | `~/.claude/projects/{encoded}/{id}.jsonl` | `~/.copilot/session-state/{id}/events.jsonl` |
| Metadata | Embedded in JSONL | Separate `workspace.yaml` |
| CLI command | `claude` | `gh copilot` |

## How to Run

```bash
cd electron-app
npm install --no-fund --no-audit
npm start
```

## Files Structure

```
GHCP-Agent-Hub/
├── electron-app/           # Windows Electron app
│   ├── src/
│   │   ├── main.ts         # Main process
│   │   ├── preload.ts      # IPC bridge
│   │   ├── models/         # TypeScript types
│   │   │   └── types.ts
│   │   └── services/       # Core services
│   │       ├── SessionEventsParser.ts
│   │       ├── SessionFileWatcher.ts
│   │       ├── CLISessionMonitorService.ts
│   │       ├── ConfigService.ts
│   │       ├── TerminalService.ts
│   │       ├── GitDiffService.ts
│   │       ├── GlobalStatsService.ts
│   │       ├── GlobalSearchService.ts
│   │       └── NotificationService.ts
│   └── renderer/
│       └── index.html      # UI
├── app/                    # Swift reference (macOS)
│   └── modules/GHCPAgentHubCore/
└── scripts/
```

## Next Steps

1. Add electron-builder packaging
2. Create GitHub Actions release workflow
3. Consider inline editor if demand arises
4. Consider AI orchestration feature
