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
}
