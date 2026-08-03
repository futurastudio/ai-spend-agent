import Foundation

enum SnapshotLoaderError: LocalizedError {
  case commandNotFound
  case commandFailed(String)
  case invalidOutput(String)
  case timedOut

  var errorDescription: String? {
    switch self {
    case .commandNotFound:
      "Could not find the local aibill CLI. Build the repo or set AIBILL_GLANCE_COMMAND."
    case .commandFailed(let message):
      "aibill glance failed: \(message)"
    case .invalidOutput(let message):
      "aibill returned invalid Glance data: \(message)"
    case .timedOut:
      "aibill glance did not finish within \(SnapshotLoader.timeoutSeconds) seconds. The previous snapshot is now stale; retry after checking the local CLI."
    }
  }
}

enum SnapshotLoader {
  // A first scan can parse a large local transcript corpus before filesystem
  // caches are warm. Keep the last good snapshot visible while it runs and
  // allow enough time for the measured cold path instead of turning a healthy
  // local data source into a false timeout.
  static let timeoutSeconds = 75

  private struct Command {
    let executable: URL
    let arguments: [String]
  }

  static func load() throws -> UsageGlanceSnapshot {
    guard let command = candidateCommands().first else {
      throw SnapshotLoaderError.commandNotFound
    }

    let process = Process()
    process.executableURL = command.executable
    process.arguments = command.arguments
    var environment = ProcessInfo.processInfo.environment
    environment["NO_COLOR"] = "1"
    process.environment = environment

    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr

    let finished = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in finished.signal() }
    try process.run()
    if finished.wait(timeout: .now() + .seconds(timeoutSeconds)) == .timedOut {
      process.terminate()
      throw SnapshotLoaderError.timedOut
    }

    let output = stdout.fileHandleForReading.readDataToEndOfFile()
    let errorOutput = stderr.fileHandleForReading.readDataToEndOfFile()
    guard process.terminationStatus == 0 else {
      let message = String(data: errorOutput, encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      throw SnapshotLoaderError.commandFailed(
        message.flatMap { $0.isEmpty ? nil : $0 } ?? "exit \(process.terminationStatus)"
      )
    }

    do {
      return try JSONDecoder().decode(UsageGlanceSnapshot.self, from: output)
    } catch {
      let preview = String(data: output.prefix(240), encoding: .utf8) ?? "(non-text output)"
      throw SnapshotLoaderError.invalidOutput("\(error.localizedDescription). Output: \(preview)")
    }
  }

  private static func candidateCommands() -> [Command] {
    let environment = ProcessInfo.processInfo.environment
    let home = FileManager.default.homeDirectoryForCurrentUser
    let explicit = environment["AIBILL_GLANCE_COMMAND"].map(URL.init(fileURLWithPath:))
    let localCli = home
      .appendingPathComponent("agent-finops")
      .appendingPathComponent("packages/cli/dist/index.js")
    let installedExecutables = [
      home.appendingPathComponent(".local/bin/ai-spend-agent"),
      home.appendingPathComponent(".npm-global/bin/ai-spend-agent"),
      URL(fileURLWithPath: "/opt/homebrew/bin/ai-spend-agent"),
      URL(fileURLWithPath: "/usr/local/bin/ai-spend-agent")
    ]

    var commands: [Command] = []
    if let explicit, explicit.pathExtension == "js", fileExists(explicit) {
      commands.append(contentsOf: nodeCommands(for: explicit))
    } else if let explicit, FileManager.default.isExecutableFile(atPath: explicit.path) {
      commands.append(Command(
        executable: explicit,
        arguments: ["glance", "--since-days", "30"]
      ))
    }
    if fileExists(localCli) {
      commands.append(contentsOf: nodeCommands(for: localCli))
    }
    commands.append(contentsOf: installedExecutables
      .filter { FileManager.default.isExecutableFile(atPath: $0.path) }
      .map {
        Command(
          executable: $0,
          arguments: ["glance", "--since-days", "30"]
        )
      })
    return commands
  }

  private static func nodeCommands(for script: URL) -> [Command] {
    let environment = ProcessInfo.processInfo.environment
    let home = FileManager.default.homeDirectoryForCurrentUser
    let nodeCandidates = [
      environment["AIBILL_NODE_PATH"].map(URL.init(fileURLWithPath:)),
      home.appendingPathComponent(".local/bin/node"),
      URL(fileURLWithPath: "/opt/homebrew/bin/node"),
      URL(fileURLWithPath: "/usr/local/bin/node"),
      URL(fileURLWithPath: "/usr/bin/node")
    ].compactMap { $0 }
    return nodeCandidates
      .filter { FileManager.default.isExecutableFile(atPath: $0.path) }
      .map {
        Command(
          executable: $0,
          arguments: [script.path, "glance", "--since-days", "30"]
        )
      }
  }

  private static func fileExists(_ url: URL) -> Bool {
    FileManager.default.fileExists(atPath: url.path)
  }
}
