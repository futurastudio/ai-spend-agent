import AppKit
import Testing
@testable import AibillGlance

@Suite("Glance panel geometry")
struct GlancePanelGeometryTests {
  @Test("uses each display's own menu-bar coordinates")
  @MainActor
  func multiDisplayActivationFrames() {
    let builtIn = GlancePanelController.menuBarActivationFrame(
      screenFrame: NSRect(x: 0, y: 0, width: 1_512, height: 982),
      visibleFrame: NSRect(x: 0, y: 48, width: 1_512, height: 901)
    )
    let external = GlancePanelController.menuBarActivationFrame(
      screenFrame: NSRect(x: 1_512, y: -218, width: 1_920, height: 1_200),
      visibleFrame: NSRect(x: 1_512, y: -218, width: 1_920, height: 1_200)
    )

    #expect(builtIn == NSRect(x: 0, y: 949, width: 1_512, height: 33))
    #expect(external == NSRect(x: 1_512, y: 958, width: 1_920, height: 24))
    #expect(builtIn.contains(NSPoint(x: 600, y: 970)))
    #expect(external.contains(NSPoint(x: 2_400, y: 970)))
    #expect(!builtIn.contains(NSPoint(x: 2_400, y: 970)))
  }
}
