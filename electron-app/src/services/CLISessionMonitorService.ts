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
import { ConfigService, PersistedRepository } from './ConfigService';

const execAsync = promisify(exec);
const fsPromises = fs.promises;

/**
 * CLI Session Monitor Service
 */
export class CLISessionMonitorService extends EventEmitter {
  private copilotDataPath: string;
  private selectedRepositories: SelectedRepository[] = [];
  private configService: ConfigService | null = null;

  constructor(copilotDataPath?: string) {
    super();
    this.copilotDataPath = copilotDataPath ?? this.getDefaultCopilotPath();
  }

  /**
   * Set the config service for persistence
   */
  setConfigService(configService: ConfigService): void {
    this.configService = configService;
  }

  /**
   * Load saved repositories from config and restore them
   */
  async loadSavedRepositories(): Promise<void> {
    if (!this.configService) return;

    const savedRepos = this.configService.loadRepositories();
    for (const saved of savedRepos) {
      // Only restore if the path still exists
      if (fs.existsSync(saved.path)) {
        await this.addRepository(saved.path, false); // Don't save during load
        // Restore isExpanded state
        const repo = this.selectedRepositories.find(r => r.path === saved.path);
        if (repo) {
          repo.isExpanded = saved.isExpanded;
        }
      }
    }

    if (savedRepos.length > 0) {
      this.emit('repositoriesChanged', this.selectedRepositories);
    }
  }

  /**
   * Save current repositories to config
   */
  private saveRepositories(): void {
    if (!this.configService) return;

    const toSave: PersistedRepository[] = this.selectedRepositories.map(repo => ({
      path: repo.path,
      isExpanded: repo.isExpanded,
    }));

    this.configService.saveRepositories(toSave);
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
  async addRepository(repoPath: string, persist: boolean = true): Promise<SelectedRepository | undefined> {
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

    if (persist) {
      this.saveRepositories();
    }

    return repository;
  }

  /**
   * Remove a repository from monitoring
   */
  removeRepository(repoPath: string): void {
    this.selectedRepositories = this.selectedRepositories.filter(r => r.path !== repoPath);
    this.saveRepositories();
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

    // Re-detect worktrees for each repository so new ones appear
    for (let repoIdx = 0; repoIdx < this.selectedRepositories.length; repoIdx++) {
      const repo = this.selectedRepositories[repoIdx];
      const updatedWorktrees = await this.detectWorktrees(repo.path);
      this.selectedRepositories[repoIdx].worktrees = updatedWorktrees;
    }

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
   * Scan all sessions from session-state directory (async I/O)
   */
  async scanAllSessions(): Promise<CLISession[]> {
    const sessionStatePath = this.getSessionStatePath();

    if (!fs.existsSync(sessionStatePath)) {
      return [];
    }

    const sessions: CLISession[] = [];

    try {
      const sessionDirs = await fsPromises.readdir(sessionStatePath);

      await Promise.all(sessionDirs.map(async (sessionId) => {
        // Skip non-UUID directories
        if (!this.isValidUUID(sessionId)) return;

        const sessionDir = path.join(sessionStatePath, sessionId);
        const workspaceFile = path.join(sessionDir, 'workspace.yaml');
        const eventsFile = path.join(sessionDir, 'events.jsonl');

        // Read workspace metadata
        const metadata = this.readWorkspaceMetadata(workspaceFile);
        if (!metadata) return;

        // Check if active (async stat)
        let isActive = false;
        try {
          const stats = await fsPromises.stat(eventsFile);
          const secondsAgo = (Date.now() - stats.mtime.getTime()) / 1000;
          isActive = secondsAgo < 60;
        } catch {
          // File doesn't exist or can't be read
        }

        // parseSessionFile uses its own incremental cache — cheap when file unchanged
        const parseResult = parseSessionFile(eventsFile);

        // Find first/last user message
        const userMessages = parseResult.recentActivities.filter(
          a => a.activityType.type === 'userMessage'
        );
        const firstMessage = userMessages[0]?.description;

        // Parse timestamps
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
          lastMessage: undefined,
          summary: metadata.summary,
        };

        sessions.push(session);
      }));
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
      let isFirst = true;

      const pushEntry = () => {
        if (!currentPath) return;
        // First entry from `git worktree list` is always the main worktree
        const isMainWorktree = isFirst ||
          currentPath.toLowerCase() === repoPath.toLowerCase();
        isFirst = false;
        worktrees.push({
          name: currentBranch ?? path.basename(currentPath),
          path: currentPath,
          isWorktree: !isMainWorktree,
          sessions: [],
          isExpanded: true,
        });
        currentPath = undefined;
        currentBranch = undefined;
      };

      for (const line of stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
          currentPath = line.substring('worktree '.length);
        } else if (line.startsWith('branch refs/heads/')) {
          currentBranch = line.substring('branch refs/heads/'.length);
        } else if (line === '' && currentPath) {
          pushEntry();
        }
      }

      // Handle last entry
      pushEntry();

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
