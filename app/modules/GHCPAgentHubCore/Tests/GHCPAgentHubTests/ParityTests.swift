//
//  ParityTests.swift
//  GHCPAgentHubTests
//
//  Tests to verify behavior parity between GHCP-Agent-Hub and original AgentHub
//

import XCTest
@testable import GHCPAgentHubCore

/// These tests verify that the GHCP-Agent-Hub implementation produces
/// equivalent outputs to the original AgentHub for Claude Code.
///
/// The key differences to account for:
/// - Session path: `~/.copilot/session-state/{id}/` vs `~/.claude/projects/{encoded-path}/{id}.jsonl`
/// - Event format: `{type, data, id, timestamp, parentId}` vs `{type, message, timestamp}`
/// - Metadata: Separate `workspace.yaml` vs embedded in JSONL
final class ParityTests: XCTestCase {

  // MARK: - Status Detection Parity

  /// Both implementations should detect "thinking" when user sends a message
  func testThinkingStatusParity() {
    var result = SessionEventsParser.ParseResult()
    result.recentActivities = [
      ActivityEntry(timestamp: Date(), type: .userMessage, description: "Test prompt")
    ]

    SessionEventsParser.updateCurrentStatus(&result, approvalTimeoutSeconds: 5)

    // Claude AgentHub behavior: after user message, status = thinking
    XCTAssertEqual(result.currentStatus, .thinking,
      "PARITY: After user message, status should be 'thinking'")
  }

  /// Both implementations should detect "awaiting approval" after tool timeout
  func testAwaitingApprovalParity() {
    var result = SessionEventsParser.ParseResult()
    result.recentActivities = [
      ActivityEntry(
        timestamp: Date().addingTimeInterval(-10),  // 10 seconds ago
        type: .toolUse(name: "Edit"),
        description: "file.txt"
      )
    ]

    SessionEventsParser.updateCurrentStatus(&result, approvalTimeoutSeconds: 5)

    // Claude AgentHub behavior: after approvalTimeout seconds without result, status = awaitingApproval
    if case .awaitingApproval(let tool) = result.currentStatus {
      XCTAssertEqual(tool, "Edit",
        "PARITY: Tool awaiting approval should match")
    } else {
      XCTFail("PARITY: Should detect awaiting approval status after timeout")
    }
  }

  /// Both implementations should detect "waiting for user" after assistant message
  func testWaitingForUserParity() {
    var result = SessionEventsParser.ParseResult()
    result.recentActivities = [
      ActivityEntry(timestamp: Date(), type: .assistantMessage, description: "Done!")
    ]

    SessionEventsParser.updateCurrentStatus(&result, approvalTimeoutSeconds: 5)

    // Claude AgentHub behavior: after assistant text message, status = waitingForUser
    XCTAssertEqual(result.currentStatus, .waitingForUser,
      "PARITY: After assistant message, status should be 'waitingForUser'")
  }

  /// Both implementations should detect "idle" after 5 minutes of inactivity
  func testIdleAfterTimeoutParity() {
    var result = SessionEventsParser.ParseResult()
    result.recentActivities = [
      ActivityEntry(
        timestamp: Date().addingTimeInterval(-301),  // 5+ minutes ago
        type: .assistantMessage,
        description: "Old message"
      )
    ]

    SessionEventsParser.updateCurrentStatus(&result, approvalTimeoutSeconds: 5)

    // Claude AgentHub behavior: after 300 seconds (5 min), status = idle
    XCTAssertEqual(result.currentStatus, .idle,
      "PARITY: After 5 minutes of inactivity, status should be 'idle'")
  }

  /// Task tool should not trigger awaiting approval
  func testTaskToolNoApprovalParity() {
    var result = SessionEventsParser.ParseResult()
    result.recentActivities = [
      ActivityEntry(
        timestamp: Date().addingTimeInterval(-10),
        type: .toolUse(name: "Task"),
        description: "Running task"
      )
    ]

    SessionEventsParser.updateCurrentStatus(&result, approvalTimeoutSeconds: 5)

    // Claude AgentHub behavior: Task tool runs in background, no approval needed
    if case .executingTool(let name) = result.currentStatus {
      XCTAssertEqual(name, "Task",
        "PARITY: Task tool should remain in 'executingTool' state")
    } else {
      XCTFail("PARITY: Task tool should not trigger awaiting approval")
    }
  }

  // MARK: - Tool Call Tracking Parity

  /// Tool call counts should increment correctly
  func testToolCallCountingParity() {
    let events = """
    {"type":"assistant.message","data":{"toolRequests":[{"toolCallId":"1","name":"view","arguments":{}}]},"id":"1","timestamp":"2026-01-28T10:00:00.000Z"}
    {"type":"tool.result","data":{"toolCallId":"1"},"id":"2","timestamp":"2026-01-28T10:00:01.000Z"}
    {"type":"assistant.message","data":{"toolRequests":[{"toolCallId":"2","name":"view","arguments":{}}]},"id":"3","timestamp":"2026-01-28T10:00:02.000Z"}
    {"type":"tool.result","data":{"toolCallId":"2"},"id":"4","timestamp":"2026-01-28T10:00:03.000Z"}
    {"type":"assistant.message","data":{"toolRequests":[{"toolCallId":"3","name":"edit","arguments":{}}]},"id":"5","timestamp":"2026-01-28T10:00:04.000Z"}
    """

    let tempFile = FileManager.default.temporaryDirectory.appendingPathComponent("tool_count_test.jsonl")
    try? events.write(to: tempFile, atomically: true, encoding: .utf8)
    defer { try? FileManager.default.removeItem(at: tempFile) }

    let result = SessionEventsParser.parseSessionFile(at: tempFile.path)

    // Claude AgentHub behavior: each tool_use increments the count for that tool
    XCTAssertEqual(result.toolCalls["view"], 2,
      "PARITY: Should count 2 view calls")
    XCTAssertEqual(result.toolCalls["edit"], 1,
      "PARITY: Should count 1 edit call")
  }

  // MARK: - Message Counting Parity

  /// Message counts should match (user + assistant)
  func testMessageCountingParity() {
    let events = """
    {"type":"user.message","data":{"content":"First"},"id":"1","timestamp":"2026-01-28T10:00:00.000Z"}
    {"type":"assistant.message","data":{"content":"Response 1"},"id":"2","timestamp":"2026-01-28T10:00:01.000Z"}
    {"type":"user.message","data":{"content":"Second"},"id":"3","timestamp":"2026-01-28T10:00:02.000Z"}
    {"type":"assistant.message","data":{"content":"Response 2"},"id":"4","timestamp":"2026-01-28T10:00:03.000Z"}
    """

    let tempFile = FileManager.default.temporaryDirectory.appendingPathComponent("msg_count_test.jsonl")
    try? events.write(to: tempFile, atomically: true, encoding: .utf8)
    defer { try? FileManager.default.removeItem(at: tempFile) }

    let result = SessionEventsParser.parseSessionFile(at: tempFile.path)

    // Claude AgentHub behavior: counts both user and assistant messages
    XCTAssertEqual(result.messageCount, 4,
      "PARITY: Should count all user and assistant messages")
  }

  // MARK: - Pending Tool Tracking Parity

  /// Pending tools should be tracked until result received
  func testPendingToolTrackingParity() {
    var result = SessionEventsParser.ParseResult()

    // Simulate tool use
    let toolUseLine = """
    {"type":"assistant.message","data":{"toolRequests":[{"toolCallId":"pending-tool-1","name":"grep","arguments":{"pattern":"test"}}]},"id":"1","timestamp":"2026-01-28T10:00:00.000Z"}
    """
    SessionEventsParser.parseNewLines([toolUseLine], into: &result)

    // Claude AgentHub behavior: tool should be pending
    XCTAssertEqual(result.pendingToolUses.count, 1,
      "PARITY: Tool should be tracked as pending")
    XCTAssertNotNil(result.pendingToolUses["pending-tool-1"],
      "PARITY: Tool should be tracked by toolCallId")

    // Simulate tool result
    let toolResultLine = """
    {"type":"tool.result","data":{"toolCallId":"pending-tool-1","result":"found"},"id":"2","timestamp":"2026-01-28T10:00:01.000Z"}
    """
    SessionEventsParser.parseNewLines([toolResultLine], into: &result)

    // Claude AgentHub behavior: tool should be removed from pending
    XCTAssertEqual(result.pendingToolUses.count, 0,
      "PARITY: Tool should be removed from pending after result")
  }

  // MARK: - Activity History Parity

  /// Recent activities should be limited to 100 entries
  func testActivityHistoryLimitParity() {
    var result = SessionEventsParser.ParseResult()

    // Add 150 activities
    for i in 0..<150 {
      let line = """
      {"type":"user.message","data":{"content":"Message \(i)"},"id":"\(i)","timestamp":"2026-01-28T10:00:\(String(format: "%02d", i % 60)).000Z"}
      """
      SessionEventsParser.parseNewLines([line], into: &result)
    }

    // Claude AgentHub behavior: keeps only last 100 activities
    XCTAssertEqual(result.recentActivities.count, 100,
      "PARITY: Should limit recent activities to 100")
  }

  // MARK: - Branch Detection Parity

  /// Git branch should be extracted from session context
  func testBranchExtractionParity() {
    let events = """
    {"type":"session.start","data":{"context":{"branch":"feature/test-branch","cwd":"/test"}},"id":"1","timestamp":"2026-01-28T10:00:00.000Z"}
    """

    let tempFile = FileManager.default.temporaryDirectory.appendingPathComponent("branch_test.jsonl")
    try? events.write(to: tempFile, atomically: true, encoding: .utf8)
    defer { try? FileManager.default.removeItem(at: tempFile) }

    let result = SessionEventsParser.parseSessionFile(at: tempFile.path)

    // Claude AgentHub behavior: extracts gitBranch from session data
    XCTAssertEqual(result.gitBranch, "feature/test-branch",
      "PARITY: Should extract git branch from session context")
  }
}
