/**
 * GlobalStatsService
 * 
 * Aggregates token usage and cost statistics across all monitored sessions.
 * Windows equivalent of macOS GlobalStatsService.
 */

import { SessionMonitorState } from '../models/types';

export interface SessionStats {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model?: string;
  messageCount: number;
}

export interface GlobalStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  estimatedCostUsd: number;
  sessionCount: number;
  activeSessionCount: number;
  totalMessages: number;
  perSession: SessionStats[];
  modelBreakdown: Record<string, { inputTokens: number; outputTokens: number; cost: number }>;
}

// Approximate pricing per million tokens (Sonnet-class defaults)
const PRICING: Record<string, { input: number; output: number }> = {
  'default':  { input: 3.0, output: 15.0 },
  'sonnet':   { input: 3.0, output: 15.0 },
  'opus':     { input: 15.0, output: 75.0 },
  'haiku':    { input: 0.25, output: 1.25 },
  'gpt-4':    { input: 10.0, output: 30.0 },
  'gpt-4o':   { input: 2.5, output: 10.0 },
};

function getPricing(model?: string): { input: number; output: number } {
  if (!model) return PRICING['default'];
  const lower = model.toLowerCase();
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (lower.includes(key)) return pricing;
  }
  return PRICING['default'];
}

function estimateCost(inputTokens: number, outputTokens: number, model?: string): number {
  const pricing = getPricing(model);
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

export class GlobalStatsService {
  private sessionStats: Map<string, SessionStats> = new Map();

  /**
   * Update stats for a session from its monitor state
   */
  updateSession(sessionId: string, state: SessionMonitorState): void {
    this.sessionStats.set(sessionId, {
      sessionId,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      totalOutputTokens: state.totalOutputTokens,
      cacheReadTokens: state.cacheReadTokens,
      cacheCreationTokens: state.cacheCreationTokens,
      model: state.model,
      messageCount: state.messageCount,
    });
  }

  /**
   * Remove a session from tracking
   */
  removeSession(sessionId: string): void {
    this.sessionStats.delete(sessionId);
  }

  /**
   * Get aggregated global stats
   */
  getGlobalStats(activeSessionIds?: Set<string>): GlobalStats {
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreation = 0;
    let totalMessages = 0, activeCount = 0;
    const modelBreakdown: GlobalStats['modelBreakdown'] = {};
    const perSession: SessionStats[] = [];

    for (const [id, stats] of this.sessionStats) {
      totalInput += stats.inputTokens;
      totalOutput += stats.totalOutputTokens;
      totalCacheRead += stats.cacheReadTokens;
      totalCacheCreation += stats.cacheCreationTokens;
      totalMessages += stats.messageCount;
      perSession.push(stats);

      if (activeSessionIds?.has(id)) activeCount++;

      // Model breakdown
      const modelKey = stats.model || 'unknown';
      if (!modelBreakdown[modelKey]) {
        modelBreakdown[modelKey] = { inputTokens: 0, outputTokens: 0, cost: 0 };
      }
      modelBreakdown[modelKey].inputTokens += stats.inputTokens;
      modelBreakdown[modelKey].outputTokens += stats.totalOutputTokens;
      modelBreakdown[modelKey].cost += estimateCost(stats.inputTokens, stats.totalOutputTokens, stats.model);
    }

    return {
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCacheReadTokens: totalCacheRead,
      totalCacheCreationTokens: totalCacheCreation,
      estimatedCostUsd: estimateCost(totalInput, totalOutput),
      sessionCount: this.sessionStats.size,
      activeSessionCount: activeCount,
      totalMessages,
      perSession,
      modelBreakdown,
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
