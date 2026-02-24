/**
 * Preload script - exposes safe APIs to renderer
 */

import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Session management
  getSessions: () => ipcRenderer.invoke('get-sessions'),
  getRepositories: () => ipcRenderer.invoke('get-repositories'),
  addRepository: (path?: string) => ipcRenderer.invoke('add-repository', path),
  removeRepository: (path: string) => ipcRenderer.invoke('remove-repository', path),
  refreshSessions: () => ipcRenderer.invoke('refresh-sessions'),
  
  // Filter persistence
  getFilter: () => ipcRenderer.invoke('get-filter'),
  saveFilter: (filter: string) => ipcRenderer.invoke('save-filter', filter),

  // Session naming
  getSessionName: (sessionId: string) => ipcRenderer.invoke('get-session-name', sessionId),
  setSessionName: (sessionId: string, name: string) => ipcRenderer.invoke('set-session-name', sessionId, name),
  getAllSessionNames: () => ipcRenderer.invoke('get-all-session-names'),

  // Session monitoring
  startMonitoring: (sessionId: string) => ipcRenderer.invoke('start-monitoring', sessionId),
  stopMonitoring: (sessionId: string) => ipcRenderer.invoke('stop-monitoring', sessionId),
  getSessionState: (sessionId: string) => ipcRenderer.invoke('get-session-state', sessionId),

  // External Terminal & Session Creation (legacy)
  openTerminal: (workingDir: string, branchName?: string, mission?: string) => 
    ipcRenderer.invoke('open-terminal', workingDir, branchName, mission),
  resumeSessionTerminal: (sessionId: string, workingDir: string) =>
    ipcRenderer.invoke('resume-session-terminal', sessionId, workingDir),

  // Embedded Terminal
  terminalCreate: (terminalId: string, cwd: string, sessionId?: string, mission?: string) =>
    ipcRenderer.invoke('terminal-create', terminalId, cwd, sessionId, mission),
  terminalCreateBlank: (terminalId: string, cwd: string) =>
    ipcRenderer.invoke('terminal-create-blank', terminalId, cwd),
  getHomeDir: () => ipcRenderer.invoke('get-home-dir'),
  terminalWrite: (terminalId: string, data: string) =>
    ipcRenderer.invoke('terminal-write', terminalId, data),
  terminalResize: (terminalId: string, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal-resize', terminalId, cols, rows),
  terminalDestroy: (terminalId: string) =>
    ipcRenderer.invoke('terminal-destroy', terminalId),
  terminalList: () => ipcRenderer.invoke('terminal-list'),
  terminalAvailable: () => ipcRenderer.invoke('terminal-available'),
  saveClipboardImage: () => ipcRenderer.invoke('save-clipboard-image'),
  writeTempReview: (content: string) => ipcRenderer.invoke('write-temp-review', content),

  // Terminal colors & persistence
  getTerminalColor: (sessionId: string) => ipcRenderer.invoke('get-terminal-color', sessionId),
  setTerminalColor: (sessionId: string, color: string) => ipcRenderer.invoke('set-terminal-color', sessionId, color),
  getAllTerminalColors: () => ipcRenderer.invoke('get-all-terminal-colors'),

  // Repo colors
  getRepoColor: (repoPath: string) => ipcRenderer.invoke('get-repo-color', repoPath),
  setRepoColor: (repoPath: string, color: string) => ipcRenderer.invoke('set-repo-color', repoPath, color),
  getAllRepoColors: () => ipcRenderer.invoke('get-all-repo-colors'),

  getSavedTerminals: () => ipcRenderer.invoke('get-saved-terminals'),
  setSavedTerminals: (terminals: any[]) => ipcRenderer.invoke('set-saved-terminals', terminals),

  // Session view mode
  getSessionViewMode: () => ipcRenderer.invoke('get-session-view-mode'),
  setSessionViewMode: (mode: string) => ipcRenderer.invoke('set-session-view-mode', mode),

  // Terminal only mode
  getTerminalOnlyMode: () => ipcRenderer.invoke('get-terminal-only-mode'),
  setTerminalOnlyMode: (enabled: boolean) => ipcRenderer.invoke('set-terminal-only-mode', enabled),
  
  // Worktree management
  createWorktree: (repoPath: string, branchName: string, baseBranch: string) =>
    ipcRenderer.invoke('create-worktree', repoPath, branchName, baseBranch),
  getBranches: (repoPath: string) => ipcRenderer.invoke('get-branches', repoPath),
  deleteWorktree: (repoPath: string, worktreePath: string) =>
    ipcRenderer.invoke('delete-worktree', repoPath, worktreePath),
  
  // Utilities
  openFolder: (folderPath: string) => ipcRenderer.invoke('open-folder', folderPath),

  // Git Diff & Code Changes
  getCodeChanges: (cwd: string) => ipcRenderer.invoke('get-code-changes', cwd),
  getDiff: (cwd: string, mode: string, baseBranch?: string) => ipcRenderer.invoke('get-diff', cwd, mode, baseBranch),
  getAnnotatedFile: (cwd: string, filePath: string, mode: string, baseBranch?: string) => ipcRenderer.invoke('get-annotated-file', cwd, filePath, mode, baseBranch),

  // Global Stats
  getGlobalStats: (fromMs?: number, toMs?: number) => ipcRenderer.invoke('get-global-stats', fromMs, toMs),

  // Global Search
  deepSearch: (query: string) => ipcRenderer.invoke('deep-search', query),

  // Event listeners
  onSessionStateUpdate: (callback: (update: unknown) => void) => {
    ipcRenderer.on('session-state-update', (_event, update) => callback(update));
  },
  onSessionsChanged: (callback: (sessions: unknown[]) => void) => {
    ipcRenderer.on('sessions-changed', (_event, sessions) => callback(sessions));
  },
  onRepositoriesChanged: (callback: (repos: unknown[]) => void) => {
    ipcRenderer.on('repositories-changed', (_event, repos) => callback(repos));
  },
  onTerminalData: (callback: (event: { terminalId: string; data: string }) => void) => {
    ipcRenderer.on('terminal-data', (_event, data) => callback(data));
  },
  onTerminalExit: (callback: (event: { terminalId: string; exitCode: number }) => void) => {
    ipcRenderer.on('terminal-exit', (_event, data) => callback(data));
  },
  onTerminalSessionDetected: (callback: (event: { terminalId: string; sessionId: string }) => void) => {
    ipcRenderer.on('terminal-session-detected', (_event, data) => callback(data));
  },
});
