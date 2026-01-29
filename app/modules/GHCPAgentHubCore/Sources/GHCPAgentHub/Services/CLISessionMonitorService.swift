//
//  CLISessionMonitorService.swift
//  GHCPAgentHub
//
//  Service for monitoring active GitHub Copilot CLI sessions
//  Adapted from AgentHub for GitHub Copilot CLI
//

import Foundation
import Combine

// MARK: - CLISessionMonitorService

/// Service for monitoring active Copilot CLI sessions from ~/.copilot folder
public actor CLISessionMonitorService {

  // MARK: - Configuration

  private let copilotDataPath: String

  // MARK: - Publishers

  private nonisolated(unsafe) let repositoriesSubject = CurrentValueSubject<[SelectedRepository], Never>([])
  public nonisolated var repositoriesPublisher: AnyPublisher<[SelectedRepository], Never> {
    repositoriesSubject.eraseToAnyPublisher()
  }

  private nonisolated(unsafe) let allSessionsSubject = CurrentValueSubject<[CLISession], Never>([])
  public nonisolated var allSessionsPublisher: AnyPublisher<[CLISession], Never> {
    allSessionsSubject.eraseToAnyPublisher()
  }

  // MARK: - State

  private var selectedRepositories: [SelectedRepository] = []

  // MARK: - Initialization

  public init(copilotDataPath: String? = nil) {
    if let path = copilotDataPath {
      self.copilotDataPath = path
    } else {
      #if os(Windows)
      self.copilotDataPath = NSHomeDirectory() + "\\.copilot"
      #else
      self.copilotDataPath = NSHomeDirectory() + "/.copilot"
      #endif
    }
  }

  // MARK: - Repository Management

  /// Adds a repository to monitor
  @discardableResult
  public func addRepository(_ path: String) async -> SelectedRepository? {
    guard !selectedRepositories.contains(where: { $0.path == path }) else {
      return selectedRepositories.first { $0.path == path }
    }

    let worktrees = await detectWorktrees(at: path)

    let repository = SelectedRepository(
      path: path,
      worktrees: worktrees,
      isExpanded: true
    )

    selectedRepositories.append(repository)
    await refreshSessions()

    return repository
  }

  /// Removes a repository from monitoring
  public func removeRepository(_ path: String) async {
    selectedRepositories.removeAll { $0.path == path }
    repositoriesSubject.send(selectedRepositories)
  }

  /// Returns currently selected repositories
  public func getSelectedRepositories() -> [SelectedRepository] {
    selectedRepositories
  }

  /// Sets the list of selected repositories
  public func setSelectedRepositories(_ repositories: [SelectedRepository]) async {
    selectedRepositories = repositories
    await refreshSessions()
  }

  // MARK: - Session Scanning

  /// Refreshes sessions for all selected repositories
  public func refreshSessions() async {
    // Scan all sessions from session-state directory
    let allSessions = await scanAllSessions()

    // Filter sessions by selected repositories
    var updatedRepositories = selectedRepositories

    for repoIndex in updatedRepositories.indices {
      for worktreeIndex in updatedRepositories[repoIndex].worktrees.indices {
        let worktreePath = updatedRepositories[repoIndex].worktrees[worktreeIndex].path

        // Find sessions matching this worktree
        let matchingSessions = allSessions.filter { session in
          session.projectPath == worktreePath ||
          session.projectPath.hasPrefix(worktreePath + "/") ||
          session.projectPath.hasPrefix(worktreePath + "\\")
        }

        updatedRepositories[repoIndex].worktrees[worktreeIndex].sessions = matchingSessions.sorted {
          $0.lastActivityAt > $1.lastActivityAt
        }
      }
    }

    selectedRepositories = updatedRepositories
    repositoriesSubject.send(selectedRepositories)
    allSessionsSubject.send(allSessions)
  }

  /// Scan all sessions from the Copilot session-state directory
  public func scanAllSessions() async -> [CLISession] {
    let sessionStatePath = "\(copilotDataPath)/session-state"

    guard FileManager.default.fileExists(atPath: sessionStatePath) else {
      return []
    }

    var sessions: [CLISession] = []

    do {
      let sessionDirs = try FileManager.default.contentsOfDirectory(atPath: sessionStatePath)

      for sessionId in sessionDirs {
        // Skip non-UUID directories
        guard UUID(uuidString: sessionId) != nil else { continue }

        let sessionDir = "\(sessionStatePath)/\(sessionId)"
        let workspaceFile = "\(sessionDir)/workspace.yaml"
        let eventsFile = "\(sessionDir)/events.jsonl"

        // Read workspace metadata
        guard let metadata = readWorkspaceMetadata(at: workspaceFile) else { continue }

        // Check if active (events file modified recently)
        var isActive = false
        if let attrs = try? FileManager.default.attributesOfItem(atPath: eventsFile),
           let modDate = attrs[FileAttributeKey.modificationDate] as? Date {
          isActive = Date().timeIntervalSince(modDate) < 60
        }

        // Parse events for message count
        let parseResult = SessionEventsParser.parseSessionFile(at: eventsFile)

        // Get timestamps
        let createdAt = parseTimestamp(metadata.createdAt)
        let updatedAt = parseTimestamp(metadata.updatedAt)

        let session = CLISession(
          id: sessionId,
          projectPath: metadata.cwd,
          branchName: metadata.branch ?? "main",
          isWorktree: false,  // Will be determined by worktree detection
          lastActivityAt: updatedAt ?? parseResult.lastActivityAt ?? Date(),
          messageCount: parseResult.messageCount,
          isActive: isActive,
          firstMessage: parseResult.recentActivities.first(where: {
            if case .userMessage = $0.type { return true }
            return false
          })?.description,
          lastMessage: parseResult.recentActivities.last(where: {
            if case .userMessage = $0.type { return true }
            return false
          })?.description,
          summary: metadata.summary
        )

        sessions.append(session)
      }
    } catch {
      // Handle error silently
    }

    return sessions.sorted { $0.lastActivityAt > $1.lastActivityAt }
  }

  // MARK: - Worktree Detection

  private func detectWorktrees(at repoPath: String) async -> [WorktreeBranch] {
    // Run git worktree list
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = ["worktree", "list", "--porcelain"]
    process.currentDirectoryURL = URL(fileURLWithPath: repoPath)

    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = Pipe()

    do {
      try process.run()
      process.waitUntilExit()

      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      let output = String(data: data, encoding: .utf8) ?? ""

      var worktrees: [WorktreeBranch] = []
      var currentPath: String?
      var currentBranch: String?

      for line in output.components(separatedBy: .newlines) {
        if line.hasPrefix("worktree ") {
          currentPath = String(line.dropFirst("worktree ".count))
        } else if line.hasPrefix("branch refs/heads/") {
          currentBranch = String(line.dropFirst("branch refs/heads/".count))
        } else if line.isEmpty, let path = currentPath {
          let isMainWorktree = path == repoPath
          worktrees.append(WorktreeBranch(
            name: currentBranch ?? URL(fileURLWithPath: path).lastPathComponent,
            path: path,
            isWorktree: !isMainWorktree,
            sessions: []
          ))
          currentPath = nil
          currentBranch = nil
        }
      }

      // Handle last entry
      if let path = currentPath {
        let isMainWorktree = path == repoPath
        worktrees.append(WorktreeBranch(
          name: currentBranch ?? URL(fileURLWithPath: path).lastPathComponent,
          path: path,
          isWorktree: !isMainWorktree,
          sessions: []
        ))
      }

      if worktrees.isEmpty {
        // No worktrees, use main repo
        let branch = await getCurrentBranch(at: repoPath)
        return [WorktreeBranch(
          name: branch ?? "main",
          path: repoPath,
          isWorktree: false,
          sessions: []
        )]
      }

      return worktrees
    } catch {
      // Fallback to main repo
      let branch = await getCurrentBranch(at: repoPath)
      return [WorktreeBranch(
        name: branch ?? "main",
        path: repoPath,
        isWorktree: false,
        sessions: []
      )]
    }
  }

  private func getCurrentBranch(at path: String) async -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = ["branch", "--show-current"]
    process.currentDirectoryURL = URL(fileURLWithPath: path)

    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = Pipe()

    do {
      try process.run()
      process.waitUntilExit()

      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    } catch {
      return nil
    }
  }

  // MARK: - Helpers

  private func readWorkspaceMetadata(at path: String) -> WorkspaceMetadata? {
    guard let data = FileManager.default.contents(atPath: path),
          let content = String(data: data, encoding: .utf8) else {
      return nil
    }

    var dict: [String: String] = [:]
    for line in content.components(separatedBy: .newlines) {
      let parts = line.split(separator: ":", maxSplits: 1)
      if parts.count == 2 {
        let key = String(parts[0]).trimmingCharacters(in: .whitespaces)
        let value = String(parts[1]).trimmingCharacters(in: .whitespaces)
        dict[key] = value
      }
    }

    guard let id = dict["id"], let cwd = dict["cwd"] else {
      return nil
    }

    return WorkspaceMetadata(
      id: id,
      cwd: cwd,
      gitRoot: dict["git_root"],
      repository: dict["repository"],
      branch: dict["branch"],
      summary: dict["summary"],
      summaryCount: Int(dict["summary_count"] ?? ""),
      createdAt: dict["created_at"],
      updatedAt: dict["updated_at"]
    )
  }

  private func parseTimestamp(_ string: String?) -> Date? {
    guard let string = string else { return nil }

    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

    if let date = formatter.date(from: string) {
      return date
    }

    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: string)
  }
}
