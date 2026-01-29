//
//  SessionEventsParser.swift
//  GHCPAgentHub
//
//  Parser for GitHub Copilot CLI events.jsonl files
//  Adapted from AgentHub's SessionJSONLParser for Claude Code
//

import Foundation

// MARK: - SessionEventsParser

/// Parser for Copilot CLI session events.jsonl files that extracts monitoring data
public struct SessionEventsParser {

  // MARK: - Event Types (Copilot-specific)

  /// Raw event from Copilot events.jsonl file
  public struct SessionEvent: Decodable {
    let type: String
    let data: AnyCodable?
    let id: String?
    let timestamp: String?
    let parentId: String?
  }

  // MARK: - Parsing Results

  /// Result of parsing a session file
  public struct ParseResult {
    public var model: String?
    public var lastInputTokens: Int = 0
    public var lastOutputTokens: Int = 0
    public var totalOutputTokens: Int = 0
    public var cacheReadTokens: Int = 0
    public var cacheCreationTokens: Int = 0
    public var messageCount: Int = 0
    public var toolCalls: [String: Int] = [:]
    public var pendingToolUses: [String: PendingToolInfo] = [:]  // toolCallId -> info
    public var recentActivities: [ActivityEntry] = []
    public var lastActivityAt: Date?
    public var sessionStartedAt: Date?
    public var currentStatus: SessionStatus = .idle
    public var gitBranch: String?
    public var summary: String?
    public var cwd: String?
    public var copilotVersion: String?

    public init() {}
  }

  /// Info about a pending tool use
  public struct PendingToolInfo {
    public let toolName: String
    public let toolCallId: String
    public let timestamp: Date
    public let input: String?
    public let codeChangeInput: CodeChangeInput?
  }

  // MARK: - Public API

  /// Parse an entire session events file and return aggregated state
  /// - Parameters:
  ///   - path: Path to the session events.jsonl file
  ///   - approvalTimeoutSeconds: Seconds to wait before considering a tool as awaiting approval (default: 5)
  public static func parseSessionFile(at path: String, approvalTimeoutSeconds: Int = 5) -> ParseResult {
    var result = ParseResult()

    guard let data = FileManager.default.contents(atPath: path),
          let content = String(data: data, encoding: .utf8) else {
      return result
    }

    let lines = content.components(separatedBy: .newlines)

    for line in lines where !line.isEmpty {
      if let event = parseEvent(line) {
        processEvent(event, into: &result)
      }
    }

    // Determine current status from pending tools
    updateCurrentStatus(&result, approvalTimeoutSeconds: approvalTimeoutSeconds)

    return result
  }

  /// Parse new lines from a session file (for incremental updates)
  public static func parseNewLines(_ lines: [String], into result: inout ParseResult, approvalTimeoutSeconds: Int = 5) {
    for line in lines where !line.isEmpty {
      if let event = parseEvent(line) {
        processEvent(event, into: &result)
      }
    }
    updateCurrentStatus(&result, approvalTimeoutSeconds: approvalTimeoutSeconds)
  }

  /// Parse a single JSONL line
  public static func parseEvent(_ line: String) -> SessionEvent? {
    guard let data = line.data(using: .utf8) else { return nil }

    do {
      let decoder = JSONDecoder()
      return try decoder.decode(SessionEvent.self, from: data)
    } catch {
      // Many lines may not match our expected format
      return nil
    }
  }

  // MARK: - Private Processing

  private static func processEvent(_ event: SessionEvent, into result: inout ParseResult) {
    let timestamp = parseTimestamp(event.timestamp)

    // Track first/last activity
    if let ts = timestamp {
      if result.sessionStartedAt == nil {
        result.sessionStartedAt = ts
      }
      result.lastActivityAt = ts
    }

    // Extract data dictionary for most event types
    let eventData = event.data?.value as? [String: Any]

    // Process based on Copilot event type
    switch event.type {

    // Session lifecycle
    case "session.start":
      if let context = eventData?["context"] as? [String: Any] {
        result.gitBranch = context["branch"] as? String
        result.cwd = context["cwd"] as? String
      }
      result.copilotVersion = eventData?["copilotVersion"] as? String

    // User message
    case "user.message":
      result.messageCount += 1
      let content = eventData?["content"] as? String ?? ""
      if !content.isEmpty {
        addActivity(
          type: .userMessage,
          description: String(content.prefix(80)),
          timestamp: timestamp,
          to: &result
        )
      }

    // Assistant turn start
    case "assistant.turn_start":
      addActivity(
        type: .thinking,
        description: "Thinking...",
        timestamp: timestamp,
        to: &result
      )

    // Assistant message (may contain tool requests)
    case "assistant.message":
      result.messageCount += 1

      // Extract model if present
      if let model = eventData?["model"] as? String {
        result.model = model
      }

      // Process tool requests
      if let toolRequests = eventData?["toolRequests"] as? [[String: Any]] {
        for toolRequest in toolRequests {
          guard let name = toolRequest["name"] as? String,
                let toolCallId = toolRequest["toolCallId"] as? String else { continue }

          // Track tool call count
          result.toolCalls[name, default: 0] += 1

          // Extract input preview
          let arguments = toolRequest["arguments"] as? [String: Any]
          let inputPreview = extractInputPreview(arguments)
          let codeChangeInput = extractCodeChangeInput(name: name, input: arguments)

          // Add to pending
          result.pendingToolUses[toolCallId] = PendingToolInfo(
            toolName: name,
            toolCallId: toolCallId,
            timestamp: timestamp ?? Date(),
            input: inputPreview,
            codeChangeInput: codeChangeInput
          )

          addActivity(
            type: .toolUse(name: name),
            description: inputPreview ?? name,
            timestamp: timestamp,
            codeChangeInput: codeChangeInput,
            to: &result
          )
        }
      }

      // Check for text content (assistant response)
      if let content = eventData?["content"] as? String, !content.isEmpty {
        addActivity(
          type: .assistantMessage,
          description: String(content.prefix(50)),
          timestamp: timestamp,
          to: &result
        )
      }

    // Tool result
    case "tool.result":
      if let toolCallId = eventData?["toolCallId"] as? String {
        let toolName = result.pendingToolUses[toolCallId]?.toolName ?? "unknown"
        result.pendingToolUses.removeValue(forKey: toolCallId)

        let isError = eventData?["isError"] as? Bool ?? false

        addActivity(
          type: .toolResult(name: toolName, success: !isError),
          description: isError ? "Error" : "Completed",
          timestamp: timestamp,
          to: &result
        )
      }

    // Assistant turn end
    case "assistant.turn_end":
      // Turn completed - may include usage info
      if let usage = eventData?["usage"] as? [String: Any] {
        result.lastInputTokens = usage["inputTokens"] as? Int ?? 0
        result.lastOutputTokens = usage["outputTokens"] as? Int ?? 0
        result.totalOutputTokens += result.lastOutputTokens
        result.cacheReadTokens += usage["cacheReadInputTokens"] as? Int ?? 0
        result.cacheCreationTokens += usage["cacheCreationInputTokens"] as? Int ?? 0
      }

    // Session info (e.g., MCP server info)
    case "session.info":
      // Informational, could log if needed
      break

    default:
      break
    }
  }

  /// Re-evaluate current status based on time elapsed since last activity
  public static func updateCurrentStatus(_ result: inout ParseResult, approvalTimeoutSeconds: Int = 5) {
    guard let lastActivity = result.recentActivities.last else {
      result.currentStatus = .idle
      return
    }

    let timeSince = Date().timeIntervalSince(lastActivity.timestamp)

    // Global idle timeout: 5 minutes
    if timeSince > 300 {
      result.currentStatus = .idle
      return
    }

    switch lastActivity.type {
    case .toolUse(let name):
      // Task tool runs in background, doesn't need approval
      if name == "task" || name == "Task" {
        result.currentStatus = .executingTool(name: name)
      } else if timeSince > Double(approvalTimeoutSeconds) {
        result.currentStatus = .awaitingApproval(tool: name)
      } else {
        result.currentStatus = .executingTool(name: name)
      }

    case .toolResult:
      if timeSince < 60 {
        result.currentStatus = .thinking
      } else {
        result.currentStatus = .idle
      }

    case .assistantMessage:
      result.currentStatus = .waitingForUser

    case .userMessage:
      if timeSince < 60 {
        result.currentStatus = .thinking
      } else {
        result.currentStatus = .idle
      }

    case .thinking:
      if timeSince < 30 {
        result.currentStatus = .thinking
      } else {
        result.currentStatus = .idle
      }
    }
  }

  private static func addActivity(
    type: ActivityType,
    description: String,
    timestamp: Date?,
    codeChangeInput: CodeChangeInput? = nil,
    to result: inout ParseResult
  ) {
    let entry = ActivityEntry(
      timestamp: timestamp ?? Date(),
      type: type,
      description: description,
      toolInput: codeChangeInput
    )

    result.recentActivities.append(entry)

    // Keep more activities for tracking (100)
    if result.recentActivities.count > 100 {
      result.recentActivities.removeFirst(result.recentActivities.count - 100)
    }
  }

  /// Extract full input parameters for code-changing tools
  private static func extractCodeChangeInput(name: String, input: [String: Any]?) -> CodeChangeInput? {
    guard let input = input,
          let filePath = input["file_path"] as? String ?? input["path"] as? String else {
      return nil
    }

    switch name {
    case "edit", "Edit":
      return CodeChangeInput(
        toolType: .edit,
        filePath: filePath,
        oldString: input["old_string"] as? String ?? input["old_str"] as? String,
        newString: input["new_string"] as? String ?? input["new_str"] as? String,
        replaceAll: input["replace_all"] as? Bool
      )

    case "write", "Write", "create", "Create":
      return CodeChangeInput(
        toolType: .write,
        filePath: filePath,
        newString: input["content"] as? String ?? input["file_text"] as? String
      )

    case "MultiEdit", "multi_edit":
      var editsArray: [[String: String]]? = nil
      if let edits = input["edits"] as? [[String: Any]] {
        editsArray = edits.compactMap { edit in
          var result = [String: String]()
          if let oldStr = edit["old_string"] as? String { result["old_string"] = oldStr }
          if let newStr = edit["new_string"] as? String { result["new_string"] = newStr }
          if let replaceAll = edit["replace_all"] as? Bool { result["replace_all"] = String(replaceAll) }
          return result.isEmpty ? nil : result
        }
      }
      return CodeChangeInput(
        toolType: .multiEdit,
        filePath: filePath,
        edits: editsArray
      )

    default:
      return nil
    }
  }

  // MARK: - Helpers

  private static func parseTimestamp(_ string: String?) -> Date? {
    guard let string = string else { return nil }

    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

    if let date = formatter.date(from: string) {
      return date
    }

    // Try without fractional seconds
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: string)
  }

  private static func extractInputPreview(_ input: [String: Any]?) -> String? {
    guard let input = input else { return nil }

    // Common patterns
    if let path = input["file_path"] as? String ?? input["path"] as? String {
      return URL(fileURLWithPath: path).lastPathComponent
    }
    if let command = input["command"] as? String {
      return String(command.prefix(50))
    }
    if let pattern = input["pattern"] as? String {
      return pattern
    }
    if let query = input["query"] as? String {
      return String(query.prefix(50))
    }
    if let intent = input["intent"] as? String {
      return String(intent.prefix(50))
    }

    return nil
  }
}

// MARK: - AnyCodable

/// Type-erased Codable wrapper for arbitrary JSON values
public struct AnyCodable: Decodable {
  public let value: Any

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()

    if container.decodeNil() {
      self.value = NSNull()
    } else if let bool = try? container.decode(Bool.self) {
      self.value = bool
    } else if let int = try? container.decode(Int.self) {
      self.value = int
    } else if let double = try? container.decode(Double.self) {
      self.value = double
    } else if let string = try? container.decode(String.self) {
      self.value = string
    } else if let array = try? container.decode([AnyCodable].self) {
      self.value = array.map { $0.value }
    } else if let dictionary = try? container.decode([String: AnyCodable].self) {
      self.value = dictionary.mapValues { $0.value }
    } else {
      throw DecodingError.dataCorruptedError(
        in: container,
        debugDescription: "Unable to decode value"
      )
    }
  }
}
