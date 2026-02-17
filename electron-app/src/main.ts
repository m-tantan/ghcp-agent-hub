/**
 * GHCP-Agent-Hub - Main Electron Process
 * 
 * GitHub Copilot CLI Session Manager
 */

import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, shell, Notification } from 'electron';
import * as path from 'path';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { CLISessionMonitorService } from './services/CLISessionMonitorService';
import { SessionFileWatcher, StateUpdate } from './services/SessionFileWatcher';
import { ConfigService } from './services/ConfigService';
import { TerminalService } from './services/TerminalService';
import { GitDiffService, DiffMode } from './services/GitDiffService';
import { GlobalStatsService } from './services/GlobalStatsService';
import { GlobalSearchService } from './services/GlobalSearchService';
import { NotificationService } from './services/NotificationService';
import { CLISession, SessionMonitorState, WorktreeBranch } from './models/types';

const execAsync = promisify(exec);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let monitorService: CLISessionMonitorService;
let fileWatcher: SessionFileWatcher;
let configService: ConfigService;
let terminalService: TerminalService;
let gitDiffService: GitDiffService;
let globalStatsService: GlobalStatsService;
let globalSearchService: GlobalSearchService;
let notificationService: NotificationService;

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

  // Disable Ctrl+R and Ctrl+Shift+R to prevent accidental reload that kills terminals
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key.toLowerCase() === 'r' && input.control && input.type === 'keyDown') {
      event.preventDefault();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Session stats for tray display
interface TraySessionStats {
  total: number;
  active: number;
  needingInput: number;
}

// Current cached stats
let currentTrayStats: TraySessionStats = { total: 0, active: 0, needingInput: 0 };

function createTray(): void {
  // Create a simple icon (you'd replace this with a real icon)
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAADtSURBVDiNpZMxDoJAEEXfLhYmFjYewcpLeARbS29gYecNtLHkCFZewAtwBGq/jSzZJSxofMlkJvP/zDcLG4lS6gFsge0P2ARQRHQxbh/AB9gBe+ACnIGriDyBl3H7DqRBVQsj8wKs+kw+AC4i8gJu3+sD0Dc2MyB3cAfSToBfZQOvPqAEHkAWdPqx+gTOInL5lv4OvE08zYzNLOj0Y/UD/IBrkLsOE7ABciAJOn3L/gPgAnRBZxikIrIGzkDaBN6tLJB0AlKCTt+yR0BuZM7ACrgG3X7QCTptwbMxLgk6/dhTROR8A76BlXfpC6d+M29O/OJYAAAAASUVORK5CYII='
  );

  tray = new Tray(icon);
  updateTrayTooltip();
  updateTrayContextMenu();
  tray.on('click', () => mainWindow?.show());
}

function updateTrayTooltip(): void {
  if (!tray) return;
  
  const { total, active, needingInput } = currentTrayStats;
  let tooltip = 'GHCP Agent Hub';
  
  if (total > 0) {
    const parts: string[] = [`${total} session${total !== 1 ? 's' : ''}`];
    if (active > 0) parts.push(`${active} active`);
    if (needingInput > 0) parts.push(`${needingInput} need input`);
    tooltip = parts.join(' · ');
  }
  
  tray.setToolTip(tooltip);
}

function updateTrayContextMenu(): void {
  if (!tray) return;
  
  const { total, active, needingInput } = currentTrayStats;
  
  // Get token stats for tray menu
  const stats = globalStatsService?.getGlobalStats();
  const tokenLabel = stats
    ? `Tokens: ${GlobalStatsService.formatTokens(stats.totalInputTokens + stats.totalOutputTokens)} (${GlobalStatsService.formatCost(stats.estimatedCostUsd)})`
    : 'Tokens: -';
  
  const menuItems: Electron.MenuItemConstructorOptions[] = [
    { label: 'Open', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: `Sessions: ${total}`, enabled: false },
    { label: `Active: ${active}`, enabled: false },
    { label: `Needing Input: ${needingInput}`, enabled: false },
    { type: 'separator' },
    { label: tokenLabel, enabled: false },
    { type: 'separator' },
    { label: 'Refresh Sessions', click: () => monitorService.refreshSessions() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ];
  
  const contextMenu = Menu.buildFromTemplate(menuItems);
  tray.setContextMenu(contextMenu);
}

function updateTrayStats(sessions: CLISession[]): void {
  const total = sessions.length;
  const active = sessions.filter(s => s.isActive).length;
  
  // Count sessions needing input based on monitored states
  let needingInput = 0;
  for (const session of sessions) {
    const state = fileWatcher.getState(session.id);
    if (state) {
      const statusType = state.status.type;
      if (statusType === 'waitingForUser' || statusType === 'awaitingApproval') {
        needingInput++;
      }
    }
  }
  
  currentTrayStats = { total, active, needingInput };
  updateTrayTooltip();
  updateTrayContextMenu();
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

  // Get saved filter
  ipcMain.handle('get-filter', () => {
    return configService.loadFilter();
  });

  // Save filter
  ipcMain.handle('save-filter', (_event, filter: string) => {
    configService.saveFilter(filter);
  });

  // Get session name
  ipcMain.handle('get-session-name', (_event, sessionId: string) => {
    return configService.getSessionName(sessionId);
  });

  // Set session name
  ipcMain.handle('set-session-name', (_event, sessionId: string, name: string) => {
    configService.setSessionName(sessionId, name);
  });

  // Get all session names
  ipcMain.handle('get-all-session-names', () => {
    return configService.getAllSessionNames();
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

  // Open terminal with new Copilot session (optionally with a mission/initial prompt)
  ipcMain.handle('open-terminal', async (_event, workingDir: string, branchName?: string, mission?: string) => {
    try {
      // Find copilot executable (standalone or gh extension)
      const cli = await findCopilotExecutable();
      if (!cli) {
        throw new Error('GitHub Copilot CLI is not found. Please install it first.');
      }

      // Build command - checkout branch if specified, then start copilot
      let command: string;
      let cliCommand = cli.command === 'copilot' ? `"${cli.path}"` : `"${cli.path}" copilot`;
      
      // Add mission flag if provided (-i for interactive mode with initial prompt)
      if (mission) {
        // Escape double quotes in mission for shell
        const escapedMission = mission.replace(/"/g, '\\"');
        cliCommand += ` -i "${escapedMission}"`;
      }
      
      if (process.platform === 'win32') {
        // Windows: use start cmd
        if (branchName) {
          command = `start cmd /k "cd /d "${workingDir}" && git checkout "${branchName}" && ${cliCommand}"`;
        } else {
          command = `start cmd /k "cd /d "${workingDir}" && ${cliCommand}"`;
        }
      } else {
        // macOS/Linux: create temp script and open Terminal
        const scriptContent = branchName
          ? `cd "${workingDir}" && git checkout "${branchName}" && ${cliCommand}`
          : `cd "${workingDir}" && ${cliCommand}`;
        
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
      const cli = await findCopilotExecutable();
      if (!cli) {
        throw new Error('GitHub Copilot CLI is not found. Please install it first.');
      }

      const cliCommand = cli.command === 'copilot' ? `"${cli.path}"` : `"${cli.path}" copilot`;
      
      let command: string;
      if (process.platform === 'win32') {
        command = `start cmd /k "cd /d "${workingDir}" && ${cliCommand} --resume "${sessionId}""`;
      } else {
        const scriptContent = `cd "${workingDir}" && ${cliCommand} --resume "${sessionId}"`;
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

  // === EMBEDDED TERMINAL ===
  
  // Create embedded terminal
  ipcMain.handle('terminal-create', async (_event, terminalId: string, cwd: string, sessionId?: string, mission?: string) => {
    const cli = await findCopilotExecutable();
    const copilotPath = cli ? cli.path : undefined;
    return terminalService.createTerminal(terminalId, cwd, copilotPath, sessionId, mission);
  });

  // Write to terminal
  ipcMain.handle('terminal-write', (_event, terminalId: string, data: string) => {
    terminalService.writeToTerminal(terminalId, data);
  });

  // Resize terminal
  ipcMain.handle('terminal-resize', (_event, terminalId: string, cols: number, rows: number) => {
    terminalService.resizeTerminal(terminalId, cols, rows);
  });

  // Destroy terminal
  ipcMain.handle('terminal-destroy', (_event, terminalId: string) => {
    terminalService.destroyTerminal(terminalId);
  });

  // Get active terminals
  ipcMain.handle('terminal-list', () => {
    return terminalService.getActiveTerminals();
  });

  // Check if embedded terminal is available
  ipcMain.handle('terminal-available', () => {
    return terminalService.isAvailable();
  });

  // Terminal color persistence
  ipcMain.handle('get-terminal-color', (_event, sessionId: string) => {
    return configService.getTerminalColor(sessionId);
  });
  ipcMain.handle('set-terminal-color', (_event, sessionId: string, color: string) => {
    configService.setTerminalColor(sessionId, color);
  });
  ipcMain.handle('get-all-terminal-colors', () => {
    return configService.getAllTerminalColors();
  });

  // Repo color persistence
  ipcMain.handle('get-repo-color', (_event, repoPath: string) => {
    return configService.getRepoColor(repoPath);
  });
  ipcMain.handle('set-repo-color', (_event, repoPath: string, color: string) => {
    configService.setRepoColor(repoPath, color);
  });
  ipcMain.handle('get-all-repo-colors', () => {
    return configService.getAllRepoColors();
  });

  // Saved terminals persistence
  ipcMain.handle('get-saved-terminals', () => {
    return configService.getSavedTerminals();
  });
  ipcMain.handle('set-saved-terminals', (_event, terminals: any[]) => {
    configService.setSavedTerminals(terminals);
  });

  // Session view mode
  ipcMain.handle('get-session-view-mode', () => {
    return configService.getSessionViewMode();
  });
  ipcMain.handle('set-session-view-mode', (_event, mode: 'tile' | 'list') => {
    configService.setSessionViewMode(mode);
  });

  // Terminal only mode
  ipcMain.handle('get-terminal-only-mode', () => {
    return configService.getTerminalOnlyMode();
  });
  ipcMain.handle('set-terminal-only-mode', (_event, enabled: boolean) => {
    configService.setTerminalOnlyMode(enabled);
  });

  // === GIT DIFF & CODE CHANGES ===

  // Get code changes for a working directory
  ipcMain.handle('get-code-changes', async (_event, cwd: string) => {
    return await gitDiffService.getCodeChanges(cwd);
  });

  // Get full diff
  ipcMain.handle('get-diff', async (_event, cwd: string, mode: DiffMode, baseBranch?: string) => {
    return await gitDiffService.getDiff(cwd, mode, baseBranch);
  });

  // === GLOBAL STATS ===

  // Get aggregated stats
  ipcMain.handle('get-global-stats', () => {
    return globalStatsService.getGlobalStats();
  });

  // === GLOBAL SEARCH ===

  // Deep search across all session files
  ipcMain.handle('deep-search', async (_event, query: string) => {
    return await globalSearchService.search(query);
  });
}

// Result from finding CLI executable
interface CLIExecutableResult {
  path: string;
  command: string; // 'copilot' for standalone, 'gh copilot' for gh extension
}

// Find GitHub Copilot CLI executable (standalone copilot or gh copilot)
async function findCopilotExecutable(): Promise<CLIExecutableResult | null> {
  const fs = require('fs');
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';

  // First, check for standalone 'copilot' CLI (preferred)
  const copilotPaths = process.platform === 'win32'
    ? [
        path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'copilot.exe'),
        path.join(home, 'AppData', 'Local', 'Programs', 'GitHub Copilot CLI', 'copilot.exe'),
        path.join(home, '.local', 'bin', 'copilot.exe'),
        'C:\\Program Files\\GitHub Copilot CLI\\copilot.exe',
      ]
    : [
        '/usr/local/bin/copilot',
        '/opt/homebrew/bin/copilot',
        '/usr/bin/copilot',
        path.join(home, '.local', 'bin', 'copilot'),
      ];

  for (const p of copilotPaths) {
    if (fs.existsSync(p)) return { path: p, command: 'copilot' };
  }

  // Try 'where copilot' (Windows) or 'which copilot' (Unix)
  try {
    const cmd = process.platform === 'win32' ? 'where copilot' : 'which copilot';
    const { stdout } = await execAsync(cmd);
    const found = stdout.trim().split('\n')[0];
    if (found && fs.existsSync(found)) return { path: found, command: 'copilot' };
  } catch {
    // Not found
  }

  // Fallback: check for 'gh' CLI (uses 'gh copilot' command)
  const ghPaths = process.platform === 'win32'
    ? [
        path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'gh.exe'),
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

  for (const p of ghPaths) {
    if (fs.existsSync(p)) return { path: p, command: 'gh copilot' };
  }

  // Try 'where gh' (Windows) or 'which gh' (Unix)
  try {
    const cmd = process.platform === 'win32' ? 'where gh' : 'which gh';
    const { stdout } = await execAsync(cmd);
    const found = stdout.trim().split('\n')[0];
    if (found && fs.existsSync(found)) return { path: found, command: 'gh copilot' };
  } catch {
    // Not found
  }

  return null;
}

// Auto-updater setup (Gap 13)
function setupAutoUpdater(): void {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info: any) => {
      if (Notification.isSupported()) {
        const notification = new Notification({
          title: 'Update Available',
          body: `Version ${info.version} is available. Click to download.`,
        });
        notification.on('click', () => autoUpdater.downloadUpdate());
        notification.show();
      }
    });

    autoUpdater.on('update-downloaded', () => {
      if (Notification.isSupported()) {
        const notification = new Notification({
          title: 'Update Ready',
          body: 'Restart to install the update.',
        });
        notification.on('click', () => autoUpdater.quitAndInstall());
        notification.show();
      }
    });

    // Check for updates after a delay
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 10000);
  } catch {
    console.log('Auto-updater not available (development mode)');
  }
}

app.whenReady().then(async () => {
  // Initialize services
  configService = new ConfigService();
  monitorService = new CLISessionMonitorService();
  monitorService.setConfigService(configService);
  fileWatcher = new SessionFileWatcher();
  terminalService = new TerminalService();
  gitDiffService = new GitDiffService();
  globalStatsService = new GlobalStatsService();
  globalSearchService = new GlobalSearchService();
  notificationService = new NotificationService();

  // Forward terminal events to renderer
  terminalService.on('data', (event: { terminalId: string; data: string }) => {
    mainWindow?.webContents.send('terminal-data', event);
  });
  terminalService.on('exit', (event: { terminalId: string; exitCode: number }) => {
    mainWindow?.webContents.send('terminal-exit', event);
  });

  // Forward file watcher events to renderer, update stats, and send notifications
  fileWatcher.on('stateUpdate', (update: StateUpdate) => {
    mainWindow?.webContents.send('session-state-update', update);

    // Update global stats with latest session data
    globalStatsService.updateSession(update.sessionId, update.state);

    // Handle notifications
    const statusType = update.state.status.type;
    if (statusType === 'awaitingApproval' || statusType === 'waitingForUser') {
      const toolName = statusType === 'awaitingApproval' ? (update.state.status as any).tool : undefined;
      const question = update.state.pendingQuestion?.question;
      notificationService.notifySessionNeedsAttention(update.sessionId, statusType, toolName, question);
    } else {
      notificationService.clearSession(update.sessionId);
    }

    // Re-scan to update tray stats when session state changes
    monitorService.scanAllSessions().then(updateTrayStats);
  });

  // Forward monitor service events and update tray
  monitorService.on('sessionsChanged', (sessions: CLISession[]) => {
    mainWindow?.webContents.send('sessions-changed', sessions);
    updateTrayStats(sessions);
  });

  monitorService.on('repositoriesChanged', (repos) => {
    mainWindow?.webContents.send('repositories-changed', repos);
  });

  setupIPC();
  
  // Load saved repositories from config BEFORE creating window
  await monitorService.loadSavedRepositories();
  console.log(`Restored ${monitorService.getSelectedRepositories().length} repositories from config`);
  
  createWindow();
  createTray();
  setupAutoUpdater();

  // Initial session scan and tray stats update
  monitorService.scanAllSessions().then((sessions) => {
    console.log(`Found ${sessions.length} Copilot sessions`);
    updateTrayStats(sessions);
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
  // Save active terminals for restoration on next launch
  const activeTerminals = terminalService.getActiveTerminalDetails();
  const colors = configService.getAllTerminalColors();
  const savedTerminals = activeTerminals
    .filter((t: any) => t.sessionId)
    .map((t: any) => ({
      sessionId: t.sessionId,
      cwd: t.cwd,
      color: colors[t.sessionId] || undefined,
      mission: t.mission || undefined,
    }));
  configService.setSavedTerminals(savedTerminals);

  fileWatcher.stopAll();
  terminalService.destroyAll();
});
