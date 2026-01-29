//
//  GHCPAgentHub.swift
//  GHCPAgentHub
//
//  Main module export file for GHCPAgentHubCore
//

import Foundation

// MARK: - Module Exports

// Re-export all public types for convenience

// Models
public typealias Session = CLISession

// Version info
public struct GHCPAgentHub {
  public static let version = "1.0.0"
  public static let name = "GHCP-Agent-Hub"
  public static let description = "GitHub Copilot CLI Session Manager"

  /// Default path to Copilot data directory
  public static var defaultCopilotPath: String {
    #if os(Windows)
    return NSHomeDirectory() + "\\.copilot"
    #else
    return NSHomeDirectory() + "/.copilot"
    #endif
  }

  /// Default path to session state directory
  public static var sessionStatePath: String {
    return defaultCopilotPath + "/session-state"
  }

  private init() {}
}
