/**
 * GitDiffService
 * 
 * Provides git diff and code changes information for session working directories.
 * Windows equivalent of macOS GitDiffService + CodeChangesState.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);
const fsPromises = fs.promises;

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
  oldLineNumber?: number;
  newLineNumber?: number;
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
      let oldLine = 1, newLine = 1;

      for (const line of lines) {
        if (line.startsWith('@@')) {
          // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
          const hunkMatch = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
          oldLine = hunkMatch ? parseInt(hunkMatch[1]) : 1;
          newLine = hunkMatch ? parseInt(hunkMatch[2]) : 1;
          currentHunk = { header: line, lines: [] };
          hunks.push(currentHunk);
        } else if (currentHunk) {
          if (line.startsWith('+') && !line.startsWith('+++')) {
            currentHunk.lines.push({ type: 'add', content: line.substring(1), newLineNumber: newLine });
            newLine++;
            adds++;
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            currentHunk.lines.push({ type: 'remove', content: line.substring(1), oldLineNumber: oldLine });
            oldLine++;
            dels++;
          } else if (line.startsWith(' ')) {
            currentHunk.lines.push({ type: 'context', content: line.substring(1), oldLineNumber: oldLine, newLineNumber: newLine });
            oldLine++;
            newLine++;
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

  /**
   * Read file content from the working tree
   */
  async readFileContent(cwd: string, filePath: string): Promise<{ lines: string[]; fullPath: string } | null> {
    const fullPath = path.resolve(cwd, filePath);
    try {
      const content = await fsPromises.readFile(fullPath, 'utf-8');
      return { lines: content.split('\n'), fullPath };
    } catch {
      return null;
    }
  }

  /**
   * Get full file content annotated with diff information.
   * Returns each line of the current file with its type (add/unchanged)
   * plus interleaved removed lines from the diff.
   */
  async getAnnotatedFile(
    cwd: string,
    filePath: string,
    mode: DiffMode = 'unstaged',
    baseBranch?: string
  ): Promise<{ lines: Array<{ lineNumber: number; content: string; type: 'add' | 'remove' | 'unchanged' }>; fullPath: string } | null> {
    // Read current file
    const fileData = await this.readFileContent(cwd, filePath);
    if (!fileData) return null;

    // Get diff for this specific file
    let cmd: string;
    switch (mode) {
      case 'staged': cmd = `git diff --cached -- "${filePath}"`; break;
      case 'branch': cmd = `git diff ${baseBranch || 'main'}...HEAD -- "${filePath}"`; break;
      default: cmd = `git diff -- "${filePath}"`;
    }

    let diffResult: DiffResult;
    try {
      const { stdout } = await execAsync(cmd, { cwd, timeout: 15000, maxBuffer: 5 * 1024 * 1024 });
      diffResult = this.parseDiff(stdout);
    } catch {
      // No diff — return file as all unchanged
      return {
        fullPath: fileData.fullPath,
        lines: fileData.lines.map((content, i) => ({ lineNumber: i + 1, content, type: 'unchanged' as const })),
      };
    }

    const fileDiff = diffResult.diffs[0];
    if (!fileDiff || fileDiff.hunks.length === 0) {
      return {
        fullPath: fileData.fullPath,
        lines: fileData.lines.map((content, i) => ({ lineNumber: i + 1, content, type: 'unchanged' as const })),
      };
    }

    // Build a set of added line numbers and a map of removed lines (keyed by "insert before" new-line)
    const addedLines = new Set<number>();
    const removedByNewLine = new Map<number, Array<{ content: string; oldLineNumber: number }>>();

    for (const hunk of fileDiff.hunks) {
      let nextNewLine = 0;
      for (const dl of hunk.lines) {
        if (dl.type === 'add') {
          addedLines.add(dl.newLineNumber!);
          nextNewLine = dl.newLineNumber! + 1;
        } else if (dl.type === 'remove') {
          // Group removed lines before the next context/add line
          const key = nextNewLine || (dl.oldLineNumber || 0);
          if (!removedByNewLine.has(key)) removedByNewLine.set(key, []);
          removedByNewLine.get(key)!.push({ content: dl.content, oldLineNumber: dl.oldLineNumber! });
        } else {
          nextNewLine = dl.newLineNumber! + 1;
        }
      }
    }

    // Build annotated output
    const result: Array<{ lineNumber: number; content: string; type: 'add' | 'remove' | 'unchanged' }> = [];

    for (let i = 0; i < fileData.lines.length; i++) {
      const lineNum = i + 1;
      // Insert removed lines that appear before this line
      const removed = removedByNewLine.get(lineNum);
      if (removed) {
        for (const r of removed) {
          result.push({ lineNumber: r.oldLineNumber, content: r.content, type: 'remove' });
        }
        removedByNewLine.delete(lineNum);
      }
      const type = addedLines.has(lineNum) ? 'add' as const : 'unchanged' as const;
      result.push({ lineNumber: lineNum, content: fileData.lines[i], type });
    }

    // Append any trailing removed lines
    for (const [, removed] of removedByNewLine) {
      for (const r of removed) {
        result.push({ lineNumber: r.oldLineNumber, content: r.content, type: 'remove' });
      }
    }

    return { fullPath: fileData.fullPath, lines: result };
  }
}
