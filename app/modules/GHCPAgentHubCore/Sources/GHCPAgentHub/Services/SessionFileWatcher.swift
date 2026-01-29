//
//  SessionFileWatcher.swift
//  GHCPAgentHub
//
//  Service that watches Copilot CLI session files for real-time monitoring
//  Adapted from AgentHub for GitHub Copilot CLI
//

import Foundation
import Combine

// MARK: - SessionFileWatcher

/// Service that watches session events.jsonl files for real-time monitoring
public actor SessionFileWatcher {

  // MARK: - Types

  /// State update for a monitored session
  public struct StateUpdate: Sendable {
    public let sessionId: String
    public let state: SessionMonitorState
  }

  // MARK: - Properties

  private var watchedSessions: [String: FileWatcherInfo] = [:]
  private nonisolated let stateSubject = PassthroughSubject<StateUpdate, Never>()
  private let copilotPath: String

  /// Serial queue for processing file events and status updates
  private nonisolated let processingQueue = DispatchQueue(label: "com.ghcpagenthub.sessionwatcher.processing")

  /// Seconds to wait before considering a tool as awaiting approval
  private var approvalTimeoutSeconds: Int = 5

  /// Publisher for state updates
  public nonisolated var statePublisher: AnyPublisher<StateUpdate, Never> {
    stateSubject.eraseToAnyPublisher()
  }

  // MARK: - Initialization

  public init(copilotPath: String? = nil) {
    if let path = copilotPath {
      self.copilotPath = path
    } else {
      #if os(Windows)
      self.copilotPath = NSHomeDirectory() + "\\.copilot"
      #else
      self.copilotPath = NSString(string: "~/.copilot").expandingTildeInPath
      #endif
    }
  }

  /// Set the approval timeout in seconds
  public func setApprovalTimeout(_ seconds: Int) {
    self.approvalTimeoutSeconds = max(1, seconds)
  }

  /// Get the current approval timeout
  public func getApprovalTimeout() -> Int {
    return approvalTimeoutSeconds
  }

  // MARK: - Public API

  /// Start monitoring a session
  public func startMonitoring(sessionId: String) {
    // If already monitoring, re-emit current state
    if let existingInfo = watchedSessions[sessionId] {
      let state = buildMonitorState(from: existingInfo.parseResult, metadata: existingInfo.metadata)
      stateSubject.send(StateUpdate(sessionId: sessionId, state: state))
      return
    }

    // Find session files
    let sessionDir = "\(copilotPath)/session-state/\(sessionId)"
    let eventsFile = "\(sessionDir)/events.jsonl"
    let workspaceFile = "\(sessionDir)/workspace.yaml"

    guard FileManager.default.fileExists(atPath: eventsFile) else {
      return
    }

    // Read workspace metadata
    let metadata = readWorkspaceMetadata(at: workspaceFile)

    // Initial parse
    var parseResult = SessionEventsParser.parseSessionFile(at: eventsFile, approvalTimeoutSeconds: approvalTimeoutSeconds)

    // Merge metadata
    if let meta = metadata {
      parseResult.gitBranch = parseResult.gitBranch ?? meta.branch
      parseResult.summary = meta.summary
      parseResult.cwd = parseResult.cwd ?? meta.cwd
    }

    let initialState = buildMonitorState(from: parseResult, metadata: metadata)
    stateSubject.send(StateUpdate(sessionId: sessionId, state: initialState))

    // Set up file watching
    let fileDescriptor = open(eventsFile, O_EVTONLY)
    guard fileDescriptor >= 0 else {
      return
    }

    let source = DispatchSource.makeFileSystemObjectSource(
      fileDescriptor: fileDescriptor,
      eventMask: [.write, .extend],
      queue: DispatchQueue.global(qos: .utility)
    )

    var filePosition = getFileSize(eventsFile)
    let timeout = approvalTimeoutSeconds

    var lastFileEventTime = Date()
    var lastKnownFileSize = filePosition
    var lastEmittedStatus: SessionStatus = parseResult.currentStatus

    source.setEventHandler { [weak self] in
      guard let self = self else { return }

      self.processingQueue.async {
        lastFileEventTime = Date()
        let newLines = self.readNewLines(from: eventsFile, startingAt: &filePosition)
        lastKnownFileSize = filePosition

        guard !newLines.isEmpty else { return }

        SessionEventsParser.parseNewLines(newLines, into: &parseResult, approvalTimeoutSeconds: timeout)
        lastEmittedStatus = parseResult.currentStatus

        let updatedState = self.buildMonitorState(from: parseResult, metadata: metadata)

        Task { @MainActor in
          self.stateSubject.send(StateUpdate(sessionId: sessionId, state: updatedState))
        }
      }
    }

    source.setCancelHandler {
      close(fileDescriptor)
    }

    source.resume()

    // Status timer for timeout-based status updates
    let statusTimer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
    statusTimer.schedule(deadline: .now() + 1, repeating: 1.0)

    statusTimer.setEventHandler { [weak self] in
      guard let self = self else { return }

      self.processingQueue.async {
        let timeSinceLastEvent = Date().timeIntervalSince(lastFileEventTime)
        let currentFileSize = self.getFileSize(eventsFile)

        // Health check for stale watcher
        if timeSinceLastEvent > 5 && currentFileSize > lastKnownFileSize {
          var tempPosition = lastKnownFileSize
          let newLines = self.readNewLines(from: eventsFile, startingAt: &tempPosition)

          if !newLines.isEmpty {
            SessionEventsParser.parseNewLines(newLines, into: &parseResult, approvalTimeoutSeconds: timeout)
            lastKnownFileSize = tempPosition
            lastFileEventTime = Date()
          } else {
            lastKnownFileSize = currentFileSize
          }
        }

        let previousStatus = lastEmittedStatus
        SessionEventsParser.updateCurrentStatus(&parseResult, approvalTimeoutSeconds: timeout)

        if parseResult.currentStatus != lastEmittedStatus {
          lastEmittedStatus = parseResult.currentStatus
          let updatedState = self.buildMonitorState(from: parseResult, metadata: metadata)

          Task { @MainActor in
            self.stateSubject.send(StateUpdate(sessionId: sessionId, state: updatedState))
          }
        }
      }
    }

    statusTimer.resume()

    watchedSessions[sessionId] = FileWatcherInfo(
      eventsFilePath: eventsFile,
      workspaceFilePath: workspaceFile,
      source: source,
      statusTimer: statusTimer,
      parseResult: parseResult,
      metadata: metadata,
      lastFileEventTime: lastFileEventTime,
      lastKnownFileSize: lastKnownFileSize
    )
  }

  /// Stop monitoring a session
  public func stopMonitoring(sessionId: String) {
    guard let info = watchedSessions.removeValue(forKey: sessionId) else {
      return
    }

    info.source.cancel()
    info.statusTimer.cancel()
  }

  /// Get current state for a session
  public func getState(sessionId: String) -> SessionMonitorState? {
    guard let info = watchedSessions[sessionId] else { return nil }
    return buildMonitorState(from: info.parseResult, metadata: info.metadata)
  }

  /// Check if a session is being monitored
  public func isMonitoring(sessionId: String) -> Bool {
    watchedSessions[sessionId] != nil
  }

  /// Force refresh a session's state
  public func refreshState(sessionId: String) {
    guard let info = watchedSessions[sessionId] else { return }

    let parseResult = SessionEventsParser.parseSessionFile(
      at: info.eventsFilePath,
      approvalTimeoutSeconds: approvalTimeoutSeconds
    )
    watchedSessions[sessionId]?.parseResult = parseResult

    let state = buildMonitorState(from: parseResult, metadata: info.metadata)
    stateSubject.send(StateUpdate(sessionId: sessionId, state: state))
  }

  // MARK: - Private Helpers

  private nonisolated func getFileSize(_ path: String) -> UInt64 {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
          let size = attrs[.size] as? UInt64 else {
      return 0
    }
    return size
  }

  private nonisolated func readNewLines(from path: String, startingAt position: inout UInt64) -> [String] {
    guard let handle = FileHandle(forReadingAtPath: path) else { return [] }
    defer { try? handle.close() }

    let currentSize = getFileSize(path)
    guard currentSize > position else { return [] }

    do {
      try handle.seek(toOffset: position)
      let data = handle.readDataToEndOfFile()
      position = currentSize

      guard let content = String(data: data, encoding: .utf8) else { return [] }
      return content.components(separatedBy: .newlines).filter { !$0.isEmpty }
    } catch {
      return []
    }
  }

  private func readWorkspaceMetadata(at path: String) -> WorkspaceMetadata? {
    guard let data = FileManager.default.contents(atPath: path),
          let content = String(data: data, encoding: .utf8) else {
      return nil
    }

    // Simple YAML parsing for workspace.yaml
    var dict: [String: String] = [:]
    for line in content.components(separatedBy: .newlines) {
      let parts = line.split(separator: ":", maxSplits: 1)
      if parts.count == 2 {
        let key = String(parts[0]).trimmingCharacters(in: .whitespaces)
        let value = String(parts[1]).trimmingCharacters(in: .whitespaces)
        dict[key] = value
      }
    }

    return WorkspaceMetadata(
      id: dict["id"] ?? "",
      cwd: dict["cwd"] ?? "",
      gitRoot: dict["git_root"],
      repository: dict["repository"],
      branch: dict["branch"],
      summary: dict["summary"],
      summaryCount: Int(dict["summary_count"] ?? ""),
      createdAt: dict["created_at"],
      updatedAt: dict["updated_at"]
    )
  }

  private nonisolated func buildMonitorState(
    from result: SessionEventsParser.ParseResult,
    metadata: WorkspaceMetadata?
  ) -> SessionMonitorState {
    let pendingToolUse: PendingToolUse?
    if let (_, pending) = result.pendingToolUses.first {
      pendingToolUse = PendingToolUse(
        toolName: pending.toolName,
        toolCallId: pending.toolCallId,
        timestamp: pending.timestamp,
        input: pending.input,
        codeChangeInput: pending.codeChangeInput
      )
    } else {
      pendingToolUse = nil
    }

    return SessionMonitorState(
      status: result.currentStatus,
      currentTool: extractCurrentTool(from: result),
      lastActivityAt: result.lastActivityAt ?? Date(),
      inputTokens: result.lastInputTokens,
      outputTokens: result.lastOutputTokens,
      totalOutputTokens: result.totalOutputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheCreationTokens: result.cacheCreationTokens,
      messageCount: result.messageCount,
      toolCalls: result.toolCalls,
      sessionStartedAt: result.sessionStartedAt,
      model: result.model,
      gitBranch: result.gitBranch ?? metadata?.branch,
      pendingToolUse: pendingToolUse,
      recentActivities: result.recentActivities
    )
  }

  private nonisolated func extractCurrentTool(from result: SessionEventsParser.ParseResult) -> String? {
    if let (_, pending) = result.pendingToolUses.first {
      return pending.toolName
    }
    return nil
  }
}

// MARK: - FileWatcherInfo

private struct FileWatcherInfo {
  let eventsFilePath: String
  let workspaceFilePath: String
  let source: DispatchSourceFileSystemObject
  let statusTimer: DispatchSourceTimer
  var parseResult: SessionEventsParser.ParseResult
  let metadata: WorkspaceMetadata?
  var lastFileEventTime: Date
  var lastKnownFileSize: UInt64
}
