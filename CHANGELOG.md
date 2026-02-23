# Changelog

All notable changes to GHCP-Agent-Hub will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Ctrl+R shortcut to add/edit memo on active terminal
- Ctrl+1–9 to switch focus to terminal by visual position (left-to-right, top-to-bottom)
- Drag-and-drop files onto terminals to `cd` into the file's directory
- Centered memo display in terminal nav bar

## [1.0.0] - 2026-02-22

### Added
- Electron-based desktop app for managing GitHub Copilot CLI sessions
- Real-time session monitoring with status tracking (Thinking, Executing, Awaiting, Idle)
- Multi-terminal support with embedded xterm.js terminals and WebGL rendering
- Quick Start sessions with optional mission/task descriptions
- Git worktree management (create, switch, remove) from the UI
- Sidebar with repository listing, worktree navigation, and collapse/expand
- Session search with full-text matching across session data
- Date range filtering (defaults to last 7 days)
- Tile and list view modes for sessions
- Diff panel with staged/unstaged file changes and inline editing
- Activity panel for real-time session event monitoring
- Activity stats panel with usage metrics
- Repo and terminal color schemes with palette picker
- Terminal features: minimize, maximize, rename/memo, color coding
- Ctrl+C copy / Ctrl+V paste with image support (saves to temp, types `@path`)
- Ctrl+N for new blank terminal
- Ctrl+F terminal search overlay
- Ctrl+M terminal maximize/restore
- Ctrl+Shift+E to open terminal folder in Explorer
- F1 keyboard shortcuts help modal
- F2 to rename/memo the active terminal
- Auto-focus terminal-only mode on first terminal open
- Responsive sidebar with auto-collapse and toggle
- Dev hot-reload with `tsc --watch` and renderer auto-reload
- Clipboard image paste support for Copilot CLI
