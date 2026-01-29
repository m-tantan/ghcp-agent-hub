/**
 * CLISessionMonitorService
 * 
 * Service for monitoring GitHub Copilot CLI sessions.
 * Scans ~/.copilot/session-state/ for sessions.
 * Port of Swift CLISessionMonitorService for parity.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  CLISession,
  WorkspaceMetadata,
  WorktreeBranch,
  SelectedRepository,
} from '../models/types';
import { parseSessionFile } from './SessionEventsParser';

const execAsync = promisify(exec);

/**
 * CLI Session Monitor Service
 */
export class CLISessionMonitorService extends EventEmitter {
  private copilotDataPath: string;
  private selectedRepositories: SelectedRepository[] = [];

  constructor(copilotDataPath?: string) {
    super();
    this.copilotDataPath = copilotDataPath ?? this.getDefaultCopilotPath();
  }

  private getDefaultCopilotPath(): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    return path.join(home, '.copilot');
  }

  /**
   * Get session state path
   */
  getSessionStatePath(): string {
    return path.join(this.copilotDataPath, 'session-state');
  }

  /**
   * Add a repository to monitor
   */
  async addRepository(repoPath: string): Promise<SelectedRepository | undefined> {
    if (this.selectedRepositories.some(r => r.path === repoPath)) {
      return this.selectedRepositories.find(r => r.path === repoPath);
    }

    const worktrees = await this.detectWorktrees(repoPath);

    const repository: SelectedRepository = {
      path: repoPath,
      worktrees,
      isExpanded: true,
    };

    this.selectedRepositories.push(repository);
    await this.refreshSessions();

    return repository;
  }

  /**
   * Remove a repository from monitoring
   */
  removeRepository(repoPath: string): void {
    this.selectedRepositories = this.selectedRepositories.filter(r => r.path !== repoPath);
    this.emit('repositoriesChanged', this.selectedRepositories);
  }

  /**
   * Get selected repositories
   */
  getSelectedRepositories(): SelectedRepository[] {
    return this.selectedRepositories;
  }

  /**
   * Set selected repositories
   */
  async setSelectedRepositories(repositories: SelectedRepository[]): Promise<void> {
    this.selectedRepositories = repositories;
    await this.refreshSessions();
  }

  /**
   * Refresh sessions for all repositories
   */
  async refreshSessions(): Promise<void> {
    const allSessions = await this.scanAllSessions();

    // Filter sessions by selected repositories
    for (let repoIdx = 0; repoIdx < this.selectedRepositories.length; repoIdx++) {
      const repo = this.selectedRepositories[repoIdx];

      for (let wtIdx = 0; wtIdx < repo.worktrees.length; wtIdx++) {
        const worktree = repo.worktrees[wtIdx];

        // Find sessions matching this worktree
        const matchingSessions = allSessions.filter(session => {
          return session.projectPath === worktree.path ||
                 session.projectPath.startsWith(worktree.path + path.sep);
        });

        this.selectedRepositories[repoIdx].worktrees[wtIdx].sessions =
          matchingSessions.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
      }
    }

    this.emit('repositoriesChanged', this.selectedRepositories);
    this.emit('sessionsChanged', allSessions);
  }

  /**
   * Scan all sessions from session-state directory
   */
  async scanAllSessions(): Promise<CLISession[]> {
    const sessionStatePath = this.getSessionStatePath();

    if (!fs.existsSync(sessionStatePath)) {
      return [];
    }

    const sessions: CLISession[] = [];

    try {
      const sessionDirs = fs.readdirSync(sessionStatePath);

      for (const sessionId of sessionDirs) {
        // Skip non-UUID directories
        if (!this.isValidUUID(sessionId)) continue;

        const sessionDir = path.join(sessionStatePath, sessionId);
        const workspaceFile = path.join(sessionDir, 'workspace.yaml');
        const eventsFile = path.join(sessionDir, 'events.jsonl');

        // Read workspace metadata
        const metadata = this.readWorkspaceMetadata(workspaceFile);
        if (!metadata) continue;

        // Check if active
        let isActive = false;
        try {
          const stats = fs.statSync(eventsFile);
          const secondsAgo = (Date.now() - stats.mtime.getTime()) / 1000;
          isActive = secondsAgo < 60;
        } catch {
          // File doesn't exist or can't be read
        }

        // Parse events for message count and activities
        const parseResult = parseSessionFile(eventsFile);

        // Find first/last user message
        const userMessages = parseResult.recentActivities.filter(
          a => a.activityType.type === 'userMessage'
        );
        const firstMessage = userMessages[0]?.description;
        const lastMessage = userMessages[userMessages.length - 1]?.description;

        // Parse timestamps
        const createdAt = metadata.createdAt ? new Date(metadata.createdAt) : undefined;
        const updatedAt = metadata.updatedAt ? new Date(metadata.updatedAt) : undefined;

        const session: CLISession = {
          id: sessionId,
          projectPath: metadata.cwd,
          branchName: metadata.branch ?? 'main',
          isWorktree: false,
          lastActivityAt: updatedAt ?? parseResult.lastActivityAt ?? new Date(),
          messageCount: parseResult.messageCount,
          isActive,
          firstMessage,
          lastMessage,
          summary: metadata.summary,
        };

        sessions.push(session);
      }
    } catch (err) {
      console.error('Error scanning sessions:', err);
    }

    return sessions.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
  }

  /**
   * Detect worktrees for a repository
   */
  private async detectWorktrees(repoPath: string): Promise<WorktreeBranch[]> {
    try {
      const { stdout } = await execAsync('git worktree list --porcelain', {
        cwd: repoPath,
      });

      const worktrees: WorktreeBranch[] = [];
      let currentPath: string | undefined;
      let currentBranch: string | undefined;

      for (const line of stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
          currentPath = line.substring('worktree '.length);
        } else if (line.startsWith('branch refs/heads/')) {
          currentBranch = line.substring('branch refs/heads/'.length);
        } else if (line === '' && currentPath) {
          const isMainWorktree = currentPath === repoPath;
          worktrees.push({
            name: currentBranch ?? path.basename(currentPath),
            path: currentPath,
            isWorktree: !isMainWorktree,
            sessions: [],
            isExpanded: true,
          });
          currentPath = undefined;
          currentBranch = undefined;
        }
      }

      // Handle last entry
      if (currentPath) {
        const isMainWorktree = currentPath === repoPath;
        worktrees.push({
          name: currentBranch ?? path.basename(currentPath),
          path: currentPath,
          isWorktree: !isMainWorktree,
          sessions: [],
          isExpanded: true,
        });
      }

      if (worktrees.length === 0) {
        // No worktrees, use main repo
        const branch = await this.getCurrentBranch(repoPath);
        return [{
          name: branch ?? 'main',
          path: repoPath,
          isWorktree: false,
          sessions: [],
          isExpanded: true,
        }];
      }

      return worktrees;
    } catch {
      // Fallback
      const branch = await this.getCurrentBranch(repoPath);
      return [{
        name: branch ?? 'main',
        path: repoPath,
        isWorktree: false,
        sessions: [],
        isExpanded: true,
      }];
    }
  }

  /**
   * Get current git branch
   */
  private async getCurrentBranch(repoPath: string): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync('git branch --show-current', { cwd: repoPath });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Read workspace metadata from YAML file
   */
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

  /**
   * Check if string is valid UUID
   */
  private isValidUUID(str: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  }
}
