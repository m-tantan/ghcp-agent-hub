# GHCP-Agent-Hub Feature Gaps & Parity Status

## Current Status: ✅ Core Feature Parity Achieved

Last Updated: 2026-01-29

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
| **Embedded terminal** | ✅ SwiftTerm | ❌ Opens external cmd | ⚠️ Gap |
| **Start in Hub** | ✅ Embedded terminal | ❌ Not implemented | ⚠️ Gap |
| Menu bar stats | ✅ | ❌ | ⚠️ Gap |
| Inline diff editor | ✅ | ❌ | ⚠️ Gap |
| Pending changes preview | ✅ | ❌ | ⚠️ Gap |
| Code changes view | ✅ | ❌ | ⚠️ Gap |
| Session naming/renaming | ✅ | ❌ | ⚠️ Gap |
| Auto-updates (Sparkle) | ✅ | ❌ | ⚠️ Gap |

## Gaps to Address

### High Priority
1. **Embedded Terminal (xterm.js)**
   - AgentHub uses SwiftTerm for embedded terminal
   - Could add xterm.js + node-pty for similar functionality
   - Would enable "Start in Hub" feature

2. **Auto-updates**
   - Add electron-updater for automatic updates
   - Set up GitHub releases workflow

### Medium Priority
3. **Menu Bar Stats**
   - Show session counts/status in system tray tooltip
   - Could add tray menu with quick stats

4. **Session Naming**
   - Allow custom names for sessions
   - Store in local metadata

### Lower Priority
5. **Inline Diff Editor**
   - Preview code changes before accepting
   - Would require Monaco editor or similar

6. **Pending Changes Preview**
   - Show git diff for session changes
   - Integrate with git commands

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
cd C:\SOC\GHCP-Agent-Hub\electron-app
npm install --no-fund --no-audit
npm run dev
```

## Files Structure

```
GHCP-Agent-Hub/
├── electron-app/           # Windows Electron app
│   ├── src/
│   │   ├── main.ts         # Main process
│   │   ├── preload.ts      # IPC bridge
│   │   ├── models/         # TypeScript types
│   │   └── services/       # Core services
│   │       ├── SessionEventsParser.ts
│   │       ├── SessionFileWatcher.ts
│   │       └── CLISessionMonitorService.ts
│   └── renderer/
│       └── index.html      # UI
├── app/                    # Swift reference (macOS)
│   └── modules/GHCPAgentHubCore/
└── scripts/
```

## Next Steps for New Session

1. Add embedded terminal with xterm.js
2. Add electron-builder packaging
3. Add auto-updater
4. Create GitHub Actions release workflow
