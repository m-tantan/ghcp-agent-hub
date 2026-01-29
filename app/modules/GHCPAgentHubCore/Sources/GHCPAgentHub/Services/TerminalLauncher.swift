//
//  TerminalLauncher.swift
//  GHCPAgentHub
//
//  Helper for launching Terminal with GitHub Copilot CLI sessions
//  Adapted from AgentHub for GitHub Copilot CLI
//

import Foundation
#if os(macOS)
import AppKit
#endif

/// Helper object to handle launching Terminal with Copilot sessions
public struct TerminalLauncher {

  // MARK: - Configuration

  /// Default Copilot CLI command
  public static let defaultCommand = "gh"
  public static let defaultArgs = ["copilot"]

  // MARK: - Public API

  /// Runs a Copilot session in the background without opening Terminal
  /// - Parameters:
  ///   - sessionId: The session ID to resume
  ///   - projectPath: The project path to use as working directory
  ///   - prompt: The prompt to send to Copilot
  ///   - onOutput: Called with each chunk of output text
  ///   - onComplete: Called when the process finishes
  @MainActor
  public static func runSessionInBackground(
    _ sessionId: String,
    projectPath: String,
    prompt: String,
    additionalPaths: [String]? = nil,
    onOutput: @escaping @MainActor (String) -> Void,
    onComplete: @escaping @MainActor (Error?) -> Void
  ) {
    guard let ghExecutablePath = findGHExecutable(additionalPaths: additionalPaths) else {
      let error = NSError(
        domain: "TerminalLauncher",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Could not find 'gh' command. Please ensure GitHub CLI is installed."]
      )
      onComplete(error)
      return
    }

    Task.detached {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: ghExecutablePath)
      // gh copilot -r <sessionId> <prompt>
      process.arguments = ["copilot", "-r", sessionId, prompt]

      if !projectPath.isEmpty {
        process.currentDirectoryURL = URL(fileURLWithPath: projectPath)
      }

      // Set up environment with PATH
      var environment = ProcessInfo.processInfo.environment
      let paths = (additionalPaths ?? []) + getDefaultPaths()
      if let existingPath = environment["PATH"] {
        #if os(Windows)
        environment["PATH"] = paths.joined(separator: ";") + ";" + existingPath
        #else
        environment["PATH"] = paths.joined(separator: ":") + ":" + existingPath
        #endif
      } else {
        #if os(Windows)
        environment["PATH"] = paths.joined(separator: ";")
        #else
        environment["PATH"] = paths.joined(separator: ":")
        #endif
      }
      process.environment = environment

      let stdoutPipe = Pipe()
      let stderrPipe = Pipe()
      process.standardOutput = stdoutPipe
      process.standardError = stderrPipe

      stdoutPipe.fileHandleForReading.readabilityHandler = { handle in
        let data = handle.availableData
        if !data.isEmpty, let text = String(data: data, encoding: .utf8) {
          Task { @MainActor in
            onOutput(text)
          }
        }
      }

      stderrPipe.fileHandleForReading.readabilityHandler = { handle in
        let data = handle.availableData
        if !data.isEmpty, let text = String(data: data, encoding: .utf8) {
          Task { @MainActor in
            onOutput(text)
          }
        }
      }

      process.terminationHandler = { process in
        stdoutPipe.fileHandleForReading.readabilityHandler = nil
        stderrPipe.fileHandleForReading.readabilityHandler = nil

        Task { @MainActor in
          if process.terminationStatus != 0 {
            let error = NSError(
              domain: "TerminalLauncher",
              code: Int(process.terminationStatus),
              userInfo: [NSLocalizedDescriptionKey: "Process exited with status \(process.terminationStatus)"]
            )
            onComplete(error)
          } else {
            onComplete(nil)
          }
        }
      }

      do {
        try process.run()
      } catch {
        Task { @MainActor in
          onComplete(error)
        }
      }
    }
  }

  #if os(macOS)
  /// Launches Terminal with a Copilot session resume command
  /// - Parameters:
  ///   - sessionId: The session ID to resume
  ///   - projectPath: The project path to change to
  ///   - initialPrompt: Optional initial prompt to send
  /// - Returns: An error if launching fails, nil on success
  public static func launchTerminalWithSession(
    _ sessionId: String,
    projectPath: String,
    initialPrompt: String? = nil,
    additionalPaths: [String]? = nil
  ) -> Error? {
    guard let ghPath = findGHExecutable(additionalPaths: additionalPaths) else {
      return NSError(
        domain: "TerminalLauncher",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Could not find 'gh' command. Please ensure GitHub CLI is installed."]
      )
    }

    let escapedPath = escapeForShell(projectPath)
    let escapedGHPath = escapeForShell(ghPath)
    let escapedSessionId = escapeForShell(sessionId)
    let escapedPrompt = initialPrompt.map { escapeForShell($0) }

    let command: String
    if !projectPath.isEmpty {
      if let prompt = escapedPrompt {
        command = "cd \"\(escapedPath)\" && \"\(escapedGHPath)\" copilot -r \"\(escapedSessionId)\" '\(prompt)'"
      } else {
        command = "cd \"\(escapedPath)\" && \"\(escapedGHPath)\" copilot -r \"\(escapedSessionId)\""
      }
    } else {
      if let prompt = escapedPrompt {
        command = "\"\(escapedGHPath)\" copilot -r \"\(escapedSessionId)\" '\(prompt)'"
      } else {
        command = "\"\(escapedGHPath)\" copilot -r \"\(escapedSessionId)\""
      }
    }

    return launchTerminalWithCommand(command)
  }

  /// Launches Terminal with a new Copilot session in the specified path
  public static func launchTerminalInPath(
    _ path: String,
    branchName: String,
    isWorktree: Bool,
    skipCheckout: Bool = false,
    initialPrompt: String? = nil,
    additionalPaths: [String]? = nil
  ) -> Error? {
    guard let ghPath = findGHExecutable(additionalPaths: additionalPaths) else {
      return NSError(
        domain: "TerminalLauncher",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Could not find 'gh' command. Please ensure GitHub CLI is installed."]
      )
    }

    let escapedPath = escapeForShell(path)
    let escapedGHPath = escapeForShell(ghPath)
    let escapedBranch = escapeForShell(branchName)
    let escapedPrompt = initialPrompt.map { escapeForShell($0) }

    let command: String
    if isWorktree || skipCheckout {
      if let prompt = escapedPrompt {
        command = "cd \"\(escapedPath)\" && \"\(escapedGHPath)\" copilot '\(prompt)'"
      } else {
        command = "cd \"\(escapedPath)\" && \"\(escapedGHPath)\" copilot"
      }
    } else {
      command = "cd \"\(escapedPath)\" && git checkout \"\(escapedBranch)\" && \"\(escapedGHPath)\" copilot"
    }

    return launchTerminalWithCommand(command)
  }

  private static func launchTerminalWithCommand(_ command: String) -> Error? {
    let tempDir = NSTemporaryDirectory()
    let scriptPath = (tempDir as NSString).appendingPathComponent("ghcp_session_\(UUID().uuidString).command")

    let scriptContent = """
    #!/bin/bash
    \(command)
    """

    do {
      try scriptContent.write(toFile: scriptPath, atomically: true, encoding: .utf8)
      let attributes = [FileAttributeKey.posixPermissions: 0o755]
      try FileManager.default.setAttributes(attributes, ofItemAtPath: scriptPath)

      let url = URL(fileURLWithPath: scriptPath)
      NSWorkspace.shared.open(url)

      // Clean up script after delay
      DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
        try? FileManager.default.removeItem(atPath: scriptPath)
      }

      return nil
    } catch {
      return NSError(
        domain: "TerminalLauncher",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "Failed to launch Terminal: \(error.localizedDescription)"]
      )
    }
  }
  #endif

  // MARK: - Path Finding

  /// Finds the full path to the gh executable
  public static func findGHExecutable(additionalPaths: [String]? = nil) -> String? {
    let fileManager = FileManager.default
    let allPaths = (additionalPaths ?? []) + getDefaultPaths()

    // Search for gh in all paths
    for path in allPaths {
      #if os(Windows)
      let fullPath = "\(path)\\gh.exe"
      #else
      let fullPath = "\(path)/gh"
      #endif
      if fileManager.fileExists(atPath: fullPath) {
        return fullPath
      }
    }

    // Fallback: try using 'which' command (Unix) or 'where' (Windows)
    #if os(Windows)
    return findExecutableUsingWhere("gh")
    #else
    return findExecutableUsingWhich("gh")
    #endif
  }

  private static func getDefaultPaths() -> [String] {
    let homeDir = NSHomeDirectory()

    #if os(Windows)
    return [
      "\(homeDir)\\AppData\\Local\\Programs\\GitHub CLI",
      "C:\\Program Files\\GitHub CLI",
      "C:\\Program Files (x86)\\GitHub CLI",
    ]
    #else
    return [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "\(homeDir)/.local/bin",
      "\(homeDir)/.nvm/current/bin",
    ]
    #endif
  }

  #if !os(Windows)
  private static func findExecutableUsingWhich(_ command: String) -> String? {
    let task = Process()
    task.launchPath = "/usr/bin/which"
    task.arguments = [command]

    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = Pipe()

    do {
      try task.run()
      task.waitUntilExit()

      if task.terminationStatus == 0 {
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        if let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !path.isEmpty {
          return path
        }
      }
    } catch {
      // Ignore
    }

    return nil
  }
  #endif

  #if os(Windows)
  private static func findExecutableUsingWhere(_ command: String) -> String? {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "C:\\Windows\\System32\\where.exe")
    task.arguments = [command]

    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = Pipe()

    do {
      try task.run()
      task.waitUntilExit()

      if task.terminationStatus == 0 {
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        if let output = String(data: data, encoding: .utf8) {
          // where returns multiple lines, take the first
          let path = output.components(separatedBy: .newlines).first?.trimmingCharacters(in: .whitespacesAndNewlines)
          if let path = path, !path.isEmpty {
            return path
          }
        }
      }
    } catch {
      // Ignore
    }

    return nil
  }
  #endif

  private static func escapeForShell(_ string: String) -> String {
    string
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "\"", with: "\\\"")
  }
}
