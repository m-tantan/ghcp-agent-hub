//
//  SessionStatus.swift
//  GHCPAgentHub
//
//  Adapted from AgentHub for GitHub Copilot CLI
//

import Foundation

// MARK: - SessionStatus

/// Represents the current status of a Copilot CLI session
public enum SessionStatus: Equatable, Sendable {
  case idle
  case thinking
  case executingTool(name: String)
  case awaitingApproval(tool: String)
  case waitingForUser

  public var displayName: String {
    switch self {
    case .idle: return "Idle"
    case .thinking: return "Thinking"
    case .executingTool(let name): return "Executing: \(name)"
    case .awaitingApproval(let tool): return "Awaiting Approval: \(tool)"
    case .waitingForUser: return "Waiting for User"
    }
  }

  public var isActive: Bool {
    switch self {
    case .idle, .waitingForUser: return false
    case .thinking, .executingTool, .awaitingApproval: return true
    }
  }
}

// MARK: - ActivityType

/// Type of activity in a session
public enum ActivityType: Equatable, Sendable {
  case userMessage
  case assistantMessage
  case toolUse(name: String)
  case toolResult(name: String, success: Bool)
  case thinking
}

// MARK: - ActivityEntry

/// A single activity entry in the session timeline
public struct ActivityEntry: Equatable, Sendable {
  public let timestamp: Date
  public let type: ActivityType
  public let description: String
  public let toolInput: CodeChangeInput?

  public init(timestamp: Date, type: ActivityType, description: String, toolInput: CodeChangeInput? = nil) {
    self.timestamp = timestamp
    self.type = type
    self.description = description
    self.toolInput = toolInput
  }
}

// MARK: - CodeChangeInput

/// Input data for code-changing tools (Edit, Write, MultiEdit)
public struct CodeChangeInput: Equatable, Sendable {
  public enum ToolType: String, Sendable {
    case edit = "Edit"
    case write = "Write"
    case multiEdit = "MultiEdit"
  }

  public let toolType: ToolType
  public let filePath: String
  public let oldString: String?
  public let newString: String?
  public let replaceAll: Bool?
  public let edits: [[String: String]]?

  public init(
    toolType: ToolType,
    filePath: String,
    oldString: String? = nil,
    newString: String? = nil,
    replaceAll: Bool? = nil,
    edits: [[String: String]]? = nil
  ) {
    self.toolType = toolType
    self.filePath = filePath
    self.oldString = oldString
    self.newString = newString
    self.replaceAll = replaceAll
    self.edits = edits
  }
}

// MARK: - PendingToolUse

/// Information about a tool use that hasn't received a result yet
public struct PendingToolUse: Sendable {
  public let toolName: String
  public let toolCallId: String
  public let timestamp: Date
  public let input: String?
  public let codeChangeInput: CodeChangeInput?

  public init(
    toolName: String,
    toolCallId: String,
    timestamp: Date,
    input: String?,
    codeChangeInput: CodeChangeInput?
  ) {
    self.toolName = toolName
    self.toolCallId = toolCallId
    self.timestamp = timestamp
    self.input = input
    self.codeChangeInput = codeChangeInput
  }
}

// MARK: - SessionMonitorState

/// Complete monitoring state for a session
public struct SessionMonitorState: Sendable {
  public var status: SessionStatus
  public var currentTool: String?
  public var lastActivityAt: Date
  public var inputTokens: Int
  public var outputTokens: Int
  public var totalOutputTokens: Int
  public var cacheReadTokens: Int
  public var cacheCreationTokens: Int
  public var messageCount: Int
  public var toolCalls: [String: Int]
  public var sessionStartedAt: Date?
  public var model: String?
  public var gitBranch: String?
  public var pendingToolUse: PendingToolUse?
  public var recentActivities: [ActivityEntry]

  public init(
    status: SessionStatus = .idle,
    currentTool: String? = nil,
    lastActivityAt: Date = Date(),
    inputTokens: Int = 0,
    outputTokens: Int = 0,
    totalOutputTokens: Int = 0,
    cacheReadTokens: Int = 0,
    cacheCreationTokens: Int = 0,
    messageCount: Int = 0,
    toolCalls: [String: Int] = [:],
    sessionStartedAt: Date? = nil,
    model: String? = nil,
    gitBranch: String? = nil,
    pendingToolUse: PendingToolUse? = nil,
    recentActivities: [ActivityEntry] = []
  ) {
    self.status = status
    self.currentTool = currentTool
    self.lastActivityAt = lastActivityAt
    self.inputTokens = inputTokens
    self.outputTokens = outputTokens
    self.totalOutputTokens = totalOutputTokens
    self.cacheReadTokens = cacheReadTokens
    self.cacheCreationTokens = cacheCreationTokens
    self.messageCount = messageCount
    self.toolCalls = toolCalls
    self.sessionStartedAt = sessionStartedAt
    self.model = model
    self.gitBranch = gitBranch
    self.pendingToolUse = pendingToolUse
    self.recentActivities = recentActivities
  }
}
