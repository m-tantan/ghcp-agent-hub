# Contributing to GHCP-Agent-Hub

Thanks for your interest in contributing! This guide will help you get started.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [GitHub Copilot CLI](https://github.com/features/copilot) installed and authenticated
- Git

### Setup

```bash
cd electron-app
npm install --no-fund --no-audit
```

### Running in Development

```bash
npm start
```

This runs `tsc --watch` and `electron .` concurrently, giving you hot-reload for TypeScript changes and auto-reload for renderer changes.

### Building

```bash
npm run build        # Compile TypeScript
npm run package      # Package with electron-builder
```

## Project Structure

```
ghcp-agent-hub/
├── electron-app/
│   ├── src/                # Main process (TypeScript)
│   │   ├── main.ts         # Electron main process entry
│   │   ├── preload.ts      # Preload script (IPC bridge)
│   │   ├── services/       # Backend services
│   │   └── models/         # Data models
│   ├── renderer/           # Renderer process (vanilla JS/CSS)
│   │   ├── index.html      # App shell
│   │   ├── app.js          # Application logic
│   │   └── style.css       # Styles
│   ├── package.json
│   └── tsconfig.json
├── CHANGELOG.md
├── README.md
└── LICENSE
```

## Making Changes

1. **Fork and clone** the repository.
2. **Create a branch** from `main`:
   ```bash
   git checkout -b users/<your-alias>/my-feature
   ```
3. **Make your changes** — keep them focused and minimal.
4. **Test locally** by running the app with `npm start` in the `electron-app` directory.
5. **Commit** with a clear message:
   ```
   feat: add terminal drag-and-drop navigation
   ```
6. **Open a pull request** against `main`.

### Branch Naming

Use the prefix `users/<your-alias>/` for feature branches:

```
users/jdoe/fix-sidebar-toggle
users/jdoe/add-search-highlight
```

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Use |
|--------|-----|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `docs:` | Documentation only |
| `refactor:` | Code restructuring (no behavior change) |
| `style:` | Formatting, whitespace |
| `chore:` | Build, tooling, dependencies |

## Code Guidelines

- **Minimal changes** — touch only what's needed.
- **No frameworks in the renderer** — the UI is vanilla HTML/JS/CSS by design.
- **TypeScript** for the main process (`src/`), plain JavaScript for the renderer (`renderer/`).
- **Use the existing style** — match indentation, naming, and patterns already in the codebase.
- **Comment sparingly** — only when the code isn't self-explanatory.

## Keyboard Shortcuts

When adding new shortcuts, remember to:
1. Intercept the key in `term.attachCustomKeyEventHandler()` so xterm passes it through.
2. Handle it in the global `document.addEventListener('keydown', ...)` block.
3. Add it to the shortcuts help table in `index.html` (`#shortcutsHelpOverlay`).

## Reporting Issues

Open an issue with:
- Steps to reproduce
- Expected vs. actual behavior
- OS and Node.js version

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
