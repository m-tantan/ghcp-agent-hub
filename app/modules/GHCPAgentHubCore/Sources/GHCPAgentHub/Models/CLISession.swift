//
//  CLISession.swift
//  GHCPAgentHub
//
//  Adapted from AgentHub for GitHub Copilot CLI
//

import Foundation

// MARK: - CLISession

/// Represents a GitHub Copilot CLI session
public struct CLISession: Identifiable, Equatable, Sendable {
  public let id: String
  public let projectPath: String
  public let branchName: String
  public let isWorktree: Bool
  public let lastActivityAt: Date
  public let messageCount: Int
  public let isActive: Bool
  public let firstMessage: String?
  public let lastMessage: String?
  public let summary: String?

  public init(
    id: String,
    projectPath: String,
    branchName: String,
    isWorktree: Bool,
    lastActivityAt: Date,
    messageCount: Int,
    isActive: Bool,
    firstMessage: String? = nil,
    lastMessage: String? = nil,
    summary: String? = nil
  ) {
    self.id = id
    self.projectPath = projectPath
    self.branchName = branchName
    self.isWorktree = isWorktree
    self.lastActivityAt = lastActivityAt
    self.messageCount = messageCount
    self.isActive = isActive
    self.firstMessage = firstMessage
    self.lastMessage = lastMessage
    self.summary = summary
  }

  /// Display name for the session (summary or first message)
  public var displayName: String {
    summary ?? firstMessage ?? "Session \(id.prefix(8))"
  }
}

// MARK: - WorktreeBranch

/// Represents a git worktree or branch with its sessions
public struct WorktreeBranch: Identifiable, Equatable, Sendable {
  public var id: String { path }
  public var name: String
  public let path: String
  public let isWorktree: Bool
  public var sessions: [CLISession]
  public var isExpanded: Bool

  public init(
    name: String,
    path: String,
    isWorktree: Bool,
    sessions: [CLISession] = [],
    isExpanded: Bool = true
  ) {
    self.name = name
    self.path = path
    self.isWorktree = isWorktree
    self.sessions = sessions
    self.isExpanded = isExpanded
  }
}

// MARK: - SelectedRepository

/// A repository selected for monitoring
public struct SelectedRepository: Identifiable, Equatable, Sendable {
  public var id: String { path }
  public let path: String
  public var worktrees: [WorktreeBranch]
  public var isExpanded: Bool

  public init(path: String, worktrees: [WorktreeBranch] = [], isExpanded: Bool = true) {
    self.path = path
    self.worktrees = worktrees
    self.isExpanded = isExpanded
  }

  /// The repository name extracted from path
  public var name: String {
    URL(fileURLWithPath: path).lastPathComponent
  }
}

// MARK: - WorkspaceMetadata

/// Metadata from workspace.yaml file
public struct WorkspaceMetadata: Decodable, Sendable {
  public let id: String
  public let cwd: String
  public let gitRoot: String?
  public let repository: String?
  public let branch: String?
  public let summary: String?
  public let summaryCount: Int?
  public let createdAt: String?
  public let updatedAt: String?

  private enum CodingKeys: String, CodingKey {
    case id
    case cwd
    case gitRoot = "git_root"
    case repository
    case branch
    case summary
    case summaryCount = "summary_count"
    case createdAt = "created_at"
    case updatedAt = "updated_at"
  }

  public init(
    id: String,
    cwd: String,
    gitRoot: String? = nil,
    repository: String? = nil,
    branch: String? = nil,
    summary: String? = nil,
    summaryCount: Int? = nil,
    createdAt: String? = nil,
    updatedAt: String? = nil
  ) {
    self.id = id
    self.cwd = cwd
    self.gitRoot = gitRoot
    self.repository = repository
    self.branch = branch
    self.summary = summary
    self.summaryCount = summaryCount
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}
