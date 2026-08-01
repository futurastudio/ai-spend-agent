import Foundation
import Sparkle

/// Sparkle is intentionally dormant in source/local builds. A release build
/// activates it only after build-app.sh embeds both a HTTPS appcast URL and
/// the matching EdDSA public key in Info.plist.
@MainActor
final class GlanceUpdaterController {
  private let controller: SPUStandardUpdaterController?

  init(bundle: Bundle = .main) {
    let feed = bundle.object(forInfoDictionaryKey: "SUFeedURL") as? String
    let publicKey = bundle.object(forInfoDictionaryKey: "SUPublicEDKey") as? String
    guard
      let feed,
      let url = URL(string: feed),
      url.scheme?.lowercased() == "https",
      let publicKey,
      !publicKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else {
      controller = nil
      return
    }
    controller = SPUStandardUpdaterController(
      startingUpdater: true,
      updaterDelegate: nil,
      userDriverDelegate: nil
    )
  }

  var isConfigured: Bool {
    controller != nil
  }

  var menuTitle: String {
    isConfigured ? "Check for Updates…" : "Updates unavailable in local build"
  }

  func checkForUpdates() {
    controller?.checkForUpdates(nil)
  }
}
