import AppKit
import SwiftUI

@main
struct AibillGlanceApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

  var body: some Scene {
    Settings {
      EmptyView()
    }
  }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private let store = GlanceStore()
  private let updater = GlanceUpdaterController()
  private var panelController: GlancePanelController?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    panelController = GlancePanelController(store: store, updater: updater)
    panelController?.show()
  }
}
