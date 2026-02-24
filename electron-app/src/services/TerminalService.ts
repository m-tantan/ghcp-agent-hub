/**
 * TerminalService
 * 
 * Manages embedded terminal sessions using node-pty.
 * Provides IPC interface for renderer to interact with terminals.
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

const fsPromises = fs.promises;

// Try to load node-pty, but handle if it's not available
let pty: any = null;
try {
  pty = require('node-pty');
} catch (e) {
  console.warn('node-pty not available - embedded terminal disabled. Install Spectre-mitigated libraries in Visual Studio to enable.');
}

export interface TerminalSession {
  id: string;
  ptyProcess: any; // pty.IPty when available
  sessionId?: string; // Copilot session ID if resuming
  cwd: string;
  mission?: string; // Mission text if started with one
}

export class TerminalService extends EventEmitter {
  private terminals: Map<string, TerminalSession> = new Map();
  private shell: string;
  private _isAvailable: boolean;
  private sessionStatePath: string;

  constructor() {
    super();
    this._isAvailable = pty !== null;
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    this.sessionStatePath = path.join(home, '.copilot', 'session-state');
    // Determine shell based on platform - prefer pwsh over powershell.exe
    if (process.platform === 'win32') {
      const pwshPath = process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe') : null;
      this.shell = (pwshPath && fs.existsSync(pwshPath)) ? pwshPath : 'powershell.exe';
    } else {
      this.shell = process.env.SHELL || '/bin/bash';
    }
  }

  /**
   * Check if terminal service is available
   */
  isAvailable(): boolean {
    return this._isAvailable;
  }

  /**
   * Create a new terminal session
   */
  async createTerminal(
    terminalId: string,
    cwd: string,
    copilotPath?: string,
    copilotSessionId?: string,
    mission?: string,
    copilotCommand?: string,
    skipCopilot?: boolean
  ): Promise<string | null> {
    if (!pty) {
      console.error('Cannot create terminal: node-pty not available');
      return null;
    }

    // Kill existing terminal with same ID
    if (this.terminals.has(terminalId)) {
      this.destroyTerminal(terminalId);
    }

    // Validate CWD exists, fallback to home directory
    let safeCwd = path.resolve(cwd);
    try {
      if (!fs.existsSync(safeCwd) || !fs.statSync(safeCwd).isDirectory()) {
        safeCwd = process.env.USERPROFILE || process.env.HOME || process.cwd();
        console.warn(`CWD does not exist: ${cwd}, falling back to: ${safeCwd}`);
      }
    } catch {
      safeCwd = process.env.USERPROFILE || process.env.HOME || process.cwd();
    }

    const cols = 120;
    const rows = 30;

    // Create pty process
    let ptyProcess: any;
    try {
      console.log(`Creating terminal in: ${safeCwd}`);
      const shellArgs = process.platform === 'win32' ? ['-NoProfile', '-NoLogo'] : [];
      ptyProcess = pty.spawn(this.shell, shellArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: safeCwd,
        env: { ...process.env, TERM: 'xterm-256color' } as { [key: string]: string },
      });
    } catch (err: any) {
      // If spawn fails with the requested cwd, try user home
      const fallbackCwd = process.env.USERPROFILE || process.env.HOME || 'C:\\';
      console.warn(`pty.spawn failed for ${safeCwd}: ${err.message}. Retrying with ${fallbackCwd}`);
      try {
        const shellArgs = process.platform === 'win32' ? ['-NoProfile', '-NoLogo'] : [];
        ptyProcess = pty.spawn(this.shell, shellArgs, {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: fallbackCwd,
          env: { ...process.env, TERM: 'xterm-256color' } as { [key: string]: string },
        });
      } catch (err2: any) {
        console.error(`pty.spawn failed completely: ${err2.message}`);
        return null;
      }
    }

    const session: TerminalSession = {
      id: terminalId,
      ptyProcess,
      sessionId: copilotSessionId,
      cwd,
      mission,
    };

    this.terminals.set(terminalId, session);

    // Forward data from pty to renderer
    ptyProcess.onData((data: string) => {
      this.emit('data', { terminalId, data });
    });

    ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      console.log(`[TerminalService] Terminal ${terminalId} exited with code ${exitCode} (cwd: ${cwd}, session: ${copilotSessionId || 'none'})`);
      this.emit('exit', { terminalId, exitCode });
      this.terminals.delete(terminalId);
    });

    // Start copilot unless explicitly skipped (blank terminal)
    if (skipCopilot) return terminalId;

    // Snapshot existing sessions before starting copilot (for detection of new sessions)
    const isNewSession = !copilotSessionId;
    let sessionSnapshot: Set<string> | null = null;
    if (isNewSession) {
      sessionSnapshot = await this.snapshotSessionDirs();
    }

    setTimeout(() => {
      const isGh = copilotCommand === 'gh copilot';
      let baseCmd: string;
      if (copilotPath) {
        baseCmd = isGh ? `& "${copilotPath}" copilot` : `& "${copilotPath}"`;
      } else {
        // Fallback: rely on copilot being in the shell's PATH
        baseCmd = isGh ? 'gh copilot' : 'copilot';
      }

      let command: string;
      if (copilotSessionId) {
        command = `${baseCmd} --resume "${copilotSessionId}"\r`;
      } else if (mission) {
        command = `${baseCmd} -i "${mission!.replace(/"/g, '\\"')}"\r`;
      } else {
        command = `${baseCmd}\r`;
      }
      ptyProcess.write(command);

      // Start detecting the session ID for new sessions
      if (isNewSession && sessionSnapshot) {
        this.detectSessionForTerminal(terminalId, safeCwd, sessionSnapshot);
      }
    }, 500);

    return terminalId;
  }

  /**
   * Write data to terminal
   */
  writeToTerminal(terminalId: string, data: string): void {
    const session = this.terminals.get(terminalId);
    if (session) {
      session.ptyProcess.write(data);
    }
  }

  /**
   * Resize terminal
   */
  resizeTerminal(terminalId: string, cols: number, rows: number): void {
    const session = this.terminals.get(terminalId);
    if (session) {
      session.ptyProcess.resize(cols, rows);
    }
  }

  /**
   * Destroy terminal
   */
  destroyTerminal(terminalId: string): void {
    const session = this.terminals.get(terminalId);
    if (session) {
      session.ptyProcess.kill();
      this.terminals.delete(terminalId);
    }
  }

  /**
   * Get all active terminal IDs
   */
  getActiveTerminals(): string[] {
    return Array.from(this.terminals.keys());
  }

  /**
   * Get details of all active terminals (for persistence)
   */
  getActiveTerminalDetails(): Array<{ id: string; sessionId?: string; cwd: string; mission?: string }> {
    return Array.from(this.terminals.values()).map(t => ({
      id: t.id,
      sessionId: t.sessionId,
      cwd: t.cwd,
      mission: t.mission,
    }));
  }

  /**
   * Check if terminal exists
   */
  hasTerminal(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  /**
   * Destroy all terminals
   */
  destroyAll(): void {
    for (const [id] of this.terminals) {
      this.destroyTerminal(id);
    }
  }

  /**
   * Snapshot current session directories for later diff
   */
  private async snapshotSessionDirs(): Promise<Set<string>> {
    try {
      const entries = await fsPromises.readdir(this.sessionStatePath);
      return new Set(entries.filter(e => this.isValidUUID(e)));
    } catch {
      return new Set();
    }
  }

  /**
   * Detect the session ID for a terminal started without one.
   * Polls for new session directories and matches by cwd.
   */
  private async detectSessionForTerminal(
    terminalId: string,
    cwd: string,
    snapshot: Set<string>
  ): Promise<void> {
    const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase();
    const maxAttempts = 5;
    const pollIntervalMs = 2000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

      // Terminal may have been destroyed while waiting
      if (!this.terminals.has(terminalId)) return;

      try {
        const currentEntries = await fsPromises.readdir(this.sessionStatePath);
        const newDirs = currentEntries.filter(e => this.isValidUUID(e) && !snapshot.has(e));

        for (const sessionId of newDirs) {
          const workspaceFile = path.join(this.sessionStatePath, sessionId, 'workspace.yaml');
          const metadata = this.readWorkspaceYaml(workspaceFile);
          if (!metadata?.cwd) continue;

          const sessionCwd = metadata.cwd.replace(/\\/g, '/').toLowerCase();
          if (sessionCwd === normalizedCwd) {
            // Match found — update terminal
            const session = this.terminals.get(terminalId);
            if (session) {
              session.sessionId = sessionId;
              console.log(`[TerminalService] Detected session ${sessionId} for terminal ${terminalId}`);
              this.emit('session-detected', { terminalId, sessionId });
            }
            return;
          }
        }
      } catch {
        // Ignore filesystem errors, try again
      }
    }

    console.log(`[TerminalService] Session detection timed out for terminal ${terminalId}`);
  }

  /**
   * Read workspace.yaml for session detection
   */
  private readWorkspaceYaml(filePath: string): { cwd?: string } | undefined {
    try {
      if (!fs.existsSync(filePath)) return undefined;
      const content = fs.readFileSync(filePath, 'utf-8');
      for (const line of content.split('\n')) {
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex).trim();
          if (key === 'cwd') {
            return { cwd: line.substring(colonIndex + 1).trim() };
          }
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private isValidUUID(str: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
  }
}
