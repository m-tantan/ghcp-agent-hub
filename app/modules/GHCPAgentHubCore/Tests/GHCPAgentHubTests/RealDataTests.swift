//
//  RealDataTests.swift
//  GHCPAgentHubTests
//
//  Tests that use real Copilot session data to verify parsing
//

import XCTest
@testable import GHCPAgentHubCore

final class RealDataTests: XCTestCase {

  /// Test parsing a real events.jsonl file from the user's Copilot directory
  func testParseRealSessionFile() {
    let copilotPath = GHCPAgentHub.sessionStatePath

    // Find a session directory
    guard FileManager.default.fileExists(atPath: copilotPath),
          let sessionDirs = try? FileManager.default.contentsOfDirectory(atPath: copilotPath),
          let firstSessionId = sessionDirs.first(where: { UUID(uuidString: $0) != nil }) else {
      // No real sessions available - skip test
      return
    }

    let eventsFile = "\(copilotPath)/\(firstSessionId)/events.jsonl"

    guard FileManager.default.fileExists(atPath: eventsFile) else {
      return
    }

    let result = SessionEventsParser.parseSessionFile(at: eventsFile)

    // Basic sanity checks
    XCTAssertNotNil(result.sessionStartedAt, "Should have session start time")

    // If there's any activity, we should have detected it
    if result.messageCount > 0 {
      XCTAssertFalse(result.recentActivities.isEmpty, "Should have recent activities")
    }

    // Log some info for manual verification
    print("=== Real Session Parse Results ===")
    print("Session ID: \(firstSessionId)")
    print("Message Count: \(result.messageCount)")
    print("Tool Calls: \(result.toolCalls)")
    print("Status: \(result.currentStatus)")
    print("Branch: \(result.gitBranch ?? "unknown")")
    print("Copilot Version: \(result.copilotVersion ?? "unknown")")
    print("Recent Activities: \(result.recentActivities.count)")
    print("================================")
  }

  /// Test reading workspace.yaml metadata
  func testParseRealWorkspaceMetadata() {
    let copilotPath = GHCPAgentHub.sessionStatePath

    guard FileManager.default.fileExists(atPath: copilotPath),
          let sessionDirs = try? FileManager.default.contentsOfDirectory(atPath: copilotPath),
          let firstSessionId = sessionDirs.first(where: { UUID(uuidString: $0) != nil }) else {
      return
    }

    let workspaceFile = "\(copilotPath)/\(firstSessionId)/workspace.yaml"

    guard FileManager.default.fileExists(atPath: workspaceFile),
          let data = FileManager.default.contents(atPath: workspaceFile),
          let content = String(data: data, encoding: .utf8) else {
      return
    }

    // Parse YAML manually (simple key: value format)
    var dict: [String: String] = [:]
    for line in content.components(separatedBy: .newlines) {
      let parts = line.split(separator: ":", maxSplits: 1)
      if parts.count == 2 {
        let key = String(parts[0]).trimmingCharacters(in: .whitespaces)
        let value = String(parts[1]).trimmingCharacters(in: .whitespaces)
        dict[key] = value
      }
    }

    print("=== Real Workspace Metadata ===")
    print("ID: \(dict["id"] ?? "missing")")
    print("CWD: \(dict["cwd"] ?? "missing")")
    print("Git Root: \(dict["git_root"] ?? "missing")")
    print("Branch: \(dict["branch"] ?? "missing")")
    print("Repository: \(dict["repository"] ?? "missing")")
    print("Summary: \(dict["summary"] ?? "missing")")
    print("=============================")

    XCTAssertNotNil(dict["id"], "Should have session ID")
    XCTAssertNotNil(dict["cwd"], "Should have working directory")
  }

  /// Test the session monitor service with real data
  func testSessionMonitorServiceScan() async {
    let service = CLISessionMonitorService()
    let sessions = await service.scanAllSessions()

    print("=== Scanned Sessions ===")
    print("Total sessions found: \(sessions.count)")

    for session in sessions.prefix(5) {
      print("- \(session.id.prefix(8))... | \(session.branchName) | \(session.displayName.prefix(40))")
    }
    print("========================")

    // We should find at least some sessions if Copilot has been used
    // This is not a hard assertion since the test environment may not have sessions
    if sessions.count > 0 {
      XCTAssertNotNil(sessions.first?.projectPath, "Sessions should have project paths")
    }
  }
}
