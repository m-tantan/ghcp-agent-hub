/**
 * GHCP-Agent-Hub - Main Electron Process
 * 
 * GitHub Copilot CLI Session Manager
 */

import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, shell } from 'electron';
import * as path from 'path';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { CLISessionMonitorService } from './services/CLISessionMonitorService';
import { SessionFileWatcher, StateUpdate } from './services/SessionFileWatcher';
import { CLISession, SessionMonitorState, WorktreeBranch } from './models/types';

const execAsync = promisify(exec);

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

  // Add repository via folder picker
  ipcMain.handle('add-repository', async (_event, repoPath?: string) => {
    if (!repoPath) {
      // Open folder picker
      const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openDirectory'],
        title: 'Select Repository Folder',
      });
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      repoPath = result.filePaths[0];
    }
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

  // === NEW SESSION FEATURES ===

  // Open terminal with new Copilot session
  ipcMain.handle('open-terminal', async (_event, workingDir: string, branchName?: string) => {
    try {
      // Find gh executable
      const ghPath = await findGHExecutable();
      if (!ghPath) {
        throw new Error('GitHub CLI (gh) not found. Please install it first.');
      }

      // Build command - checkout branch if specified, then start gh copilot
      let command: string;
      if (process.platform === 'win32') {
        // Windows: use start cmd
        if (branchName) {
          command = `start cmd /k "cd /d "${workingDir}" && git checkout "${branchName}" && "${ghPath}" copilot"`;
        } else {
          command = `start cmd /k "cd /d "${workingDir}" && "${ghPath}" copilot"`;
        }
      } else {
        // macOS/Linux: create temp script and open Terminal
        const scriptContent = branchName
          ? `cd "${workingDir}" && git checkout "${branchName}" && "${ghPath}" copilot`
          : `cd "${workingDir}" && "${ghPath}" copilot`;
        
        const tempScript = path.join(app.getPath('temp'), `ghcp_${Date.now()}.command`);
        const fs = require('fs');
        fs.writeFileSync(tempScript, `#!/bin/bash\n${scriptContent}`, { mode: 0o755 });
        await shell.openPath(tempScript);
        setTimeout(() => fs.unlinkSync(tempScript), 5000);
        return { success: true };
      }

      await execAsync(command);
      return { success: true };
    } catch (error) {
      console.error('Failed to open terminal:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Resume existing session in terminal
  ipcMain.handle('resume-session-terminal', async (_event, sessionId: string, workingDir: string) => {
    try {
      const ghPath = await findGHExecutable();
      if (!ghPath) {
        throw new Error('GitHub CLI (gh) not found.');
      }

      let command: string;
      if (process.platform === 'win32') {
        command = `start cmd /k "cd /d "${workingDir}" && "${ghPath}" copilot -r "${sessionId}""`;
      } else {
        const scriptContent = `cd "${workingDir}" && "${ghPath}" copilot -r "${sessionId}"`;
        const tempScript = path.join(app.getPath('temp'), `ghcp_resume_${Date.now()}.command`);
        const fs = require('fs');
        fs.writeFileSync(tempScript, `#!/bin/bash\n${scriptContent}`, { mode: 0o755 });
        await shell.openPath(tempScript);
        setTimeout(() => fs.unlinkSync(tempScript), 5000);
        return { success: true };
      }

      await execAsync(command);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Create git worktree
  ipcMain.handle('create-worktree', async (_event, repoPath: string, branchName: string, baseBranch: string) => {
    try {
      // Determine worktree path (sibling to repo with branch suffix)
      const repoName = path.basename(repoPath);
      const parentDir = path.dirname(repoPath);
      const safeBranchName = branchName.replace(/\//g, '-');
      const worktreePath = path.join(parentDir, `${repoName}-${safeBranchName}`);

      // Create worktree with new branch
      const cmd = `git worktree add -b "${branchName}" "${worktreePath}" "${baseBranch}"`;
      await execAsync(cmd, { cwd: repoPath });

      // Refresh to pick up new worktree
      await monitorService.refreshSessions();

      return { success: true, worktreePath };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Get git branches for a repo
  ipcMain.handle('get-branches', async (_event, repoPath: string) => {
    try {
      const { stdout } = await execAsync('git branch -a', { cwd: repoPath });
      const branches = stdout
        .split('\n')
        .map(b => b.trim().replace(/^\* /, ''))
        .filter(b => b && !b.startsWith('remotes/'));
      return branches;
    } catch {
      return ['main', 'master'];
    }
  });

  // Delete worktree
  ipcMain.handle('delete-worktree', async (_event, repoPath: string, worktreePath: string) => {
    try {
      await execAsync(`git worktree remove "${worktreePath}" --force`, { cwd: repoPath });
      await monitorService.refreshSessions();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Open folder in system file explorer
  ipcMain.handle('open-folder', (_event, folderPath: string) => {
    shell.openPath(folderPath);
  });
}

// Find gh CLI executable
async function findGHExecutable(): Promise<string | null> {
  const fs = require('fs');
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';

  // Common paths
  const searchPaths = process.platform === 'win32'
    ? [
        path.join(home, 'AppData', 'Local', 'Programs', 'GitHub CLI', 'gh.exe'),
        'C:\\Program Files\\GitHub CLI\\gh.exe',
        'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
      ]
    : [
        '/usr/local/bin/gh',
        '/opt/homebrew/bin/gh',
        '/usr/bin/gh',
        path.join(home, '.local', 'bin', 'gh'),
      ];

  for (const p of searchPaths) {
    if (fs.existsSync(p)) return p;
  }

  // Try 'where' (Windows) or 'which' (Unix)
  try {
    const cmd = process.platform === 'win32' ? 'where gh' : 'which gh';
    const { stdout } = await execAsync(cmd);
    const found = stdout.trim().split('\n')[0];
    if (found && fs.existsSync(found)) return found;
  } catch {
    // Not found
  }

  return null;
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
