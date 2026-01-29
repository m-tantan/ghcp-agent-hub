/**
 * Preload script - exposes safe APIs to renderer
 */

import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Session management
  getSessions: () => ipcRenderer.invoke('get-sessions'),
  getRepositories: () => ipcRenderer.invoke('get-repositories'),
  addRepository: (path: string) => ipcRenderer.invoke('add-repository', path),
  removeRepository: (path: string) => ipcRenderer.invoke('remove-repository', path),
  refreshSessions: () => ipcRenderer.invoke('refresh-sessions'),

  // Session monitoring
  startMonitoring: (sessionId: string) => ipcRenderer.invoke('start-monitoring', sessionId),
  stopMonitoring: (sessionId: string) => ipcRenderer.invoke('stop-monitoring', sessionId),
  getSessionState: (sessionId: string) => ipcRenderer.invoke('get-session-state', sessionId),

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
