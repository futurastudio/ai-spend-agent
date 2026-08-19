import Foundation
import Testing
@testable import AibillGlance

@Suite("Glance refresh presentation")
struct GlanceRefreshPresentationTests {
  private let now = Date(timeIntervalSince1970: 1_000)

  @Test("shows a second-level fresh age")
  func freshAge() {
    let result = GlanceRefreshPresentation.build(
      now: now,
      refreshedAt: now.addingTimeInterval(-12),
      isRefreshing: false,
      errorMessage: nil,
      consecutiveFailures: 0,
      hasSnapshot: true
    )
    #expect(result.state == .fresh)
    #expect(result.label == "Updated 12s ago")
    #expect(result.allowsEvidenceCopy)
  }

  @Test("marks an old successful snapshot stale")
  func staleAge() {
    let result = GlanceRefreshPresentation.build(
      now: now,
      refreshedAt: now.addingTimeInterval(-76),
      isRefreshing: false,
      errorMessage: nil,
      consecutiveFailures: 0,
      hasSnapshot: true
    )
    #expect(result.state == .stale)
    #expect(result.label == "Stale · updated 1m ago")
    #expect(!result.allowsEvidenceCopy)
  }

  @Test("keeps the age visible when a refresh fails")
  func failedWithPriorSnapshot() {
    let result = GlanceRefreshPresentation.build(
      now: now,
      refreshedAt: now.addingTimeInterval(-43),
      isRefreshing: false,
      errorMessage: "aibill exited 1",
      consecutiveFailures: 1,
      hasSnapshot: true
    )
    #expect(result.state == .failed)
    #expect(result.label == "Refresh failed · showing 43s-old data")
    #expect(result.help.contains("last successful local snapshot"))
    #expect(!result.allowsEvidenceCopy)
  }

  @Test("does not imply data exists after the first refresh fails")
  func failedWithoutSnapshot() {
    let result = GlanceRefreshPresentation.build(
      now: now,
      refreshedAt: nil,
      isRefreshing: false,
      errorMessage: "command not found",
      consecutiveFailures: 1,
      hasSnapshot: false
    )
    #expect(result.state == .failed)
    #expect(result.label == "Refresh failed · no current data")
    #expect(!result.allowsEvidenceCopy)
  }

  @Test("keeps refresh starts on a 30-second cadence")
  @MainActor
  func refreshCadence() {
    #expect(GlanceStore.nextRefreshDelay(elapsedSeconds: 11) == 19)
    #expect(GlanceStore.nextRefreshDelay(elapsedSeconds: 30) == 0)
    #expect(GlanceStore.nextRefreshDelay(elapsedSeconds: 35) == 0)
  }

  @Test("offers a real refresh action when evidence is stale")
  func staleActionAffordance() {
    let refresh = GlanceRefreshPresentation.build(
      now: now,
      refreshedAt: now.addingTimeInterval(-76),
      isRefreshing: false,
      errorMessage: nil,
      consecutiveFailures: 0,
      hasSnapshot: true
    )
    let action = GlancePrimaryActionPresentation.build(
      actionAvailable: true,
      actionCopied: false,
      refresh: refresh,
      isRefreshing: false
    )
    #expect(action.intent == .refresh)
    #expect(action.label == "Refresh")
    #expect(action.isEnabled)
  }

  @Test("disables the affordance while a retry is already running")
  func updatingActionAffordance() {
    let refresh = GlanceRefreshPresentation.build(
      now: now,
      refreshedAt: now.addingTimeInterval(-76),
      isRefreshing: true,
      errorMessage: "prior failure",
      consecutiveFailures: 1,
      hasSnapshot: true
    )
    let action = GlancePrimaryActionPresentation.build(
      actionAvailable: true,
      actionCopied: false,
      refresh: refresh,
      isRefreshing: true
    )
    #expect(action.intent == .none)
    #expect(action.label == "Updating")
    #expect(!action.isEnabled)
  }

  @Test("keeps fresh evidence on the Copy action")
  func freshActionAffordance() {
    let refresh = GlanceRefreshPresentation.build(
      now: now,
      refreshedAt: now.addingTimeInterval(-12),
      isRefreshing: false,
      errorMessage: nil,
      consecutiveFailures: 0,
      hasSnapshot: true
    )
    let action = GlancePrimaryActionPresentation.build(
      actionAvailable: true,
      actionCopied: false,
      refresh: refresh,
      isRefreshing: false
    )
    #expect(action.intent == .copy)
    #expect(action.label == "Copy")
    #expect(action.isEnabled)
  }

  @Test("gives the local command more than the measured cold-scan headroom")
  func loaderTimeoutHeadroom() {
    #expect(SnapshotLoader.timeoutSeconds == 75)
  }

  @Test("does not render a positive sub-cent value as zero")
  func subCentCurrency() {
    #expect(GlanceFormatting.dollars(0.004) == "<$0.01")
    #expect(GlanceFormatting.dollars(nil) == "Unpriced")
  }

  @Test("labels a fresh zero-remaining report as exhausted, not projected")
  func exhaustedRunway() {
    let limit = UsageGlanceSnapshot.Limit(
      agent: "codex",
      kind: "five-hour",
      name: "five-hour",
      usedPercent: 100,
      remainingPercent: 0,
      windowMinutes: 300,
      observedAt: "2026-08-14T16:55:00.000Z",
      resetsAt: "2026-08-14T20:00:00.000Z",
      source: "transcript_reported",
      freshness: "current",
      projectedExhaustionAt: nil,
      projectedToExhaustBeforeReset: false,
      projectionConfidence: "estimated"
    )
    #expect(GlanceFormatting.isReportedExhausted(limit))
    #expect(GlanceFormatting.exhaustionLabel(limit) == "At reported limit · checkpoint work")
  }

  @Test("does not call a rounded near-limit report exhausted")
  func nearLimitIsNotExhausted() {
    let limit = UsageGlanceSnapshot.Limit(
      agent: "codex",
      kind: "five-hour",
      name: "five-hour",
      usedPercent: 99.96,
      remainingPercent: 0,
      windowMinutes: 300,
      observedAt: "2026-08-14T16:55:00.000Z",
      resetsAt: "2026-08-14T20:00:00.000Z",
      source: "transcript_reported",
      freshness: "current",
      projectedExhaustionAt: nil,
      projectedToExhaustBeforeReset: false,
      projectionConfidence: "estimated"
    )
    #expect(!GlanceFormatting.isReportedExhausted(limit))
    #expect(GlanceFormatting.exhaustionLabel(limit) == "On pace to stay below cap")
  }

  @Test("decodes old snapshots without a token experiment")
  func oldSnapshotCompatibility() throws {
    let payload = #"{"dataMode":"local_transcripts","generatedAt":"2026-08-15T12:00:00Z","coverage":{"filesParsed":0,"detectedAgents":[]},"limits":[]}"#
    let snapshot = try JSONDecoder().decode(
      UsageGlanceSnapshot.self,
      from: Data(payload.utf8)
    )
    #expect(snapshot.tokenExperiment == nil)
  }

  @Test("keeps the compact token test honest across lifecycle states")
  func tokenExperimentLifecycleLabels() {
    let collecting = GlanceTokenExperimentPresentation.build(
      projection: tokenExperiment(state: "collect_post_change", post: 2),
      evidenceCurrent: true
    )
    #expect(collecting?.label == "Token test · 2/3 matched")

    let measured = GlanceTokenExperimentPresentation.build(
      projection: tokenExperiment(
        state: "review_measured_result",
        evidence: "calculated",
        quality: "held",
        reduction: 18.2
      ),
      evidenceCurrent: true
    )
    #expect(measured?.label == "Measured −18% · quality user-declared")

    let smallMeasured = GlanceTokenExperimentPresentation.build(
      projection: tokenExperiment(
        state: "review_measured_result",
        evidence: "calculated",
        quality: "held",
        reduction: 0.4
      ),
      evidenceCurrent: true
    )
    #expect(smallMeasured?.label == "Measured −0.40% · quality user-declared")
    #expect(!(smallMeasured?.label.contains("−0%") ?? true))

    let unchanged = GlanceTokenExperimentPresentation.build(
      projection: tokenExperiment(
        state: "review_measured_result",
        evidence: "calculated",
        quality: "held",
        reduction: 0
      ),
      evidenceCurrent: true
    )
    #expect(unchanged?.label == "No measured token change · quality user-declared")
    #expect(!(unchanged?.label.contains("−0") ?? true))

    let regressed = GlanceTokenExperimentPresentation.build(
      projection: tokenExperiment(
        state: "rollback",
        evidence: "calculated",
        quality: "held",
        reduction: -8
      ),
      evidenceCurrent: true
    )
    #expect(regressed?.label == "Regressed · review rollback")

    let inconclusive = GlanceTokenExperimentPresentation.build(
      projection: tokenExperiment(state: "resolve_evidence"),
      evidenceCurrent: true
    )
    #expect(inconclusive?.label == "Inconclusive · quality evidence missing")

    let rolledBack = GlanceTokenExperimentPresentation.build(
      projection: tokenExperiment(state: "rolled_back"),
      evidenceCurrent: true
    )
    #expect(rolledBack?.label == "Token test rolled back")

    let cancelled = GlanceTokenExperimentPresentation.build(
      projection: tokenExperiment(state: "cancelled"),
      evidenceCurrent: true
    )
    #expect(cancelled?.label == "Token test cancelled")
  }

  @Test("never repeats an old measured percentage after refresh becomes stale or fails")
  func noncurrentTokenExperimentSuppressesPercentage() {
    let measured = tokenExperiment(
      state: "review_measured_result",
      evidence: "calculated",
      quality: "held",
      reduction: 18
    )
    let stale = GlanceRefreshPresentation.build(
      now: now,
      refreshedAt: now.addingTimeInterval(-76),
      isRefreshing: false,
      errorMessage: nil,
      consecutiveFailures: 0,
      hasSnapshot: true
    )
    let failed = GlanceRefreshPresentation.build(
      now: now,
      refreshedAt: now.addingTimeInterval(-12),
      isRefreshing: false,
      errorMessage: "aibill exited 1",
      consecutiveFailures: 1,
      hasSnapshot: true
    )

    for refresh in [stale, failed] {
      let presentation = GlanceTokenExperimentPresentation.build(
        projection: measured,
        evidenceCurrent: refresh.allowsEvidenceCopy
      )
      #expect(presentation?.label == "Token test unavailable · refresh")
      #expect(!(presentation?.label.contains("18") ?? true))
    }
  }

  @Test("degrades malformed token projections to unavailable")
  func malformedTokenExperimentUnavailable() {
    let malformed = tokenExperiment(
      experimentId: "../../experiment",
      state: "review_measured_result",
      evidence: "calculated",
      quality: "held",
      reduction: 18
    )
    let presentation = GlanceTokenExperimentPresentation.build(
      projection: malformed,
      evidenceCurrent: true
    )
    #expect(presentation?.label == "Token test unavailable")
    #expect(!(presentation?.label.contains("18") ?? true))
  }

  @Test("requires non-missing quality evidence for measured percentages")
  func measuredTokenExperimentRequiresQualityEvidence() {
    for qualityEvidence in ["verified", "observed", "user_declared"] {
      let presentation = GlanceTokenExperimentPresentation.build(
        projection: tokenExperiment(
          state: "review_measured_result",
          evidence: "calculated",
          quality: "held",
          qualityEvidence: qualityEvidence,
          reduction: 18
        ),
        evidenceCurrent: true
      )
      #expect(presentation?.label.contains("18%") == true)
    }

    for qualityEvidence in ["missing", nil] as [String?] {
      let presentation = GlanceTokenExperimentPresentation.build(
        projection: tokenExperiment(
          state: "review_measured_result",
          evidence: "calculated",
          quality: "held",
          qualityEvidence: qualityEvidence,
          reduction: 18
        ),
        evidenceCurrent: true
      )
      #expect(presentation?.label == "Token test unavailable")
    }
  }

  @Test("accepts canonical negative rollback percentages with complete evidence")
  func rollbackTokenExperimentAcceptsNegativePercentage() {
    for qualityEvidence in ["verified", "observed", "user_declared"] {
      let presentation = GlanceTokenExperimentPresentation.build(
        projection: tokenExperiment(
          state: "rollback",
          evidence: "calculated",
          quality: "held",
          qualityEvidence: qualityEvidence,
          reduction: -18
        ),
        evidenceCurrent: true
      )
      #expect(presentation?.label == "Regressed · review rollback")
    }
  }

  @Test("rejects either percentage sign outside result states")
  func nonResultTokenExperimentRejectsPercentage() {
    for state in [
      "collect_baseline", "approve_one_change", "collect_post_change",
      "resolve_evidence", "rolled_back", "cancelled"
    ] {
      for reduction in [-18.0, 18.0] {
        let presentation = GlanceTokenExperimentPresentation.build(
          projection: tokenExperiment(
            state: state,
            evidence: "calculated",
            quality: "held",
            qualityEvidence: "observed",
            reduction: reduction
          ),
          evidenceCurrent: true
        )
        #expect(presentation?.label == "Token test unavailable")
      }
    }
  }

  @Test("rejects forged percentage signs and incomplete regression evidence")
  func tokenExperimentRejectsForgedSignAndEvidence() {
    let negativeMeasured = GlanceTokenExperimentPresentation.build(
      projection: tokenExperiment(
        state: "review_measured_result",
        evidence: "calculated",
        quality: "held",
        qualityEvidence: "observed",
        reduction: -18
      ),
      evidenceCurrent: true
    )
    let zeroRollback = GlanceTokenExperimentPresentation.build(
      projection: tokenExperiment(
        state: "rollback",
        evidence: "calculated",
        quality: "held",
        qualityEvidence: "observed",
        reduction: 0
      ),
      evidenceCurrent: true
    )
    let positiveRollback = GlanceTokenExperimentPresentation.build(
      projection: tokenExperiment(
        state: "rollback",
        evidence: "calculated",
        quality: "held",
        qualityEvidence: "observed",
        reduction: 18
      ),
      evidenceCurrent: true
    )
    let missingRegressionEvidence = GlanceTokenExperimentPresentation.build(
      projection: tokenExperiment(
        state: "rollback",
        evidence: "missing",
        quality: "held",
        qualityEvidence: "observed",
        reduction: -18
      ),
      evidenceCurrent: true
    )

    #expect(negativeMeasured?.label == "Token test unavailable")
    #expect(zeroRollback?.label == "Token test unavailable")
    #expect(positiveRollback?.label == "Token test unavailable")
    #expect(missingRegressionEvidence?.label == "Token test unavailable")
  }

  private func tokenExperiment(
    experimentId: String = "tre_v0_" + String(repeating: "a", count: 64),
    state: String,
    evidence: String = "missing",
    quality: String = "insufficient",
    qualityEvidence: String? = "user_declared",
    baseline: Int = 3,
    post: Int = 0,
    reduction: Double? = nil
  ) -> UsageGlanceSnapshot.TokenExperiment {
    UsageGlanceSnapshot.TokenExperiment(
      schemaVersion: 0,
      experimentId: experimentId,
      findingId: "wf_v0_" + String(repeating: "b", count: 64),
      candidateKey: "wfc_v0_" + String(repeating: "c", count: 64),
      state: state,
      tone: "neutral",
      headline: "Canonical token-test projection",
      detail: "No cash-savings claim.",
      evidenceLabel: evidence,
      qualityLabel: quality,
      qualityEvidence: qualityEvidence,
      baselineSessions: baseline,
      postChangeSessions: post,
      minimumSessions: 3,
      reductionPercent: reduction
    )
  }
}
