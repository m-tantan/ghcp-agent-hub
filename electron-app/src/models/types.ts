/**
 * Session Status Types
 * Mirrors the Swift SessionStatus enum for parity
 */

export type SessionStatus =
  | { type: 'idle' }
  | { type: 'thinking' }
  | { type: 'executingTool'; name: string }
  | { type: 'awaitingApproval'; tool: string }
  | { type: 'waitingForUser' };

export function getStatusDisplayName(status: SessionStatus): string {
  switch (status.type) {
    case 'idle': return 'Idle';
    case 'thinking': return 'Thinking';
    case 'executingTool': return `Executing: ${status.name}`;
    case 'awaitingApproval': return `Awaiting Approval: ${status.tool}`;
    case 'waitingForUser': return 'Waiting for User';
  }
}

export function isStatusActive(status: SessionStatus): boolean {
  return status.type === 'thinking' ||
         status.type === 'executingTool' ||
         status.type === 'awaitingApproval';
}

/**
 * Activity Types - mirrors Swift ActivityType
 */
export type ActivityType =
  | { type: 'userMessage' }
  | { type: 'assistantMessage' }
  | { type: 'toolUse'; name: string }
  | { type: 'toolResult'; name: string; success: boolean }
  | { type: 'thinking' };

/**
 * Activity Entry - single activity in session timeline
 */
export interface ActivityEntry {
  timestamp: Date;
  activityType: ActivityType;
  description: string;
  toolInput?: CodeChangeInput;
}

/**
 * Code Change Input - for code-changing tools
 */
export interface CodeChangeInput {
  toolType: 'edit' | 'write' | 'multiEdit';
  filePath: string;
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  edits?: Array<{ old_string?: string; new_string?: string; replace_all?: string }>;
}

/**
 * Pending Tool Use
 */
export interface PendingToolUse {
  toolName: string;
  toolCallId: string;
  timestamp: Date;
  input?: string;
  codeChangeInput?: CodeChangeInput;
}

/**
 * Session Monitor State - complete monitoring state
 */
export interface SessionMonitorState {
  status: SessionStatus;
  currentTool?: string;
  lastActivityAt: Date;
  inputTokens: number;
  outputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  messageCount: number;
  toolCalls: Record<string, number>;
  sessionStartedAt?: Date;
  model?: string;
  gitBranch?: string;
  pendingToolUse?: PendingToolUse;
  recentActivities: ActivityEntry[];
}

/**
 * CLI Session - represents a Copilot CLI session
 */
export interface CLISession {
  id: string;
  projectPath: string;
  branchName: string;
  isWorktree: boolean;
  lastActivityAt: Date;
  messageCount: number;
  isActive: boolean;
  firstMessage?: string;
  lastMessage?: string;
  summary?: string;
}

/**
 * Workspace Metadata - from workspace.yaml
 */
export interface WorkspaceMetadata {
  id: string;
  cwd: string;
  gitRoot?: string;
  repository?: string;
  branch?: string;
  summary?: string;
  summaryCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Worktree Branch
 */
export interface WorktreeBranch {
  name: string;
  path: string;
  isWorktree: boolean;
  sessions: CLISession[];
  isExpanded: boolean;
}

/**
 * Selected Repository
 */
export interface SelectedRepository {
  path: string;
  worktrees: WorktreeBranch[];
  isExpanded: boolean;
}
