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
  /** Optional so Glance remains compatible with pre-experiment CLI snapshots. */
  let tokenExperiment: TokenExperiment?

  struct Coverage: Decodable, Sendable {
    let filesParsed: Int
    let detectedAgents: [String]
    let rateLimitMetadata: [RateLimitMetadata]?
    let qualitative: QualitativeCoverage?
  }

  struct QualitativeCoverage: Decodable, Sendable {
    let status: String
    let selectedFiles: Int
    let readCompletely: Int
    let skippedForBudget: Int
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

  /** Product-authored projection from the canonical experiment evaluator. */
  struct TokenExperiment: Decodable, Sendable {
    let schemaVersion: Int
    let experimentId: String
    let findingId: String
    let candidateKey: String
    let state: String
    let tone: String
    let headline: String
    let detail: String
    let evidenceLabel: String
    let qualityLabel: String
    let qualityEvidence: String?
    let baselineSessions: Int
    let postChangeSessions: Int
    let minimumSessions: Int
    let reductionPercent: Double?
  }
}

struct GlanceTokenExperimentPresentation: Equatable {
  let label: String

  static func build(
    projection: UsageGlanceSnapshot.TokenExperiment?,
    evidenceCurrent: Bool
  ) -> Self? {
    guard let projection else { return nil }
    guard isStructurallyValid(projection) else {
      return Self(label: "Token test unavailable")
    }
    guard evidenceCurrent else {
      // A failed refresh keeps the old snapshot on screen. Never repeat an old
      // reduction percentage as though it were current evidence.
      return Self(label: "Token test unavailable · refresh")
    }

    switch projection.state {
    case "collect_baseline":
      return Self(
        label: "Token test · \(projection.baselineSessions)/\(projection.minimumSessions) baseline"
      )
    case "approve_one_change":
      return Self(label: "Token test · ready for approval")
    case "collect_post_change":
      return Self(
        label: "Token test · \(projection.postChangeSessions)/\(projection.minimumSessions) matched"
      )
    case "review_measured_result":
      guard
        let reduction = projection.reductionPercent,
        projection.evidenceLabel == "calculated",
        projection.qualityLabel == "held",
        let qualityEvidence = projection.qualityEvidence
      else {
        return Self(label: "Token test unavailable")
      }
      let quality = qualityEvidence == "user_declared"
        ? "quality user-declared"
        : "quality \(qualityEvidence)"
      if reduction == 0 {
        return Self(label: "No measured token change · \(quality)")
      }
      return Self(label: "Measured \(signedReduction(reduction)) · \(quality)")
    case "rollback":
      return Self(label: "Regressed · review rollback")
    case "rolled_back":
      return Self(label: "Token test rolled back")
    case "cancelled":
      return Self(label: "Token test cancelled")
    case "resolve_evidence":
      if projection.qualityLabel == "insufficient" {
        return Self(label: "Inconclusive · quality evidence missing")
      }
      return Self(label: "Inconclusive · review matching evidence")
    default:
      return Self(label: "Token test unavailable")
    }
  }

  private static func isStructurallyValid(
    _ projection: UsageGlanceSnapshot.TokenExperiment
  ) -> Bool {
    let states = Set([
      "collect_baseline", "approve_one_change", "collect_post_change",
      "review_measured_result", "rollback", "resolve_evidence", "rolled_back", "cancelled"
    ])
    let evidenceLabels = Set(["calculated", "missing"])
    let qualityLabels = Set(["held", "regressed", "insufficient"])
    let qualityEvidenceLabels = Set(["verified", "observed", "user_declared", "missing"])
    let claimQualityEvidenceLabels = Set(["verified", "observed", "user_declared"])
    let tones = Set(["neutral", "attention", "positive", "negative"])
    let validReduction = projection.reductionPercent.map {
      $0.isFinite && $0 <= 100 && $0 >= -1_000_000
    } ?? true
    let percentageIsConsistent: Bool
    if let reduction = projection.reductionPercent {
      let claimEvidenceIsComplete = projection.evidenceLabel == "calculated" &&
        projection.qualityLabel == "held" &&
        projection.qualityEvidence.map(claimQualityEvidenceLabels.contains) == true
      let signMatchesState =
        (projection.state == "review_measured_result" && reduction >= 0) ||
        (projection.state == "rollback" && reduction < 0)
      percentageIsConsistent = claimEvidenceIsComplete && signMatchesState
    } else {
      percentageIsConsistent = projection.state != "review_measured_result"
    }
    return projection.schemaVersion == 0 &&
      projection.experimentId.wholeMatch(of: /tre_v0_[a-f0-9]{64}/) != nil &&
      projection.findingId.wholeMatch(of: /wf_v0_[a-f0-9]{64}/) != nil &&
      projection.candidateKey.wholeMatch(of: /wfc_v0_[a-f0-9]{64}/) != nil &&
      states.contains(projection.state) &&
      tones.contains(projection.tone) &&
      evidenceLabels.contains(projection.evidenceLabel) &&
      qualityLabels.contains(projection.qualityLabel) &&
      (projection.qualityEvidence == nil || qualityEvidenceLabels.contains(projection.qualityEvidence!)) &&
      projection.baselineSessions >= 0 &&
      projection.postChangeSessions >= 0 &&
      projection.minimumSessions > 0 &&
      validReduction &&
      percentageIsConsistent
  }

  private static func signedReduction(_ value: Double) -> String {
    let magnitude = abs(value)
    // The canonical evaluator retains two decimal places. Preserve a small,
    // non-zero result instead of rounding it into the false claim “−0%”.
    let amount = magnitude < 1
      ? String(format: "%.2f", magnitude)
      : String(Int(magnitude.rounded()))
    return value >= 0 ? "−\(amount)%" : "+\(amount)%"
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
