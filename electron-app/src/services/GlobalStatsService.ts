/**
 * GlobalStatsService
 * 
 * Aggregates activity statistics across all monitored sessions.
 * Token data is not available in Copilot CLI event files; stats focus on
 * messages, tool usage, and session activity.
 */

import { SessionMonitorState } from '../models/types';

export interface SessionStats {
  sessionId: string;
  messageCount: number;
  toolCalls: Record<string, number>;
  totalToolCallCount: number;
  cwd?: string;
  summary?: string;
  startedAt?: Date;
  lastActivityAt?: Date;
  durationMs?: number;
}

export interface GlobalStats {
  sessionCount: number;
  totalMessages: number;
  totalToolCalls: number;
  avgMessagesPerSession: number;
  avgDurationMs: number;
  toolBreakdown: Record<string, number>;
  repoBreakdown: Record<string, { sessionCount: number; messageCount: number }>;
  perSession: SessionStats[];
  // Legacy fields kept at 0 for tray menu compat
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  activeSessionCount: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
}

export class GlobalStatsService {
  private sessionStats: Map<string, SessionStats> = new Map();

  /**
   * Update stats for a session from its monitor state (live watcher updates)
   */
  updateSession(sessionId: string, state: SessionMonitorState): void {
    const existing = this.sessionStats.get(sessionId);
    this.sessionStats.set(sessionId, {
      sessionId,
      messageCount: state.messageCount,
      toolCalls: state.toolCalls ?? {},
      totalToolCallCount: Object.values(state.toolCalls ?? {}).reduce((a, b) => a + b, 0),
      cwd: existing?.cwd,
      summary: existing?.summary,
      startedAt: state.sessionStartedAt ?? existing?.startedAt,
      lastActivityAt: state.lastActivityAt,
      durationMs: state.sessionStartedAt && state.lastActivityAt
        ? state.lastActivityAt.getTime() - state.sessionStartedAt.getTime()
        : existing?.durationMs,
    });
  }

  /**
   * Remove a session from tracking
   */
  removeSession(sessionId: string): void {
    this.sessionStats.delete(sessionId);
  }

  /**
   * Clear all tracked sessions (used before a full rescan)
   */
  clearAll(): void {
    this.sessionStats.clear();
  }

  /**
   * Set stats for a session directly from scan data
   */
  setSessionStats(sessionId: string, data: Omit<SessionStats, 'sessionId'>): void {
    this.sessionStats.set(sessionId, { sessionId, ...data });
  }

  /**
   * Get aggregated global stats
   */
  getGlobalStats(): GlobalStats {
    let totalMessages = 0, totalToolCalls = 0, totalDurationMs = 0, sessionWithDuration = 0;
    const toolBreakdown: Record<string, number> = {};
    const repoBreakdown: Record<string, { sessionCount: number; messageCount: number }> = {};
    const perSession: SessionStats[] = [];

    for (const [, stats] of this.sessionStats) {
      totalMessages += stats.messageCount;
      totalToolCalls += stats.totalToolCallCount;
      perSession.push(stats);

      if (stats.durationMs && stats.durationMs > 0) {
        totalDurationMs += stats.durationMs;
        sessionWithDuration++;
      }

      // Tool breakdown
      for (const [tool, count] of Object.entries(stats.toolCalls)) {
        toolBreakdown[tool] = (toolBreakdown[tool] ?? 0) + count;
      }

      // Repo breakdown (use last path segment of cwd as repo name)
      if (stats.cwd) {
        const repo = stats.cwd.split(/[/\\]/).pop() ?? stats.cwd;
        if (!repoBreakdown[repo]) repoBreakdown[repo] = { sessionCount: 0, messageCount: 0 };
        repoBreakdown[repo].sessionCount++;
        repoBreakdown[repo].messageCount += stats.messageCount;
      }
    }

    const count = this.sessionStats.size;
    return {
      sessionCount: count,
      totalMessages,
      totalToolCalls,
      avgMessagesPerSession: count > 0 ? Math.round(totalMessages / count) : 0,
      avgDurationMs: sessionWithDuration > 0 ? Math.round(totalDurationMs / sessionWithDuration) : 0,
      toolBreakdown,
      repoBreakdown,
      perSession,
      // Legacy zero fields
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUsd: 0,
      activeSessionCount: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    };
  }

  /**
   * Format token count for display (e.g., "10.5M", "1.2K")
   */
  static formatTokens(count: number): string {
    if (count >= 1_000_000) return (count / 1_000_000).toFixed(1) + 'M';
    if (count >= 1_000) return (count / 1_000).toFixed(1) + 'K';
    return count.toString();
  }

  /**
   * Format cost for display
   */
  static formatCost(usd: number): string {
    if (usd < 0.01) return '<$0.01';
    return '$' + usd.toFixed(2);
  }
}
