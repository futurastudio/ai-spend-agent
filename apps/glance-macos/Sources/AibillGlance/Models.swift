import Foundation

struct UsageGlanceSnapshot: Decodable, Sendable {
  let dataMode: String
  let generatedAt: String
  let coverage: Coverage
  let provenance: Provenance?
  let currentSession: Session?
  let plan: Plan?
  let limits: [Limit]
  let focus: Focus?
  let anomaly: Anomaly?
  let sessionHealth: ContextHealth?
  let primaryAction: PrimaryAction?

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

  struct Provenance: Decodable, Sendable {
    let session: SessionSource
    let sessionValue: SessionValueSource
    let plan: PlanSource
    let limits: LimitSource
    let focus: FocusSource
    let anomaly: AnomalySource
    let contextHealth: ContextHealthSource?
    let primaryAction: PrimaryActionSource?
    let network: NetworkSource

    struct SessionSource: Decodable, Sendable {
      let source: String
      let agents: [String]
      let filesParsed: Int
    }

    struct SessionValueSource: Decodable, Sendable {
      let source: String
      let basis: String
      let confidence: String
      let pricingAsOf: String
    }

    struct PlanSource: Decodable, Sendable {
      let source: String
      let agent: String?
    }

    struct LimitSource: Decodable, Sendable {
      let source: String
      let agents: [String]
      let windows: [String]
      let projection: String
    }

    struct FocusSource: Decodable, Sendable {
      let source: String
      let agents: [String]
      let rawPromptTextReturned: Bool
    }

    struct AnomalySource: Decodable, Sendable {
      let source: String
      let comparison: String
    }

    struct ContextHealthSource: Decodable, Sendable {
      let source: String
      let hookPayload: String
    }

    struct PrimaryActionSource: Decodable, Sendable {
      let source: String
      let execution: String
      let automaticExecution: Bool
    }

    struct NetworkSource: Decodable, Sendable {
      let uploaded: Bool
    }
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
    /** Raw provider-reported percentage; optional only for old cached snapshots. */
    let usedPercent: Double?
    let remainingPercent: Double
    let windowMinutes: Int
    let observedAt: String
    let resetsAt: String
    let source: String
    let freshness: String?
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

  struct ContextHealth: Decodable, Sendable {
    let schemaVersion: Int
    let status: String
    let recommendation: String
    let headline: String
    let action: String
    let confidence: String
    let activation: Activation
    let provenance: ContextProvenance

    struct Activation: Decodable, Sendable {
      let discoverableItems: Int
      let explicitlyInvokedItems: Int
      let hookInjectedItems: Int
      let lifecycleHooks: Int
      let mcpSchemaLoadedItems: Int
      let mcpConfiguredItems: Int?
      let mcpAlwaysLoadedItems: Int?
      let unmeasuredItems: Int
      let invocationUnobservableItems: Int?
    }

    struct ContextProvenance: Decodable, Sendable {
      let inventory: String
      let invocations: String
      let session: String
      let hookPayload: String
      let uploaded: Bool
    }
  }

  struct PrimaryAction: Decodable, Sendable {
    let kind: String?
    let intent: String
    let label: String
    let detail: String
    let project: String?
    let focus: String?
    let agentPrompt: String
    let source: String
    let confidence: String
    let execution: String
    let requiresUserConfirmation: Bool
    let evidenceWindowDays: Int?
  }
}

enum GlanceFormatting {
  static func dollars(_ value: Double?) -> String {
    guard let value else { return "Unpriced" }
    if value > 0, value < 0.01 { return "<$0.01" }
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
    if isReportedExhausted(limit) {
      return "At reported limit · checkpoint work"
    }
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

  static func isReportedExhausted(_ limit: UsageGlanceSnapshot.Limit) -> Bool {
    limit.freshness == "current" && (limit.usedPercent ?? 0) >= 100
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
