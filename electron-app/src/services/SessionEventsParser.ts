/**
 * SessionEventsParser
 * 
 * Parser for GitHub Copilot CLI events.jsonl files.
 * Port of the Swift SessionEventsParser for parity with macOS version.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  SessionStatus,
  ActivityEntry,
  ActivityType,
  CodeChangeInput,
  PendingToolUse,
  PendingUserQuestion,
} from '../models/types';

/** Per-file parse cache keyed by absolute path */
interface ParseCache {
  result: ParseResult;
  mtime: number;
  size: number;
}
const _parseCache = new Map<string, ParseCache>();

/**
 * Raw event from Copilot events.jsonl
 */
interface SessionEvent {
  type: string;
  data?: Record<string, unknown>;
  id?: string;
  timestamp?: string;
  parentId?: string | null;
}

/**
 * Pending tool info (internal)
 */
interface PendingToolInfo {
  toolName: string;
  toolCallId: string;
  timestamp: Date;
  input?: string;
  codeChangeInput?: CodeChangeInput;
}

/**
 * Parse result - aggregated session state
 */
export interface ParseResult {
  model?: string;
  lastInputTokens: number;
  lastOutputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  messageCount: number;
  toolCalls: Record<string, number>;
  pendingToolUses: Map<string, PendingToolInfo>;
  pendingQuestion?: PendingUserQuestion;
  recentActivities: ActivityEntry[];
  lastActivityAt?: Date;
  sessionStartedAt?: Date;
  currentStatus: SessionStatus;
  gitBranch?: string;
  summary?: string;
  cwd?: string;
  copilotVersion?: string;
}

/**
 * Create empty parse result
 */
function createEmptyResult(): ParseResult {
  return {
    lastInputTokens: 0,
    lastOutputTokens: 0,
    totalOutputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    messageCount: 0,
    toolCalls: {},
    pendingToolUses: new Map(),
    recentActivities: [],
    currentStatus: { type: 'idle' },
  };
}

/**
 * Parse ISO8601 timestamp
 */
function parseTimestamp(ts?: string): Date | undefined {
  if (!ts) return undefined;
  try {
    return new Date(ts);
  } catch {
    return undefined;
  }
}

/**
 * Parse a single event line
 */
export function parseEvent(line: string): SessionEvent | null {
  try {
    return JSON.parse(line) as SessionEvent;
  } catch {
    return null;
  }
}

/**
 * Extract input preview from tool arguments
 */
function extractInputPreview(args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;

  // Common patterns (mirrors Swift implementation)
  if (typeof args.file_path === 'string') {
    return path.basename(args.file_path);
  }
  if (typeof args.path === 'string') {
    return path.basename(args.path);
  }
  if (typeof args.command === 'string') {
    return (args.command as string).substring(0, 50);
  }
  if (typeof args.pattern === 'string') {
    return args.pattern as string;
  }
  if (typeof args.query === 'string') {
    return (args.query as string).substring(0, 50);
  }
  if (typeof args.intent === 'string') {
    return (args.intent as string).substring(0, 50);
  }

  return undefined;
}

/**
 * Extract code change input for edit/write tools
 */
function extractCodeChangeInput(
  name: string,
  args?: Record<string, unknown>
): CodeChangeInput | undefined {
  if (!args) return undefined;

  const filePath = (args.file_path ?? args.path) as string | undefined;
  if (!filePath) return undefined;

  const nameLower = name.toLowerCase();

  if (nameLower === 'edit') {
    return {
      toolType: 'edit',
      filePath,
      oldString: (args.old_string ?? args.old_str) as string | undefined,
      newString: (args.new_string ?? args.new_str) as string | undefined,
      replaceAll: args.replace_all as boolean | undefined,
    };
  }

  if (nameLower === 'write' || nameLower === 'create') {
    return {
      toolType: 'write',
      filePath,
      newString: (args.content ?? args.file_text) as string | undefined,
    };
  }

  if (nameLower === 'multiedit' || nameLower === 'multi_edit') {
    const edits = args.edits as Array<Record<string, unknown>> | undefined;
    return {
      toolType: 'multiEdit',
      filePath,
      edits: edits?.map(e => ({
        old_string: e.old_string as string | undefined,
        new_string: e.new_string as string | undefined,
        replace_all: e.replace_all?.toString(),
      })),
    };
  }

  return undefined;
}

/**
 * Add activity to result (keeps last 100)
 */
function addActivity(
  result: ParseResult,
  activityType: ActivityType,
  description: string,
  timestamp?: Date,
  codeChangeInput?: CodeChangeInput
): void {
  result.recentActivities.push({
    timestamp: timestamp ?? new Date(),
    activityType,
    description,
    toolInput: codeChangeInput,
  });

  // Keep only last 100 activities (mirrors Swift implementation)
  if (result.recentActivities.length > 100) {
    result.recentActivities = result.recentActivities.slice(-100);
  }
}

/**
 * Process a single event into the result
 */
function processEvent(event: SessionEvent, result: ParseResult): void {
  const timestamp = parseTimestamp(event.timestamp);
  const data = event.data ?? {};

  // Track timestamps
  if (timestamp) {
    if (!result.sessionStartedAt) {
      result.sessionStartedAt = timestamp;
    }
    result.lastActivityAt = timestamp;
  }

  // Process by event type (mirrors Swift implementation)
  switch (event.type) {
    case 'session.start': {
      const context = data.context as Record<string, unknown> | undefined;
      if (context) {
        result.gitBranch = context.branch as string | undefined;
        result.cwd = context.cwd as string | undefined;
      }
      result.copilotVersion = data.copilotVersion as string | undefined;
      break;
    }

    case 'user.message': {
      result.messageCount++;
      const content = (data.content as string) ?? '';
      if (content) {
        addActivity(result, { type: 'userMessage' }, content.substring(0, 80), timestamp);
      }
      break;
    }

    case 'assistant.turn_start': {
      addActivity(result, { type: 'thinking' }, 'Thinking...', timestamp);
      break;
    }

    case 'assistant.message': {
      result.messageCount++;

      // Extract model
      if (data.model) {
        result.model = data.model as string;
      }

      // Process tool requests
      const toolRequests = data.toolRequests as Array<Record<string, unknown>> | undefined;
      if (toolRequests) {
        for (const toolReq of toolRequests) {
          const name = toolReq.name as string | undefined;
          const toolCallId = toolReq.toolCallId as string | undefined;

          if (name && toolCallId) {
            // Track tool call count
            result.toolCalls[name] = (result.toolCalls[name] ?? 0) + 1;

            // Extract input
            const args = toolReq.arguments as Record<string, unknown> | undefined;
            const inputPreview = extractInputPreview(args);
            const codeChangeInput = extractCodeChangeInput(name, args);

            // Check for ask_user tool - track pending question
            if (name === 'ask_user' && args) {
              result.pendingQuestion = {
                toolCallId,
                question: (args.question as string) ?? 'Question',
                choices: args.choices as string[] | undefined,
                timestamp: timestamp ?? new Date(),
              };
            }

            // Add to pending
            result.pendingToolUses.set(toolCallId, {
              toolName: name,
              toolCallId,
              timestamp: timestamp ?? new Date(),
              input: inputPreview,
              codeChangeInput,
            });

            addActivity(
              result,
              { type: 'toolUse', name },
              inputPreview ?? name,
              timestamp,
              codeChangeInput
            );
          }
        }
      }

      // Check for text content
      const content = data.content as string | undefined;
      if (content) {
        addActivity(result, { type: 'assistantMessage' }, content.substring(0, 50), timestamp);
      }
      break;
    }

    case 'tool.result': {
      const toolCallId = data.toolCallId as string | undefined;
      if (toolCallId) {
        const pending = result.pendingToolUses.get(toolCallId);
        const toolName = pending?.toolName ?? 'unknown';
        result.pendingToolUses.delete(toolCallId);

        // Clear pending question if this was the ask_user response
        if (result.pendingQuestion?.toolCallId === toolCallId) {
          result.pendingQuestion = undefined;
        }

        const isError = data.isError as boolean | undefined ?? false;

        addActivity(
          result,
          { type: 'toolResult', name: toolName, success: !isError },
          isError ? 'Error' : 'Completed',
          timestamp
        );
      }
      break;
    }

    case 'assistant.turn_end': {
      // Extract usage info
      const usage = data.usage as Record<string, unknown> | undefined;
      if (usage) {
        result.lastInputTokens = (usage.inputTokens as number) ?? 0;
        result.lastOutputTokens = (usage.outputTokens as number) ?? 0;
        result.totalOutputTokens += result.lastOutputTokens;
        result.cacheReadTokens += (usage.cacheReadInputTokens as number) ?? 0;
        result.cacheCreationTokens += (usage.cacheCreationInputTokens as number) ?? 0;
      }
      break;
    }
  }
}

/**
 * Update current status based on recent activity
 * Mirrors Swift implementation for parity
 */
export function updateCurrentStatus(result: ParseResult, approvalTimeoutSeconds = 5): void {
  const lastActivity = result.recentActivities[result.recentActivities.length - 1];

  if (!lastActivity) {
    result.currentStatus = { type: 'idle' };
    return;
  }

  const timeSince = (Date.now() - lastActivity.timestamp.getTime()) / 1000;

  // Global idle timeout: 5 minutes (300 seconds)
  if (timeSince > 300) {
    result.currentStatus = { type: 'idle' };
    return;
  }

  switch (lastActivity.activityType.type) {
    case 'toolUse': {
      const name = lastActivity.activityType.name;
      // Task tool runs in background, doesn't need approval
      if (name.toLowerCase() === 'task') {
        result.currentStatus = { type: 'executingTool', name };
      } else if (timeSince > approvalTimeoutSeconds) {
        result.currentStatus = { type: 'awaitingApproval', tool: name };
      } else {
        result.currentStatus = { type: 'executingTool', name };
      }
      break;
    }

    case 'toolResult':
      result.currentStatus = timeSince < 60 ? { type: 'thinking' } : { type: 'idle' };
      break;

    case 'assistantMessage':
      result.currentStatus = { type: 'waitingForUser' };
      break;

    case 'userMessage':
      result.currentStatus = timeSince < 60 ? { type: 'thinking' } : { type: 'idle' };
      break;

    case 'thinking':
      result.currentStatus = timeSince < 30 ? { type: 'thinking' } : { type: 'idle' };
      break;
  }
}

/**
 * Parse an entire session file, with incremental caching by mtime+size.
 * Re-reads only new bytes when the file has grown.
 */
export function parseSessionFile(filePath: string, approvalTimeoutSeconds = 5): ParseResult {
  if (!fs.existsSync(filePath)) {
    return createEmptyResult();
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return createEmptyResult();
  }

  const mtime = stat.mtimeMs;
  const size = stat.size;
  const cached = _parseCache.get(filePath);

  // Fully cached — mtime and size unchanged
  if (cached && cached.mtime === mtime && cached.size === size) {
    return cached.result;
  }

  // Incremental: file grew since last parse — read only new bytes
  if (cached && size > cached.size && cached.mtime <= mtime) {
    let newContent = '';
    try {
      const fd = fs.openSync(filePath, 'r');
      const bytesToRead = size - cached.size;
      const buf = Buffer.allocUnsafe(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, cached.size);
      fs.closeSync(fd);
      newContent = buf.toString('utf-8');
    } catch {
      // Fall through to full re-parse on error
    }
    if (newContent) {
      const newLines = newContent.split('\n');
      parseNewLines(newLines, cached.result, approvalTimeoutSeconds);
      cached.mtime = mtime;
      cached.size = size;
      return cached.result;
    }
  }

  // Full parse
  const result = createEmptyResult();
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());

  for (const line of lines) {
    const event = parseEvent(line);
    if (event) {
      processEvent(event, result);
    }
  }

  updateCurrentStatus(result, approvalTimeoutSeconds);
  _parseCache.set(filePath, { result, mtime, size });
  return result;
}

/**
 * Evict a session's parse cache entry (call when session is deleted).
 */
export function evictParseCache(filePath: string): void {
  _parseCache.delete(filePath);
}

/**
 * Parse new lines incrementally
 */
export function parseNewLines(
  lines: string[],
  result: ParseResult,
  approvalTimeoutSeconds = 5
): void {
  for (const line of lines) {
    if (!line.trim()) continue;
    const event = parseEvent(line);
    if (event) {
      processEvent(event, result);
    }
  }

  updateCurrentStatus(result, approvalTimeoutSeconds);
}
