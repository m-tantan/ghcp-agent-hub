# GHCP-Agent-Hub

Manage all sessions in GitHub Copilot CLI. Easily create new worktrees, run multiple terminals in parallel, preview edits before accepting them, make inline changes directly from diffs, and more.

This is a GitHub Copilot CLI adaptation of [AgentHub](https://github.com/jamesrochabrun/AgentHub), originally built for Claude Code.

## Features

- **Works immediately** - No setup required, works with your GitHub Copilot CLI
- **Observe sessions in real-time** - Monitor all your Copilot CLI sessions
- **Search across all sessions** - Find any session instantly
- **Run sessions in parallel** - Create and manage multiple Copilot CLI sessions in the hub
- **Create worktrees** - Easily spin up new git worktrees from the UI
- **Preview and edit diffs** - Make inline changes directly from the diff view
- **Image & file support** — Attach and work with images and files in sessions
- **Full-screen terminal mode** — Maximize sessions for distraction-free focus

## Requirements

- macOS 14.0+
- [GitHub Copilot CLI](https://github.com/features/copilot) installed and authenticated

## Session Data

GHCP-Agent-Hub reads GitHub Copilot CLI session data from:

```
~/.copilot/session-state/{sessionId}/events.jsonl
~/.copilot/session-state/{sessionId}/workspace.yaml
```

## Session States

| Status | Description |
|--------|-------------|
| Thinking | Copilot is processing |
| Executing Tool | Running a tool call |
| Awaiting Approval | Tool requires user confirmation |
| Waiting for User | Awaiting input |
| Idle | Session inactive |

## Differences from Claude Code AgentHub

| Aspect | Claude Code AgentHub | GHCP-Agent-Hub |
|--------|---------------------|----------------|
| Session Path | `~/.claude/projects/{encoded-path}/{sessionId}.jsonl` | `~/.copilot/session-state/{sessionId}/events.jsonl` |
| Metadata | Embedded in JSONL | Separate `workspace.yaml` file |
| CLI Command | `claude` | `gh copilot` |
| Event Format | `{type, message, timestamp}` | `{type, data, id, timestamp, parentId}` |

## Privacy

GHCP-Agent-Hub runs entirely on your machine. It does not collect, transmit, or store any data externally. The app simply reads your local Copilot CLI session files to display their status.

## License

MIT
