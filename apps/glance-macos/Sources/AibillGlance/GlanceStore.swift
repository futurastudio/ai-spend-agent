import Foundation
import SwiftUI

@MainActor
final class GlanceStore: ObservableObject {
  @Published private(set) var snapshot: UsageGlanceSnapshot?
  @Published private(set) var isRefreshing = false
  @Published private(set) var errorMessage: String?
  @Published private(set) var refreshedAt: Date?

  private var refreshLoopStarted = false

  func startRefreshLoop() async {
    guard !refreshLoopStarted else { return }
    refreshLoopStarted = true
    while !Task.isCancelled {
      await refresh()
      try? await Task.sleep(for: .seconds(30))
    }
  }

  func refresh() async {
    guard !isRefreshing else { return }
    isRefreshing = true
    defer { isRefreshing = false }
    do {
      let next = try await Task.detached(priority: .utility) {
        try SnapshotLoader.load()
      }.value
      snapshot = next
      refreshedAt = Date()
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}
