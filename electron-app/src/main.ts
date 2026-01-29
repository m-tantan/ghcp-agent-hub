/**
 * GHCP-Agent-Hub - Main Electron Process
 * 
 * GitHub Copilot CLI Session Manager
 */

import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron';
import * as path from 'path';
import { CLISessionMonitorService } from './services/CLISessionMonitorService';
import { SessionFileWatcher, StateUpdate } from './services/SessionFileWatcher';
import { CLISession, SessionMonitorState } from './models/types';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let monitorService: CLISessionMonitorService;
let fileWatcher: SessionFileWatcher;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'GHCP Agent Hub',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray(): void {
  // Create a simple icon (you'd replace this with a real icon)
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAADtSURBVDiNpZMxDoJAEEXfLhYmFjYewcpLeARbS29gYecNtLHkCFZewAtwBGq/jSzZJSxofMlkJvP/zDcLG4lS6gFsge0P2ARQRHQxbh/AB9gBe+ACnIGriDyBl3H7DqRBVQsj8wKs+kw+AC4i8gJu3+sD0Dc2MyB3cAfSToBfZQOvPqAEHkAWdPqx+gTOInL5lv4OvE08zYzNLOj0Y/UD/IBrkLsOE7ABciAJOn3L/gPgAnRBZxikIrIGzkDaBN6tLJB0AlKCTt+yR0BuZM7ACrgG3X7QCTptwbMxLgk6/dhTROR8A76BlXfpC6d+M29O/OJYAAAAASUVORK5CYII='
  );

  tray = new Tray(icon);
  tray.setToolTip('GHCP Agent Hub');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open', click: () => mainWindow?.show() },
    { label: 'Refresh Sessions', click: () => monitorService.refreshSessions() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => mainWindow?.show());
}

function setupIPC(): void {
  // Get all sessions
  ipcMain.handle('get-sessions', async () => {
    return await monitorService.scanAllSessions();
  });

  // Get selected repositories
  ipcMain.handle('get-repositories', () => {
    return monitorService.getSelectedRepositories();
  });

  // Add repository
  ipcMain.handle('add-repository', async (_event, repoPath: string) => {
    return await monitorService.addRepository(repoPath);
  });

  // Remove repository
  ipcMain.handle('remove-repository', (_event, repoPath: string) => {
    monitorService.removeRepository(repoPath);
  });

  // Refresh sessions
  ipcMain.handle('refresh-sessions', async () => {
    await monitorService.refreshSessions();
    return await monitorService.scanAllSessions();
  });

  // Start monitoring a session
  ipcMain.handle('start-monitoring', (_event, sessionId: string) => {
    fileWatcher.startMonitoring(sessionId);
  });

  // Stop monitoring a session
  ipcMain.handle('stop-monitoring', (_event, sessionId: string) => {
    fileWatcher.stopMonitoring(sessionId);
  });

  // Get session state
  ipcMain.handle('get-session-state', (_event, sessionId: string) => {
    return fileWatcher.getState(sessionId);
  });
}

app.whenReady().then(() => {
  // Initialize services
  monitorService = new CLISessionMonitorService();
  fileWatcher = new SessionFileWatcher();

  // Forward file watcher events to renderer
  fileWatcher.on('stateUpdate', (update: StateUpdate) => {
    mainWindow?.webContents.send('session-state-update', update);
  });

  // Forward monitor service events
  monitorService.on('sessionsChanged', (sessions: CLISession[]) => {
    mainWindow?.webContents.send('sessions-changed', sessions);
  });

  monitorService.on('repositoriesChanged', (repos) => {
    mainWindow?.webContents.send('repositories-changed', repos);
  });

  setupIPC();
  createWindow();
  createTray();

  // Initial session scan
  monitorService.scanAllSessions().then((sessions) => {
    console.log(`Found ${sessions.length} Copilot sessions`);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('before-quit', () => {
  fileWatcher.stopAll();
});
