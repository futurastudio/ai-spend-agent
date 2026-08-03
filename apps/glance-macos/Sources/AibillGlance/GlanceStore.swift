import Foundation
import SwiftUI

@MainActor
final class GlanceStore: ObservableObject {
  static let refreshInterval: TimeInterval = 30

  @Published private(set) var snapshot: UsageGlanceSnapshot?
  @Published private(set) var isRefreshing = false
  @Published private(set) var errorMessage: String?
  @Published private(set) var refreshedAt: Date?
  @Published private(set) var lastAttemptAt: Date?
  @Published private(set) var consecutiveFailures = 0

  private var refreshLoopStarted = false

  func startRefreshLoop() async {
    guard !refreshLoopStarted else { return }
    refreshLoopStarted = true
    while !Task.isCancelled {
      let cycleStartedAt = Date()
      await refresh()
      let delay = Self.nextRefreshDelay(
        elapsedSeconds: Date().timeIntervalSince(cycleStartedAt)
      )
      if delay > 0 {
        try? await Task.sleep(for: .seconds(delay))
      }
    }
  }

  static func nextRefreshDelay(elapsedSeconds: TimeInterval) -> TimeInterval {
    max(0, refreshInterval - max(0, elapsedSeconds))
  }

  func refresh() async {
    guard !isRefreshing else { return }
    isRefreshing = true
    lastAttemptAt = Date()
    defer { isRefreshing = false }
    do {
      let next = try await Task.detached(priority: .utility) {
        try SnapshotLoader.load()
      }.value
      snapshot = next
      refreshedAt = Date()
      errorMessage = nil
      consecutiveFailures = 0
    } catch {
      errorMessage = error.localizedDescription
      consecutiveFailures += 1
    }
  }

  func refreshPresentation(at now: Date) -> GlanceRefreshPresentation {
    GlanceRefreshPresentation.build(
      now: now,
      refreshedAt: refreshedAt,
      isRefreshing: isRefreshing,
      errorMessage: errorMessage,
      consecutiveFailures: consecutiveFailures,
      hasSnapshot: snapshot != nil
    )
  }
}

struct GlancePrimaryActionPresentation: Equatable {
  enum Intent: Equatable {
    case copy
    case refresh
    case none
  }

  let intent: Intent
  let label: String
  let symbol: String
  let isEnabled: Bool

  static func build(
    actionAvailable: Bool,
    actionCopied: Bool,
    refresh: GlanceRefreshPresentation,
    isRefreshing: Bool
  ) -> Self {
    if actionAvailable && refresh.allowsEvidenceCopy {
      return Self(
        intent: .copy,
        label: actionCopied ? "Copied" : "Copy",
        symbol: actionCopied ? "checkmark" : "doc.on.doc",
        isEnabled: true
      )
    }
    if isRefreshing {
      return Self(
        intent: .none,
        label: "Updating",
        symbol: "arrow.clockwise",
        isEnabled: false
      )
    }
    return Self(
      intent: .refresh,
      label: "Refresh",
      symbol: "arrow.clockwise",
      isEnabled: true
    )
  }
}

struct GlanceRefreshPresentation: Equatable {
  enum State: Equatable {
    case loading
    case fresh
    case stale
    case failed
  }

  static let staleAfter: TimeInterval = 75

  let state: State
  let label: String
  let help: String
  let symbol: String

  var allowsEvidenceCopy: Bool { state == .fresh }

  static func build(
    now: Date,
    refreshedAt: Date?,
    isRefreshing: Bool,
    errorMessage: String?,
    consecutiveFailures: Int,
    hasSnapshot: Bool
  ) -> Self {
    if let errorMessage {
      if let refreshedAt, hasSnapshot {
        let age = ageLabel(now.timeIntervalSince(refreshedAt))
        return Self(
          state: .failed,
          label: "Refresh failed · showing \(age)-old data",
          help: "\(errorMessage) The last successful local snapshot is still shown. Right-click aibill and choose Refresh now to retry.",
          symbol: "exclamationmark.triangle.fill"
        )
      }
      return Self(
        state: .failed,
        label: "Refresh failed · no current data",
        help: "\(errorMessage) Right-click aibill and choose Refresh now after checking the local CLI.",
        symbol: "exclamationmark.triangle.fill"
      )
    }

    guard let refreshedAt else {
      return Self(
        state: .loading,
        label: isRefreshing ? "Updating local data…" : "Waiting for first refresh…",
        help: "Glance is waiting for its first successful local aibill snapshot.",
        symbol: "arrow.triangle.2.circlepath"
      )
    }

    let ageSeconds = max(0, now.timeIntervalSince(refreshedAt))
    let age = ageLabel(ageSeconds)
    if ageSeconds >= staleAfter {
      let attempts = consecutiveFailures > 0
        ? " \(consecutiveFailures) refresh attempt\(consecutiveFailures == 1 ? "" : "s") failed."
        : ""
      return Self(
        state: .stale,
        label: "Stale · updated \(age) ago",
        help: "The local snapshot is older than \(Int(staleAfter)) seconds.\(attempts) Right-click aibill and choose Refresh now.",
        symbol: "clock.badge.exclamationmark.fill"
      )
    }

    return Self(
      state: .fresh,
      label: "Updated \(age) ago",
      help: "The last local aibill snapshot completed \(age) ago. Glance refreshes every 30 seconds while it is running.",
      symbol: "checkmark.circle.fill"
    )
  }

  private static func ageLabel(_ interval: TimeInterval) -> String {
    let seconds = max(0, Int(interval.rounded(.down)))
    if seconds < 5 { return "just now" }
    if seconds < 60 { return "\(seconds)s" }
    let minutes = seconds / 60
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60
    return "\(hours)h"
  }
}
