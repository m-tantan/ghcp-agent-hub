//
//  SessionEventsParserTests.swift
//  GHCPAgentHubTests
//
//  Unit tests for SessionEventsParser
//

import XCTest
@testable import GHCPAgentHubCore

final class SessionEventsParserTests: XCTestCase {

  // MARK: - Event Parsing Tests

  func testParseSessionStartEvent() {
    let jsonLine = """
    {"type":"session.start","data":{"sessionId":"test-session-123","version":1,"producer":"copilot-agent","copilotVersion":"0.0.396","startTime":"2026-01-28T19:22:30.433Z","context":{"cwd":"C:\\\\SOC\\\\TestRepo","gitRoot":"C:\\\\SOC\\\\TestRepo","branch":"main","repository":"user/TestRepo"}},"id":"event-1","timestamp":"2026-01-28T19:22:30.544Z","parentId":null}
    """

    let event = SessionEventsParser.parseEvent(jsonLine)

    XCTAssertNotNil(event)
    XCTAssertEqual(event?.type, "session.start")
    XCTAssertEqual(event?.id, "event-1")
    XCTAssertNotNil(event?.timestamp)
  }

  func testParseUserMessageEvent() {
    let jsonLine = """
    {"type":"user.message","data":{"content":"Hello, can you help me?","transformedContent":"Hello, can you help me?","attachments":[]},"id":"user-msg-1","timestamp":"2026-01-28T19:23:00.702Z","parentId":"parent-1"}
    """

    let event = SessionEventsParser.parseEvent(jsonLine)

    XCTAssertNotNil(event)
    XCTAssertEqual(event?.type, "user.message")

    if let data = event?.data?.value as? [String: Any] {
      XCTAssertEqual(data["content"] as? String, "Hello, can you help me?")
    } else {
      XCTFail("Expected data dictionary")
    }
  }

  func testParseAssistantMessageWithToolRequests() {
    let jsonLine = """
    {"type":"assistant.message","data":{"messageId":"msg-1","content":"","toolRequests":[{"toolCallId":"tool-1","name":"view","arguments":{"path":"C:\\\\SOC\\\\TestRepo"},"type":"function"}]},"id":"assistant-msg-1","timestamp":"2026-01-28T19:23:06.364Z","parentId":"parent-1"}
    """

    let event = SessionEventsParser.parseEvent(jsonLine)

    XCTAssertNotNil(event)
    XCTAssertEqual(event?.type, "assistant.message")

    if let data = event?.data?.value as? [String: Any],
       let toolRequests = data["toolRequests"] as? [[String: Any]] {
      XCTAssertEqual(toolRequests.count, 1)
      XCTAssertEqual(toolRequests[0]["name"] as? String, "view")
    } else {
      XCTFail("Expected tool requests")
    }
  }

  func testParseToolResultEvent() {
    let jsonLine = """
    {"type":"tool.result","data":{"toolCallId":"tool-1","result":"Success","isError":false},"id":"tool-result-1","timestamp":"2026-01-28T19:23:10.000Z","parentId":"tool-1"}
    """

    let event = SessionEventsParser.parseEvent(jsonLine)

    XCTAssertNotNil(event)
    XCTAssertEqual(event?.type, "tool.result")
  }

  // MARK: - Parse Result Tests

  func testParseSessionFileCreatesValidResult() {
    // Create a temporary test file
    let tempDir = FileManager.default.temporaryDirectory
    let testFile = tempDir.appendingPathComponent("test_events.jsonl")

    let events = """
    {"type":"session.start","data":{"sessionId":"test-123","copilotVersion":"0.0.396","context":{"cwd":"/test","branch":"main"}},"id":"1","timestamp":"2026-01-28T10:00:00.000Z","parentId":null}
    {"type":"user.message","data":{"content":"Test message"},"id":"2","timestamp":"2026-01-28T10:00:01.000Z","parentId":"1"}
    {"type":"assistant.turn_start","data":{"turnId":"0"},"id":"3","timestamp":"2026-01-28T10:00:02.000Z","parentId":"2"}
    {"type":"assistant.message","data":{"messageId":"msg-1","content":"","toolRequests":[{"toolCallId":"tool-1","name":"view","arguments":{"path":"/test/file.txt"},"type":"function"}]},"id":"4","timestamp":"2026-01-28T10:00:03.000Z","parentId":"3"}
    {"type":"tool.result","data":{"toolCallId":"tool-1","result":"file content","isError":false},"id":"5","timestamp":"2026-01-28T10:00:04.000Z","parentId":"4"}
    {"type":"assistant.message","data":{"messageId":"msg-2","content":"Here is the result"},"id":"6","timestamp":"2026-01-28T10:00:05.000Z","parentId":"5"}
    """

    try? events.write(to: testFile, atomically: true, encoding: .utf8)
    defer { try? FileManager.default.removeItem(at: testFile) }

    let result = SessionEventsParser.parseSessionFile(at: testFile.path)

    XCTAssertEqual(result.messageCount, 2)  // user + assistant
    XCTAssertEqual(result.toolCalls["view"], 1)
    XCTAssertEqual(result.gitBranch, "main")
    XCTAssertNotNil(result.sessionStartedAt)
    XCTAssertNotNil(result.lastActivityAt)
    XCTAssertFalse(result.recentActivities.isEmpty)
  }

  // MARK: - Status Detection Tests

  func testStatusDetectionThinking() {
    var result = SessionEventsParser.ParseResult()
    result.recentActivities = [
      ActivityEntry(timestamp: Date(), type: .userMessage, description: "Test")
    ]

    SessionEventsParser.updateCurrentStatus(&result, approvalTimeoutSeconds: 5)

    XCTAssertEqual(result.currentStatus, .thinking)
  }

  func testStatusDetectionAwaitingApproval() {
    var result = SessionEventsParser.ParseResult()
    // Simulate a tool use that happened 10 seconds ago
    result.recentActivities = [
      ActivityEntry(
        timestamp: Date().addingTimeInterval(-10),
        type: .toolUse(name: "edit"),
        description: "test.txt"
      )
    ]

    SessionEventsParser.updateCurrentStatus(&result, approvalTimeoutSeconds: 5)

    if case .awaitingApproval(let tool) = result.currentStatus {
      XCTAssertEqual(tool, "edit")
    } else {
      XCTFail("Expected awaiting approval status")
    }
  }

  func testStatusDetectionExecutingTool() {
    var result = SessionEventsParser.ParseResult()
    // Simulate a tool use that just happened
    result.recentActivities = [
      ActivityEntry(
        timestamp: Date(),
        type: .toolUse(name: "view"),
        description: "file.txt"
      )
    ]

    SessionEventsParser.updateCurrentStatus(&result, approvalTimeoutSeconds: 5)

    if case .executingTool(let name) = result.currentStatus {
      XCTAssertEqual(name, "view")
    } else {
      XCTFail("Expected executing tool status")
    }
  }

  func testStatusDetectionWaitingForUser() {
    var result = SessionEventsParser.ParseResult()
    result.recentActivities = [
      ActivityEntry(timestamp: Date(), type: .assistantMessage, description: "Done!")
    ]

    SessionEventsParser.updateCurrentStatus(&result, approvalTimeoutSeconds: 5)

    XCTAssertEqual(result.currentStatus, .waitingForUser)
  }

  func testStatusDetectionIdle() {
    var result = SessionEventsParser.ParseResult()
    // Simulate activity from 10 minutes ago
    result.recentActivities = [
      ActivityEntry(
        timestamp: Date().addingTimeInterval(-600),
        type: .assistantMessage,
        description: "Old message"
      )
    ]

    SessionEventsParser.updateCurrentStatus(&result, approvalTimeoutSeconds: 5)

    XCTAssertEqual(result.currentStatus, .idle)
  }

  // MARK: - Code Change Input Extraction Tests

  func testExtractEditToolInput() {
    let jsonLine = """
    {"type":"assistant.message","data":{"messageId":"msg-1","content":"","toolRequests":[{"toolCallId":"tool-1","name":"edit","arguments":{"path":"/test/file.txt","old_str":"old text","new_str":"new text"},"type":"function"}]},"id":"1","timestamp":"2026-01-28T10:00:00.000Z","parentId":null}
    """

    var result = SessionEventsParser.ParseResult()
    if let event = SessionEventsParser.parseEvent(jsonLine) {
      // Process the event
      let tempFile = FileManager.default.temporaryDirectory.appendingPathComponent("single_event.jsonl")
      try? jsonLine.write(to: tempFile, atomically: true, encoding: .utf8)
      defer { try? FileManager.default.removeItem(at: tempFile) }

      result = SessionEventsParser.parseSessionFile(at: tempFile.path)
    }

    // Find the edit activity
    let editActivity = result.recentActivities.first(where: {
      if case .toolUse(let name) = $0.type, name == "edit" { return true }
      return false
    })

    XCTAssertNotNil(editActivity)
    XCTAssertNotNil(editActivity?.toolInput)
    XCTAssertEqual(editActivity?.toolInput?.toolType, .edit)
    XCTAssertEqual(editActivity?.toolInput?.filePath, "/test/file.txt")
  }

  // MARK: - Incremental Parsing Tests

  func testIncrementalParsing() {
    var result = SessionEventsParser.ParseResult()

    let line1 = """
    {"type":"user.message","data":{"content":"First message"},"id":"1","timestamp":"2026-01-28T10:00:00.000Z","parentId":null}
    """

    SessionEventsParser.parseNewLines([line1], into: &result)
    XCTAssertEqual(result.messageCount, 1)

    let line2 = """
    {"type":"user.message","data":{"content":"Second message"},"id":"2","timestamp":"2026-01-28T10:00:01.000Z","parentId":"1"}
    """

    SessionEventsParser.parseNewLines([line2], into: &result)
    XCTAssertEqual(result.messageCount, 2)
  }
}
