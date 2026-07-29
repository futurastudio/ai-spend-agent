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
  }
}
