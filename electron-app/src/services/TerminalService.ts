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

  constructor() {
    super();
    this._isAvailable = pty !== null;
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
  createTerminal(
    terminalId: string,
    cwd: string,
    copilotPath?: string,
    copilotSessionId?: string,
    mission?: string,
    copilotCommand?: string,
    skipCopilot?: boolean
  ): string | null {
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
}
