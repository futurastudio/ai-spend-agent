import Foundation

struct UsageGlanceSnapshot: Decodable, Sendable {
  let dataMode: String
  let generatedAt: String
  let coverage: Coverage
  let currentSession: Session?
  let plan: Plan?
  let limits: [Limit]
  let focus: Focus?
  let anomaly: Anomaly?

  struct Coverage: Decodable, Sendable {
    let filesParsed: Int
    let detectedAgents: [String]
    let rateLimitMetadata: [RateLimitMetadata]?
  }

  struct RateLimitMetadata: Decodable, Sendable {
    let agent: String
    let status: String
    let windowsReported: [String]
  }

  struct Session: Decodable, Sendable {
    let status: String
    let agent: String
    let project: String?
    let model: String
    let startedAt: String
    let lastActivityAt: String
    let durationMinutes: Int
    let apiEquivalentUsd: Double?
    let costConfidence: String
  }

  struct Plan: Decodable, Sendable {
    let agent: String
    let planId: String?
    let planLabel: String
    let billing: String
    let monthlyUsd: Double?
    let priceConfidence: String
    let source: String
  }

  struct Limit: Decodable, Sendable, Identifiable {
    var id: String { "\(agent)-\(kind)-\(windowMinutes)" }

    let agent: String
    let kind: String
    let name: String
    let remainingPercent: Double
    let windowMinutes: Int
    let observedAt: String
    let resetsAt: String
    let source: String
    let projectedExhaustionAt: String?
    let projectedToExhaustBeforeReset: Bool
    let projectionConfidence: String
  }

  struct Focus: Decodable, Sendable {
    let windowDays: Int
    let summary: String
    let kind: String
    let project: String?
    let file: String?
    let agents: [String]
    let sessions: Int
    let activitySharePercent: Double
    let measure: String
    let confidence: String
  }

  struct Anomaly: Decodable, Sendable {
    let kind: String
    let ratioToMedian: Double
    let summary: String
    let action: String
    let confidence: String
  }
}

enum GlanceFormatting {
  static func dollars(_ value: Double?) -> String {
    guard let value else { return "Unpriced" }
    return value.formatted(.currency(code: "USD").precision(.fractionLength(2)))
  }

  static func percent(_ value: Double) -> String {
    "\(Int(value.rounded()))%"
  }

  static func resetLabel(_ iso: String) -> String {
    guard let date = isoDate(iso) else {
      return "Reset time unavailable"
    }
    if Calendar.current.isDateInToday(date) {
      return "Resets \(date.formatted(date: .omitted, time: .shortened))"
    }
    return "Resets \(date.formatted(.dateTime.weekday(.abbreviated).hour().minute()))"
  }

  static func exhaustionLabel(_ limit: UsageGlanceSnapshot.Limit) -> String {
    guard
      limit.projectedToExhaustBeforeReset,
      let value = limit.projectedExhaustionAt,
      let date = isoDate(value)
    else {
      return "On pace to stay below cap"
    }
    if Calendar.current.isDateInToday(date) {
      return "May exhaust \(date.formatted(date: .omitted, time: .shortened))"
    }
    return "May exhaust \(date.formatted(.dateTime.weekday(.abbreviated).hour().minute()))"
  }

  static func agentName(_ value: String) -> String {
    switch value {
    case "claude-code": "Claude Code"
    case "codex": "Codex"
    default: value
    }
  }

  static func modelName(_ value: String) -> String {
    value
      .replacingOccurrences(of: "claude-", with: "Claude ")
      .replacingOccurrences(of: "-codex", with: " Codex")
      .replacingOccurrences(of: "-", with: " ")
  }

  private static func isoDate(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) {
      return date
    }
    return ISO8601DateFormatter().date(from: value)
  }
}
