import Foundation
import ServiceManagement

@MainActor
final class LaunchAtLoginController {
  enum ToggleResult {
    case enabled
    case disabled
    case requiresApproval
    case failed(String)
  }

  private let service = SMAppService.mainApp

  var isEnabled: Bool {
    service.status == .enabled
  }

  var menuTitle: String {
    switch service.status {
    case .enabled:
      "Disable Launch at Login"
    case .requiresApproval:
      "Launch at Login Needs Approval"
    default:
      "Launch at Login"
    }
  }

  func toggle() -> ToggleResult {
    do {
      switch service.status {
      case .enabled:
        try service.unregister()
        return .disabled
      case .requiresApproval:
        SMAppService.openSystemSettingsLoginItems()
        return .requiresApproval
      default:
        try service.register()
        return service.status == .requiresApproval ? .requiresApproval : .enabled
      }
    } catch {
      return .failed(error.localizedDescription)
    }
  }
}
