/**
 * GlobalSearchService
 * 
 * Deep full-text search across all session events.jsonl files.
 * Windows equivalent of macOS GlobalSearchService.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

export interface SearchResult {
  sessionId: string;
  matchType: 'message' | 'tool' | 'summary';
  text: string;
  timestamp?: Date;
  score: number;
}

export class GlobalSearchService {
  private copilotPath: string;

  constructor(copilotPath?: string) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    this.copilotPath = copilotPath ?? path.join(home, '.copilot');
  }

  /**
   * Search across all session event files for matching text
   */
  async search(query: string, maxResults: number = 50): Promise<SearchResult[]> {
    if (!query || query.length < 2) return [];

    const sessionStateDir = path.join(this.copilotPath, 'session-state');
    if (!fs.existsSync(sessionStateDir)) return [];

    const results: SearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    try {
      const entries = fs.readdirSync(sessionStateDir, { withFileTypes: true });
      const sessionDirs = entries.filter(e => e.isDirectory() && this.isUUID(e.name));

      for (const dir of sessionDirs) {
        if (results.length >= maxResults) break;

        const eventsFile = path.join(sessionStateDir, dir.name, 'events.jsonl');
        if (!fs.existsSync(eventsFile)) continue;

        const sessionResults = await this.searchSessionFile(dir.name, eventsFile, lowerQuery);
        results.push(...sessionResults);
      }
    } catch {
      // Ignore filesystem errors
    }

    // Sort by score descending, then by timestamp
    results.sort((a, b) => b.score - a.score || (b.timestamp?.getTime() ?? 0) - (a.timestamp?.getTime() ?? 0));
    return results.slice(0, maxResults);
  }

  private async searchSessionFile(sessionId: string, filePath: string, query: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          const matches = this.matchEvent(event, query, sessionId);
          results.push(...matches);
        } catch {
          // Skip unparseable lines
        }
      }
    } catch {
      // File read error
    }

    return results;
  }

  private matchEvent(event: any, query: string, sessionId: string): SearchResult[] {
    const results: SearchResult[] = [];
    const timestamp = event.timestamp ? new Date(event.timestamp) : undefined;

    // Search in assistant messages
    if (event.type === 'assistant' && event.data?.message) {
      const text = String(event.data.message);
      if (text.toLowerCase().includes(query)) {
        results.push({
          sessionId,
          matchType: 'message',
          text: this.truncateAroundMatch(text, query, 150),
          timestamp,
          score: 10,
        });
      }
    }

    // Search in user messages
    if (event.type === 'human' && event.data?.message) {
      const text = String(event.data.message);
      if (text.toLowerCase().includes(query)) {
        results.push({
          sessionId,
          matchType: 'message',
          text: this.truncateAroundMatch(text, query, 150),
          timestamp,
          score: 15, // User messages are higher priority
        });
      }
    }

    // Search in tool results
    if (event.type === 'tool_result' && event.data?.output) {
      const text = String(event.data.output);
      if (text.toLowerCase().includes(query)) {
        results.push({
          sessionId,
          matchType: 'tool',
          text: this.truncateAroundMatch(text, query, 150),
          timestamp,
          score: 5,
        });
      }
    }

    // Search in summary
    if (event.type === 'summary' && event.data?.summary) {
      const text = String(event.data.summary);
      if (text.toLowerCase().includes(query)) {
        results.push({
          sessionId,
          matchType: 'summary',
          text: this.truncateAroundMatch(text, query, 150),
          timestamp,
          score: 20,
        });
      }
    }

    return results;
  }

  private truncateAroundMatch(text: string, query: string, maxLen: number): string {
    const lower = text.toLowerCase();
    const idx = lower.indexOf(query);
    if (idx === -1) return text.substring(0, maxLen);

    const start = Math.max(0, idx - 60);
    const end = Math.min(text.length, idx + query.length + 60);
    let snippet = text.substring(start, end);
    if (start > 0) snippet = '...' + snippet;
    if (end < text.length) snippet += '...';
    return snippet;
  }

  private isUUID(str: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
  }
}
