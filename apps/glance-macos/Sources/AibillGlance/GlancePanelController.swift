import AppKit
import SwiftUI

@MainActor
final class GlancePanelController: NSObject {
  static let triggerSize = NSSize(width: 58, height: 20)
  static let expandedSize = NSSize(width: 452, height: 382)

  private let store: GlanceStore
  private let triggerPanel: NSPanel
  private let detailPanel: NSPanel
  private let hostScreen: NSScreen
  private let launchAtLogin = LaunchAtLoginController()
  private let updater: GlanceUpdaterController
  private var hoverTimer: Timer?
  private weak var launchAtLoginItem: NSMenuItem?
  private var expanded = false
  private var triggerVisible = false
  private var lastHoverDate = Date.distantPast

  init(store: GlanceStore, updater: GlanceUpdaterController) {
    self.store = store
    self.updater = updater
    hostScreen = NSScreen.main ?? NSScreen.screens[0]
    triggerPanel = NSPanel(
      contentRect: NSRect(origin: .zero, size: Self.triggerSize),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    detailPanel = NSPanel(
      contentRect: NSRect(origin: .zero, size: Self.expandedSize),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    super.init()
    configure(triggerPanel, title: "aibill Glance trigger", hasShadow: false)
    // The SwiftUI card owns the rounded shadow. An NSPanel shadow follows the
    // rectangular window bounds and can leave a faint box outside the glass.
    configure(detailPanel, title: "aibill Glance", hasShadow: false)

    let triggerHost = NSHostingView(rootView: GlanceTriggerView())
    configureHostingView(triggerHost, cornerRadius: Self.triggerSize.height / 2)
    triggerPanel.contentView = triggerHost

    let detailHost = NSHostingView(rootView: GlanceView(store: store))
    configureHostingView(detailHost, cornerRadius: 30)
    detailPanel.contentView = detailHost
    detailPanel.alphaValue = 0
    detailPanel.orderOut(nil)
    triggerPanel.alphaValue = 0
    triggerPanel.orderOut(nil)
    triggerPanel.setFrame(triggerFrame(), display: true)
    detailPanel.setFrame(detailFrame(), display: true)
    configureContextMenu()

    let timer = Timer(
      timeInterval: 0.08,
      target: self,
      selector: #selector(updateHoverState),
      userInfo: nil,
      repeats: true
    )
    RunLoop.main.add(timer, forMode: .common)
    hoverTimer = timer
  }

  func show() {
    setExpanded(false, animated: false)
    triggerPanel.setFrame(triggerFrame(), display: true)
    triggerVisible = false
    triggerPanel.alphaValue = 0
    triggerPanel.orderOut(nil)
  }

  func hide() {
    setExpanded(false, animated: false)
    triggerVisible = false
    triggerPanel.alphaValue = 0
    triggerPanel.orderOut(nil)
  }

  private func setTriggerVisible(_ value: Bool, animated: Bool = true) {
    guard triggerVisible != value else { return }
    triggerVisible = value

    if value {
      triggerPanel.setFrame(triggerFrame(), display: true)
      triggerPanel.alphaValue = animated ? 0 : 1
      triggerPanel.orderFrontRegardless()
      guard animated else { return }
      NSAnimationContext.runAnimationGroup { context in
        context.duration = 0.16
        context.timingFunction = CAMediaTimingFunction(name: .easeOut)
        triggerPanel.animator().alphaValue = 1
      }
    } else {
      guard animated else {
        triggerPanel.alphaValue = 0
        triggerPanel.orderOut(nil)
        return
      }
      NSAnimationContext.runAnimationGroup({ context in
        context.duration = 0.14
        context.timingFunction = CAMediaTimingFunction(name: .easeIn)
        triggerPanel.animator().alphaValue = 0
      }, completionHandler: { [weak self] in
        Task { @MainActor in
          guard let self, !self.triggerVisible else { return }
          self.triggerPanel.orderOut(nil)
        }
      })
    }
  }

  private func setExpanded(_ value: Bool, animated: Bool = true) {
    guard expanded != value else { return }
    expanded = value
    let finalFrame = detailFrame()

    guard animated else {
      detailPanel.setFrame(finalFrame, display: true)
      detailPanel.alphaValue = value ? 1 : 0
      value ? detailPanel.orderFrontRegardless() : detailPanel.orderOut(nil)
      return
    }

    if value {
      detailPanel.setFrame(finalFrame.offsetBy(dx: 0, dy: 12), display: true)
      detailPanel.alphaValue = 0
      detailPanel.orderFrontRegardless()
      NSAnimationContext.runAnimationGroup { context in
        context.duration = 0.3
        context.timingFunction = CAMediaTimingFunction(name: .easeOut)
        detailPanel.animator().setFrame(finalFrame, display: true)
        detailPanel.animator().alphaValue = 1
      }
    } else {
      let hiddenFrame = finalFrame.offsetBy(dx: 0, dy: 10)
      NSAnimationContext.runAnimationGroup({ context in
        context.duration = 0.2
        context.timingFunction = CAMediaTimingFunction(name: .easeIn)
        detailPanel.animator().setFrame(hiddenFrame, display: true)
        detailPanel.animator().alphaValue = 0
      }, completionHandler: { [weak self] in
        Task { @MainActor in
          guard let self, !self.expanded else { return }
          self.detailPanel.orderOut(nil)
          self.detailPanel.setFrame(finalFrame, display: true)
        }
      })
    }
  }

  @objc private func updateHoverState() {
    let mouse = NSEvent.mouseLocation
    let overMenuBar = menuBarActivationFrame().contains(mouse)
    let overTrigger = triggerPanel.frame.contains(mouse)
    let overDetail = expanded
      && detailPanel.frame.insetBy(dx: -10, dy: -14).contains(mouse)

    setTriggerVisible(overMenuBar || overTrigger || overDetail || expanded)

    if overTrigger || overDetail {
      lastHoverDate = Date()
      setExpanded(true)
    } else if expanded, Date().timeIntervalSince(lastHoverDate) > 0.16 {
      setExpanded(false)
    }
  }

  private func configure(_ panel: NSPanel, title: String, hasShadow: Bool) {
    panel.title = title
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = hasShadow
    panel.level = .statusBar
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.becomesKeyOnlyIfNeeded = true
    panel.collectionBehavior = [
      .canJoinAllSpaces,
      .fullScreenAuxiliary,
      .stationary,
      .ignoresCycle
    ]
  }

  private func configureHostingView<Content: View>(
    _ view: NSHostingView<Content>,
    cornerRadius: CGFloat
  ) {
    view.wantsLayer = true
    view.layer?.backgroundColor = NSColor.clear.cgColor
    view.layer?.isOpaque = false
    view.layer?.cornerRadius = cornerRadius
    view.layer?.cornerCurve = .continuous
    view.layer?.masksToBounds = true
  }

  private func configureContextMenu() {
    let menu = NSMenu()
    let refreshItem = menu.addItem(
      withTitle: "Refresh now",
      action: #selector(refresh),
      keyEquivalent: "r"
    )
    refreshItem.target = self
    menu.addItem(.separator())
    let loginItem = menu.addItem(
      withTitle: launchAtLogin.menuTitle,
      action: #selector(toggleLaunchAtLogin),
      keyEquivalent: ""
    )
    loginItem.target = self
    launchAtLoginItem = loginItem
    let updateItem = menu.addItem(
      withTitle: updater.menuTitle,
      action: #selector(checkForUpdates),
      keyEquivalent: ""
    )
    updateItem.target = self
    updateItem.isEnabled = updater.isConfigured
    menu.addItem(.separator())
    let quitItem = menu.addItem(
      withTitle: "Quit aibill Glance",
      action: #selector(quit),
      keyEquivalent: "q"
    )
    quitItem.target = self
    triggerPanel.contentView?.menu = menu
  }

  @objc private func refresh() {
    Task { await store.refresh() }
  }

  @objc private func toggleLaunchAtLogin() {
    switch launchAtLogin.toggle() {
    case .enabled, .disabled:
      launchAtLoginItem?.title = launchAtLogin.menuTitle
    case .requiresApproval:
      launchAtLoginItem?.title = launchAtLogin.menuTitle
    case .failed(let message):
      let alert = NSAlert()
      alert.alertStyle = .warning
      alert.messageText = "Could not change Launch at Login"
      alert.informativeText = message
      alert.runModal()
    }
  }

  @objc private func checkForUpdates() {
    updater.checkForUpdates()
  }

  @objc private func quit() {
    NSApp.terminate(nil)
  }

  private func triggerFrame() -> NSRect {
    let x: CGFloat
    if let leftArea = hostScreen.auxiliaryTopLeftArea,
       leftArea.width >= Self.triggerSize.width + 12 {
      x = leftArea.maxX - Self.triggerSize.width - 8
    } else {
      x = hostScreen.frame.midX - Self.triggerSize.width - 82
    }

    let menuBarHeight = currentMenuBarHeight()
    let y = hostScreen.frame.maxY
      - menuBarHeight
      + (menuBarHeight - Self.triggerSize.height) / 2
    return NSRect(origin: NSPoint(x: x, y: y), size: Self.triggerSize)
  }

  private func menuBarActivationFrame() -> NSRect {
    let height = currentMenuBarHeight()
    return NSRect(
      x: hostScreen.frame.minX,
      y: hostScreen.frame.maxY - height,
      width: hostScreen.frame.width,
      height: height
    )
  }

  private func currentMenuBarHeight() -> CGFloat {
    max(24, hostScreen.frame.maxY - hostScreen.visibleFrame.maxY)
  }

  private func detailFrame() -> NSRect {
    let top = hostScreen.visibleFrame.maxY - 6
    return NSRect(
      x: hostScreen.frame.midX - Self.expandedSize.width / 2,
      y: top - Self.expandedSize.height,
      width: Self.expandedSize.width,
      height: Self.expandedSize.height
    )
  }

}
