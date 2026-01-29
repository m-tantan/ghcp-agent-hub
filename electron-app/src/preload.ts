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

  // Session monitoring
  startMonitoring: (sessionId: string) => ipcRenderer.invoke('start-monitoring', sessionId),
  stopMonitoring: (sessionId: string) => ipcRenderer.invoke('stop-monitoring', sessionId),
  getSessionState: (sessionId: string) => ipcRenderer.invoke('get-session-state', sessionId),

  // NEW: Terminal & Session Creation
  openTerminal: (workingDir: string, branchName?: string) => 
    ipcRenderer.invoke('open-terminal', workingDir, branchName),
  resumeSessionTerminal: (sessionId: string, workingDir: string) =>
    ipcRenderer.invoke('resume-session-terminal', sessionId, workingDir),
  
  // NEW: Worktree management
  createWorktree: (repoPath: string, branchName: string, baseBranch: string) =>
    ipcRenderer.invoke('create-worktree', repoPath, branchName, baseBranch),
  getBranches: (repoPath: string) => ipcRenderer.invoke('get-branches', repoPath),
  deleteWorktree: (repoPath: string, worktreePath: string) =>
    ipcRenderer.invoke('delete-worktree', repoPath, worktreePath),
  
  // NEW: Utilities
  openFolder: (folderPath: string) => ipcRenderer.invoke('open-folder', folderPath),

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
});
