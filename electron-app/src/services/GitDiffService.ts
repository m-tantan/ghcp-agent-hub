/**
 * GitDiffService
 * 
 * Provides git diff and code changes information for session working directories.
 * Windows equivalent of macOS GitDiffService + CodeChangesState.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  lineNumber?: number;
}

export interface FileDiff {
  filePath: string;
  hunks: DiffHunk[];
}

export interface DiffResult {
  files: DiffFile[];
  diffs: FileDiff[];
  summary: { additions: number; deletions: number; filesChanged: number };
}

export type DiffMode = 'unstaged' | 'staged' | 'branch';

export class GitDiffService {
  /**
   * Get code changes summary (file list with stats)
   */
  async getCodeChanges(cwd: string): Promise<DiffFile[]> {
    const files: DiffFile[] = [];

    try {
      // Get both staged and unstaged changes
      const { stdout: statusOut } = await execAsync('git status --porcelain', { cwd, timeout: 10000 });
      for (const line of statusOut.split('\n').filter(l => l.trim())) {
        const status = line.substring(0, 2);
        const filePath = line.substring(3).trim();
        let fileStatus: DiffFile['status'] = 'modified';
        if (status.includes('A') || status === '??') fileStatus = 'added';
        else if (status.includes('D')) fileStatus = 'deleted';
        else if (status.includes('R')) fileStatus = 'renamed';
        files.push({ path: filePath, additions: 0, deletions: 0, status: fileStatus });
      }

      // Get diff stat for counts
      const { stdout: statOut } = await execAsync('git diff --numstat HEAD', { cwd, timeout: 10000 }).catch(() => ({ stdout: '' }));
      for (const line of statOut.split('\n').filter(l => l.trim())) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          const adds = parseInt(parts[0]) || 0;
          const dels = parseInt(parts[1]) || 0;
          const fpath = parts[2];
          const existing = files.find(f => f.path === fpath);
          if (existing) {
            existing.additions = adds;
            existing.deletions = dels;
          }
        }
      }
    } catch {
      // Not a git repo or git not available
    }

    return files;
  }

  /**
   * Get full diff output
   */
  async getDiff(cwd: string, mode: DiffMode = 'unstaged', baseBranch?: string): Promise<DiffResult> {
    let cmd: string;
    switch (mode) {
      case 'staged':
        cmd = 'git diff --cached';
        break;
      case 'branch':
        cmd = `git diff ${baseBranch || 'main'}...HEAD`;
        break;
      default:
        cmd = 'git diff';
    }

    try {
      const { stdout } = await execAsync(cmd, { cwd, timeout: 15000, maxBuffer: 5 * 1024 * 1024 });
      return this.parseDiff(stdout);
    } catch {
      return { files: [], diffs: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } };
    }
  }

  /**
   * Parse unified diff output into structured data
   */
  private parseDiff(raw: string): DiffResult {
    const diffs: FileDiff[] = [];
    const files: DiffFile[] = [];
    let totalAdds = 0, totalDels = 0;

    if (!raw.trim()) {
      return { files, diffs, summary: { additions: 0, deletions: 0, filesChanged: 0 } };
    }

    const fileSections = raw.split(/^diff --git /m).filter(s => s.trim());

    for (const section of fileSections) {
      const lines = section.split('\n');
      // Extract file path from "a/path b/path"
      const headerMatch = lines[0]?.match(/a\/(.+?) b\/(.+)/);
      const filePath = headerMatch ? headerMatch[2] : 'unknown';

      let status: DiffFile['status'] = 'modified';
      if (section.includes('new file mode')) status = 'added';
      else if (section.includes('deleted file mode')) status = 'deleted';
      else if (section.includes('rename from')) status = 'renamed';

      const hunks: DiffHunk[] = [];
      let currentHunk: DiffHunk | null = null;
      let adds = 0, dels = 0;

      for (const line of lines) {
        if (line.startsWith('@@')) {
          currentHunk = { header: line, lines: [] };
          hunks.push(currentHunk);
        } else if (currentHunk) {
          if (line.startsWith('+') && !line.startsWith('+++')) {
            currentHunk.lines.push({ type: 'add', content: line.substring(1) });
            adds++;
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            currentHunk.lines.push({ type: 'remove', content: line.substring(1) });
            dels++;
          } else if (line.startsWith(' ')) {
            currentHunk.lines.push({ type: 'context', content: line.substring(1) });
          }
        }
      }

      totalAdds += adds;
      totalDels += dels;
      files.push({ path: filePath, additions: adds, deletions: dels, status });
      diffs.push({ filePath, hunks });
    }

    return {
      files,
      diffs,
      summary: { additions: totalAdds, deletions: totalDels, filesChanged: files.length },
    };
  }
}
