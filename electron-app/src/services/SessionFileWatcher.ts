/**
 * SessionFileWatcher
 * 
 * Watches Copilot CLI session files for real-time monitoring.
 * Uses chokidar for cross-platform file watching.
 * Port of Swift SessionFileWatcher for parity.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { EventEmitter } from 'events';
import {
  SessionMonitorState,
  WorkspaceMetadata,
  PendingToolUse,
} from '../models/types';
import {
  ParseResult,
  parseSessionFile,
  parseNewLines,
  updateCurrentStatus,
} from './SessionEventsParser';

/**
 * State update event
 */
export interface StateUpdate {
  sessionId: string;
  state: SessionMonitorState;
}

/**
 * File watcher info (internal)
 */
interface FileWatcherInfo {
  eventsFilePath: string;
  workspaceFilePath: string;
  watcher: chokidar.FSWatcher;
  statusInterval: NodeJS.Timeout;
  parseResult: ParseResult;
  metadata?: WorkspaceMetadata;
  lastKnownFileSize: number;
}

/**
 * SessionFileWatcher - watches session files for real-time updates
 */
export class SessionFileWatcher extends EventEmitter {
  private watchedSessions: Map<string, FileWatcherInfo> = new Map();
  private copilotPath: string;
  private approvalTimeoutSeconds: number = 5;

  constructor(copilotPath?: string) {
    super();
    this.copilotPath = copilotPath ?? this.getDefaultCopilotPath();
  }

  private getDefaultCopilotPath(): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    return path.join(home, '.copilot');
  }

  /**
   * Set approval timeout in seconds
   */
  setApprovalTimeout(seconds: number): void {
    this.approvalTimeoutSeconds = Math.max(1, seconds);
  }

  /**
   * Get current approval timeout
   */
  getApprovalTimeout(): number {
    return this.approvalTimeoutSeconds;
  }

  /**
   * Start monitoring a session
   */
  startMonitoring(sessionId: string): void {
    // If already monitoring, re-emit current state
    if (this.watchedSessions.has(sessionId)) {
      const info = this.watchedSessions.get(sessionId)!;
      const state = this.buildMonitorState(info.parseResult, info.metadata);
      this.emit('stateUpdate', { sessionId, state } as StateUpdate);
      return;
    }

    const sessionDir = path.join(this.copilotPath, 'session-state', sessionId);
    const eventsFile = path.join(sessionDir, 'events.jsonl');
    const workspaceFile = path.join(sessionDir, 'workspace.yaml');

    if (!fs.existsSync(eventsFile)) {
      console.warn(`Events file not found: ${eventsFile}`);
      return;
    }

    // Read workspace metadata
    const metadata = this.readWorkspaceMetadata(workspaceFile);

    // Initial parse
    let parseResult = parseSessionFile(eventsFile, this.approvalTimeoutSeconds);

    // Merge metadata
    if (metadata) {
      parseResult.gitBranch = parseResult.gitBranch ?? metadata.branch;
      parseResult.summary = metadata.summary;
      parseResult.cwd = parseResult.cwd ?? metadata.cwd;
    }

    // Emit initial state
    const initialState = this.buildMonitorState(parseResult, metadata);
    this.emit('stateUpdate', { sessionId, state: initialState } as StateUpdate);

    // Get initial file size
    let lastKnownFileSize = this.getFileSize(eventsFile);

    // Set up file watcher using chokidar
    const watcher = chokidar.watch(eventsFile, {
      persistent: true,
      usePolling: true,  // More reliable on Windows
      interval: 500,
    });

    watcher.on('change', () => {
      const newLines = this.readNewLines(eventsFile, lastKnownFileSize);
      lastKnownFileSize = this.getFileSize(eventsFile);

      if (newLines.length > 0) {
        parseNewLines(newLines, parseResult, this.approvalTimeoutSeconds);
        const updatedState = this.buildMonitorState(parseResult, metadata);
        this.emit('stateUpdate', { sessionId, state: updatedState } as StateUpdate);
      }
    });

    // Status timer for timeout-based updates (every second)
    const statusInterval = setInterval(() => {
      const previousStatus = parseResult.currentStatus;
      updateCurrentStatus(parseResult, this.approvalTimeoutSeconds);

      // Only emit if status changed
      if (JSON.stringify(previousStatus) !== JSON.stringify(parseResult.currentStatus)) {
        const updatedState = this.buildMonitorState(parseResult, metadata);
        this.emit('stateUpdate', { sessionId, state: updatedState } as StateUpdate);
      }
    }, 1000);

    // Store watcher info
    this.watchedSessions.set(sessionId, {
      eventsFilePath: eventsFile,
      workspaceFilePath: workspaceFile,
      watcher,
      statusInterval,
      parseResult,
      metadata,
      lastKnownFileSize,
    });
  }

  /**
   * Stop monitoring a session
   */
  stopMonitoring(sessionId: string): void {
    const info = this.watchedSessions.get(sessionId);
    if (!info) return;

    info.watcher.close();
    clearInterval(info.statusInterval);
    this.watchedSessions.delete(sessionId);
  }

  /**
   * Stop all monitoring
   */
  stopAll(): void {
    for (const sessionId of this.watchedSessions.keys()) {
      this.stopMonitoring(sessionId);
    }
  }

  /**
   * Get current state for a session
   */
  getState(sessionId: string): SessionMonitorState | undefined {
    const info = this.watchedSessions.get(sessionId);
    if (!info) return undefined;
    return this.buildMonitorState(info.parseResult, info.metadata);
  }

  /**
   * Check if monitoring a session
   */
  isMonitoring(sessionId: string): boolean {
    return this.watchedSessions.has(sessionId);
  }

  /**
   * Force refresh a session's state
   */
  refreshState(sessionId: string): void {
    const info = this.watchedSessions.get(sessionId);
    if (!info) return;

    const parseResult = parseSessionFile(info.eventsFilePath, this.approvalTimeoutSeconds);
    info.parseResult = parseResult;

    const state = this.buildMonitorState(parseResult, info.metadata);
    this.emit('stateUpdate', { sessionId, state } as StateUpdate);
  }

  // --- Private helpers ---

  private getFileSize(filePath: string): number {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  private readNewLines(filePath: string, startPosition: number): string[] {
    try {
      const fd = fs.openSync(filePath, 'r');
      const stats = fs.fstatSync(fd);
      const newSize = stats.size;

      if (newSize <= startPosition) {
        fs.closeSync(fd);
        return [];
      }

      const buffer = Buffer.alloc(newSize - startPosition);
      fs.readSync(fd, buffer, 0, buffer.length, startPosition);
      fs.closeSync(fd);

      const content = buffer.toString('utf-8');
      return content.split('\n').filter(line => line.trim());
    } catch {
      return [];
    }
  }

  private readWorkspaceMetadata(filePath: string): WorkspaceMetadata | undefined {
    if (!fs.existsSync(filePath)) return undefined;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const dict: Record<string, string> = {};

      for (const line of content.split('\n')) {
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex).trim();
          const value = line.substring(colonIndex + 1).trim();
          dict[key] = value;
        }
      }

      if (!dict.id || !dict.cwd) return undefined;

      return {
        id: dict.id,
        cwd: dict.cwd,
        gitRoot: dict.git_root,
        repository: dict.repository,
        branch: dict.branch,
        summary: dict.summary,
        summaryCount: dict.summary_count ? parseInt(dict.summary_count, 10) : undefined,
        createdAt: dict.created_at,
        updatedAt: dict.updated_at,
      };
    } catch {
      return undefined;
    }
  }

  private buildMonitorState(
    result: ParseResult,
    metadata?: WorkspaceMetadata
  ): SessionMonitorState {
    // Convert pending tool uses
    let pendingToolUse: PendingToolUse | undefined;
    const firstPending = result.pendingToolUses.entries().next().value;
    if (firstPending) {
      const [, pending] = firstPending;
      pendingToolUse = {
        toolName: pending.toolName,
        toolCallId: pending.toolCallId,
        timestamp: pending.timestamp,
        input: pending.input,
        codeChangeInput: pending.codeChangeInput,
      };
    }

    return {
      status: result.currentStatus,
      currentTool: pendingToolUse?.toolName,
      lastActivityAt: result.lastActivityAt ?? new Date(),
      inputTokens: result.lastInputTokens,
      outputTokens: result.lastOutputTokens,
      totalOutputTokens: result.totalOutputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheCreationTokens: result.cacheCreationTokens,
      messageCount: result.messageCount,
      toolCalls: result.toolCalls,
      sessionStartedAt: result.sessionStartedAt,
      model: result.model,
      gitBranch: result.gitBranch ?? metadata?.branch,
      pendingToolUse,
      recentActivities: result.recentActivities,
    };
  }
}
