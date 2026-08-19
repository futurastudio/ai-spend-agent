import AppKit
import SwiftUI

struct GlanceView: View {
  @ObservedObject var store: GlanceStore
  @State private var actionCopied = false

  private var session: UsageGlanceSnapshot.Session? { store.snapshot?.currentSession }
  private var fiveHour: UsageGlanceSnapshot.Limit? {
    store.snapshot?.limits.first(where: { $0.kind == "five-hour" })
  }
  private var weekly: UsageGlanceSnapshot.Limit? {
    store.snapshot?.limits.first(where: { $0.kind == "weekly" })
  }

  var body: some View {
    expanded
      .transition(.opacity.combined(with: .move(edge: .top)))
    .frame(
      width: GlancePanelController.expandedSize.width,
      height: GlancePanelController.expandedSize.height,
      alignment: .top
    )
    .background {
      VisualEffectView(material: .hudWindow, blendingMode: .behindWindow)
      LinearGradient(
        colors: [
          Color.white.opacity(0.05),
          Color(red: 0.02, green: 0.04, blue: 0.07).opacity(0.58),
          Color(red: 0.02, green: 0.12, blue: 0.11).opacity(0.44)
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      )
    }
    .clipShape(RoundedRectangle(cornerRadius: 30, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 30, style: .continuous)
        .strokeBorder(
          LinearGradient(
            colors: [
              Color.white.opacity(0.28),
              Color(red: 0.37, green: 0.95, blue: 0.67).opacity(0.42),
              Color.white.opacity(0.09)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          ),
          lineWidth: 1
        )
    }
    .contentShape(Rectangle())
    .task {
      await store.startRefreshLoop()
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("aibill Glance")
    .accessibilityHint("Move the pointer away to hide the panel.")
  }

  private var expanded: some View {
    VStack(spacing: 10) {
      sessionHeader

      HStack(spacing: 8) {
        limitCard(title: "5-hour window", kind: "five-hour", limit: fiveHour)
        limitCard(title: "Weekly window", kind: "weekly", limit: weekly)
      }

      focusRow
      TimelineView(.periodic(from: .now, by: 1)) { timeline in
        primaryActionRow(at: timeline.date)
      }

      TimelineView(.periodic(from: .now, by: 1)) { timeline in
        footer(at: timeline.date)
      }
    }
    .padding(.horizontal, 18)
    .padding(.top, 18)
    .padding(.bottom, 13)
  }

  private var sessionHeader: some View {
    HStack(alignment: .top) {
      VStack(alignment: .leading, spacing: 3) {
        Text(session?.status == "active" ? "CURRENT SESSION · LOCAL TOKENS × API LIST RATES" : "LATEST SESSION · LOCAL TOKENS × API LIST RATES")
          .font(.system(size: 9, weight: .semibold, design: .rounded))
          .foregroundStyle(.white.opacity(0.48))
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Text(GlanceFormatting.dollars(session?.apiEquivalentUsd))
            .font(.system(size: 31, weight: .semibold, design: .rounded))
            .tracking(-1.2)
          if let session {
            Text("\(GlanceFormatting.agentName(session.agent)) · \(GlanceFormatting.modelName(session.model))")
              .font(.system(size: 10, weight: .medium, design: .rounded))
              .foregroundStyle(.white.opacity(0.5))
              .lineLimit(1)
          }
        }
        Text(session?.project ?? "No active coding-agent session")
          .font(.system(size: 10, weight: .semibold, design: .rounded))
          .foregroundStyle(.white.opacity(0.74))
        Text(planSummary)
          .font(.system(size: 9, weight: .medium, design: .rounded))
          .foregroundStyle(.white.opacity(0.43))
          .lineLimit(1)
      }

      Spacer()

      HStack(spacing: 5) {
        Circle()
          .fill(session?.status == "active" ? Color.green : Color.white.opacity(0.45))
          .frame(width: 5, height: 5)
        Text(session.map { "\($0.status) · \($0.durationMinutes)m" } ?? "waiting")
      }
      .font(.system(size: 9, weight: .semibold, design: .rounded))
      .foregroundStyle(session?.status == "active" ? Color.green.opacity(0.92) : .white.opacity(0.5))
      .padding(.horizontal, 9)
      .padding(.vertical, 6)
      .background(Color.white.opacity(0.04), in: Capsule())
      .overlay(Capsule().stroke(Color.white.opacity(0.09), lineWidth: 1))
    }
    .frame(height: 88)
    .padding(.horizontal, 2)
    .help(sessionSourceHelp)
  }

  private func limitCard(
    title: String,
    kind: String,
    limit: UsageGlanceSnapshot.Limit?
  ) -> some View {
    let missing = missingLimitMessage(kind)
    return VStack(alignment: .leading, spacing: 7) {
      HStack {
        Text(title)
          .foregroundStyle(.white.opacity(0.56))
        Spacer()
        Text(limit.map {
          if $0.freshness == "stale" { return "Stale report" }
          if GlanceFormatting.isReportedExhausted($0) { return "Exhausted" }
          return "\(GlanceFormatting.percent($0.remainingPercent)) left"
        } ?? "Not reported")
          .fontWeight(.semibold)
          .foregroundStyle(limitColor(limit))
      }
      .font(.system(size: 10, weight: .medium, design: .rounded))

      GeometryReader { proxy in
        ZStack(alignment: .leading) {
          Capsule().fill(Color.white.opacity(0.08))
          Capsule()
            .fill(limitColor(limit).gradient)
            .frame(width: proxy.size.width * CGFloat((limit?.remainingPercent ?? 0) / 100))
        }
      }
      .frame(height: 4)

      Text(limit.map(limitProjectionLabel) ?? missing.primary)
        .font(.system(size: 9, weight: .semibold, design: .rounded))
        .foregroundStyle(.white.opacity(0.62))
        .lineLimit(1)
      Text(limit.map(limitReportedLabel) ?? missing.secondary)
        .font(.system(size: 9, weight: .medium, design: .rounded))
        .foregroundStyle(.white.opacity(0.34))
        .lineLimit(1)
    }
    .padding(12)
    .frame(maxWidth: .infinity, minHeight: 88, alignment: .topLeading)
    .background(Color.white.opacity(0.03), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(Color.white.opacity(0.075), lineWidth: 1)
    }
    .help(limitSourceHelp(kind: kind, limit: limit))
  }

  private var focusRow: some View {
    HStack(spacing: 10) {
      Image(systemName: "scope")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(Color.cyan.opacity(0.85))
        .frame(width: 28, height: 28)
        .background(Color.cyan.opacity(0.1), in: RoundedRectangle(cornerRadius: 9))

      VStack(alignment: .leading, spacing: 2) {
        Text("MAIN FOCUS · \(store.snapshot?.focus?.windowDays ?? 7)D · LOCAL ACTIVITY")
          .font(.system(size: 8, weight: .semibold, design: .rounded))
          .foregroundStyle(.white.opacity(0.36))
        Text(store.snapshot?.focus?.summary ?? "Waiting for local agent activity")
          .font(.system(size: 11, weight: .semibold, design: .rounded))
          .foregroundStyle(.white.opacity(0.86))
          .lineLimit(1)
        Text(focusContextLabel)
          .font(.system(size: 9, weight: .medium, design: .rounded))
          .foregroundStyle(.white.opacity(0.42))
          .lineLimit(1)
      }

      Spacer()

      VStack(alignment: .trailing, spacing: 2) {
        Text(store.snapshot?.focus.map { GlanceFormatting.percent($0.activitySharePercent) } ?? "—")
          .font(.system(size: 11, weight: .semibold, design: .rounded))
        Text("activity")
          .font(.system(size: 8, weight: .medium, design: .rounded))
          .foregroundStyle(.white.opacity(0.34))
      }
    }
    .padding(.horizontal, 11)
    .frame(height: 62)
    .background(Color.white.opacity(0.028), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 15, style: .continuous)
        .stroke(Color.white.opacity(0.07), lineWidth: 1)
    }
    .help(focusSourceHelp)
  }

  private func primaryActionRow(at now: Date) -> some View {
    let health = store.snapshot?.sessionHealth
    let color = contextHealthColor(health?.status)
    let action = store.snapshot?.primaryAction
    let refresh = store.refreshPresentation(at: now)
    let canCopy = action != nil && refresh.allowsEvidenceCopy
    let tokenTest = GlanceTokenExperimentPresentation.build(
      projection: store.snapshot?.tokenExperiment,
      evidenceCurrent: refresh.allowsEvidenceCopy
    )
    let affordance = GlancePrimaryActionPresentation.build(
      actionAvailable: action != nil,
      actionCopied: actionCopied,
      refresh: refresh,
      isRefreshing: store.isRefreshing
    )
    return VStack(spacing: 0) {
      Button {
        switch affordance.intent {
        case .copy:
          copyPrimaryAction()
        case .refresh:
          Task { await store.refresh() }
        case .none:
          break
        }
      } label: {
        HStack(spacing: 10) {
          Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .shadow(color: color.opacity(0.7), radius: 6)

          VStack(alignment: .leading, spacing: 2) {
            Text(action?.label ?? health?.headline ?? "Collecting local context history")
              .font(.system(size: 10, weight: .semibold, design: .rounded))
              .foregroundStyle(.white.opacity(0.87))
              .lineLimit(1)
            Text(action?.detail ?? "Glance will suggest one evidence-backed next move.")
              .font(.system(size: 9, weight: .medium, design: .rounded))
              .foregroundStyle(.white.opacity(0.4))
              .lineLimit(1)
          }

          Spacer()

          HStack(spacing: 4) {
            Image(systemName: affordance.symbol)
            Text(affordance.label)
          }
          .font(.system(size: 8, weight: .semibold, design: .rounded))
          .foregroundStyle(.white.opacity(affordance.isEnabled ? 0.62 : 0.3))
          .padding(.horizontal, 7)
          .padding(.vertical, 5)
          .background(Color.white.opacity(0.045), in: Capsule())
          .overlay(Capsule().stroke(Color.white.opacity(0.075), lineWidth: 1))
        }
        .padding(.horizontal, 11)
        .frame(height: tokenTest == nil ? 52 : 43)
      }
      .buttonStyle(.plain)
      .disabled(!affordance.isEnabled)
      .help(canCopy
        ? primaryActionSourceHelp
        : "Refresh Glance before copying a handoff; stale or failed snapshots are never copied as current evidence. \(refresh.help)")
      .accessibilityLabel(canCopy
        ? action.map { "\($0.label). \($0.detail)" } ?? "No next move available"
        : "Refresh aibill Glance")
      .accessibilityHint(canCopy
        ? "Copies a project-aware handoff prompt. Nothing runs automatically."
        : affordance.isEnabled
          ? "Refreshes the local evidence now."
          : "Wait for the current local refresh to finish.")

      if let tokenTest {
        HStack(spacing: 6) {
          Image(systemName: "chart.line.text.clipboard")
          Text(tokenTest.label)
            .lineLimit(1)
          Spacer(minLength: 0)
        }
        .font(.system(size: 8, weight: .medium, design: .rounded))
        .foregroundStyle(.white.opacity(0.48))
        .padding(.horizontal, 11)
        .frame(height: 17)
        .help(tokenExperimentSourceHelp)
        .accessibilityLabel("Token experiment status. \(tokenTest.label). Read only.")
      }
    }
    .frame(height: tokenTest == nil ? 52 : 60)
    .background(color.opacity(health?.status == "healthy" ? 0.018 : 0.04), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 15, style: .continuous)
        .stroke(color.opacity(health?.status == "healthy" ? 0.07 : 0.14), lineWidth: 1)
    }
  }

  private func copyPrimaryAction() {
    guard
      store.refreshPresentation(at: Date()).allowsEvidenceCopy,
      let prompt = store.snapshot?.primaryAction?.agentPrompt
    else {
      return
    }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(prompt, forType: .string)
    actionCopied = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
      actionCopied = false
    }
  }

  private func contextHealthColor(_ status: String?) -> Color {
    switch status {
    case "healthy":
      return .green
    case "start_fresh", "watch":
      return .orange
    default:
      return .white.opacity(0.45)
    }
  }

  private func limitColor(_ limit: UsageGlanceSnapshot.Limit?) -> Color {
    guard let limit else { return .white.opacity(0.28) }
    if limit.freshness == "stale" { return .white.opacity(0.42) }
    return limit.remainingPercent < 35 ? .orange : Color(red: 0.37, green: 0.95, blue: 0.67)
  }

  private var focusContextLabel: String {
    guard let focus = store.snapshot?.focus else {
      return "Task description unavailable"
    }
    var parts = [focus.kind.capitalized]
    if let project = focus.project {
      parts.append(project)
    }
    if let file = focus.file, file != focus.project {
      parts.append(file)
    }
    parts.append("\(focus.sessions) session\(focus.sessions == 1 ? "" : "s")")
    return parts.joined(separator: " · ")
  }

  private var planSummary: String {
    guard let plan = store.snapshot?.plan else {
      return "Plan not detected · API value is not a verified charge"
    }
    if plan.billing == "subscription" {
      if let monthlyUsd = plan.monthlyUsd {
        return "\(plan.planLabel) · \(GlanceFormatting.dollars(monthlyUsd))/mo · detected locally · API value ≠ added spend"
      }
      return "\(plan.planLabel) · subscription detected locally · API value ≠ added spend"
    }
    if plan.billing == "api_key" {
      return "API-key mode detected locally · estimated at public API rates"
    }
    return "\(plan.planLabel) · local billing signal · unverified"
  }

  private func limitProjectionLabel(_ limit: UsageGlanceSnapshot.Limit) -> String {
    if limit.freshness == "stale" { return "Refresh agent limits" }
    if GlanceFormatting.isReportedExhausted(limit) {
      return GlanceFormatting.exhaustionLabel(limit)
    }
    return "Local estimate · \(GlanceFormatting.exhaustionLabel(limit))"
  }

  private func limitReportedLabel(_ limit: UsageGlanceSnapshot.Limit) -> String {
    if limit.freshness == "stale" {
      return "\(GlanceFormatting.agentName(limit.agent)) · old transcript evidence"
    }
    return "\(GlanceFormatting.agentName(limit.agent)) reported · \(GlanceFormatting.resetLabel(limit.resetsAt))"
  }

  private func missingLimitMessage(_ kind: String) -> (primary: String, secondary: String) {
    let reported = Set(
      store.snapshot?.coverage.rateLimitMetadata?
        .flatMap(\.windowsReported) ?? []
    )
    if kind == "five-hour" && reported.contains("weekly") {
      return ("Only weekly was reported", "5h percentage not inferred")
    }
    if kind == "weekly" && reported.contains("five-hour") {
      return ("Only 5-hour was reported", "Weekly percentage not inferred")
    }
    let label = kind == "five-hour" ? "5-hour" : kind
    return ("No \(label) transcript window", "No percentage inferred")
  }

  private var coverageFooterText: String {
    let files = store.snapshot?.coverage.filesParsed ?? 0
    let agents = store.snapshot?.coverage.detectedAgents
      .map(GlanceFormatting.agentName)
      .joined(separator: " + ") ?? "Local transcripts"
    let qualitative = store.snapshot?.coverage.qualitative?.status
    let indexLabel = qualitative == "partial"
      ? "partial index"
      : qualitative == "unknown" ? "index unknown" : "index current"
    return "Local: \(agents) · \(files) files · \(indexLabel) · nothing uploaded"
  }

  private func footer(at now: Date) -> some View {
    let refresh = store.refreshPresentation(at: now)
    return HStack(spacing: 6) {
      Image(systemName: "lock.shield")
      Text(coverageFooterText)
        .lineLimit(1)
        .minimumScaleFactor(0.78)
      Spacer(minLength: 5)
      if store.isRefreshing {
        ProgressView()
          .controlSize(.mini)
      }
      Image(systemName: refresh.symbol)
        .foregroundStyle(refreshColor(refresh.state))
      Text(refresh.label)
        .lineLimit(1)
        .minimumScaleFactor(0.75)
    }
    .font(.system(size: 9, weight: .medium, design: .rounded))
    .foregroundStyle(.white.opacity(0.42))
    .padding(.horizontal, 3)
    .help("\(footerSourceHelp) \(refresh.help)")
  }

  private func refreshColor(
    _ state: GlanceRefreshPresentation.State
  ) -> Color {
    switch state {
    case .fresh:
      Color(red: 0.24, green: 0.94, blue: 0.57).opacity(0.82)
    case .loading:
      Color.white.opacity(0.45)
    case .stale, .failed:
      Color(red: 1, green: 0.58, blue: 0.18).opacity(0.9)
    }
  }

  private var sessionSourceHelp: String {
    let agent = session.map { GlanceFormatting.agentName($0.agent) } ?? "coding-agent"
    let date = store.snapshot?.provenance?.sessionValue.pricingAsOf ?? "the bundled rate-table date"
    return "Token counts, model, project, and timing come from this Mac's \(agent) transcript. The dollar value is calculated locally using published API list rates checked \(date); it is not a provider bill or subscription charge."
  }

  private func limitSourceHelp(
    kind: String,
    limit: UsageGlanceSnapshot.Limit?
  ) -> String {
    guard let limit else {
      return "No \(kind) percentage was present in the local transcript, so Glance does not infer one."
    }
    if limit.freshness == "stale" {
      return "\(GlanceFormatting.agentName(limit.agent)) reported this percentage in an older local transcript. Glance keeps it visible as stale evidence but does not use it as current runway or to recommend an action."
    }
    return "\(GlanceFormatting.agentName(limit.agent)) reported the remaining percentage and reset time in its local transcript. The exhaustion time is a separate local pace estimate."
  }

  private var focusSourceHelp: String {
    if let coverage = store.snapshot?.coverage.qualitative,
       coverage.status != "complete" {
      return "Main focus is withheld because the bounded qualitative index is \(coverage.status). \(coverage.readCompletely)/\(coverage.selectedFiles) selected files were read completely and \(coverage.skippedForBudget) eligible files were omitted by the byte budget."
    }
    let sessions = store.snapshot?.focus?.sessions ?? 0
    return "Derived locally from observed prompt and tool activity across \(sessions) session\(sessions == 1 ? "" : "s"). Raw prompt text is not returned by the Glance contract or uploaded."
  }

  private var primaryActionSourceHelp: String {
    guard let action = store.snapshot?.primaryAction else {
      return "Glance is waiting for enough local evidence to produce a next move."
    }
    return "This is a local session handoff—not the CLI financial apply plan. It uses the canonical Context Health contract, Main focus, and transcript-reported runway also exposed to CLI and MCP. Click to copy; Glance never runs it automatically. Confidence: \(action.confidence)."
  }

  private var tokenExperimentSourceHelp: String {
    guard store.snapshot?.tokenExperiment != nil else { return "" }
    return "The token-test line is a read-only projection from aibill's canonical matched-session evaluator. Glance does not recalculate a percentage, run the change, or call it cash savings or verified outcome ROI."
  }

  private var footerSourceHelp: String {
    "Glance reads Claude Code and Codex files already stored on this Mac. The refresh runs locally and uploads nothing."
  }

}

struct GlanceTriggerView: View {
  var body: some View {
    Text("aibill")
      .font(.system(size: 10, weight: .semibold, design: .rounded))
      .tracking(-0.2)
      .foregroundStyle(.primary.opacity(0.78))
      .frame(
        width: GlancePanelController.triggerSize.width,
        height: GlancePanelController.triggerSize.height
      )
      .background {
        VisualEffectView(material: .menu, blendingMode: .behindWindow)
        LinearGradient(
          colors: [
            Color.white.opacity(0.2),
            Color.white.opacity(0.045)
          ],
          startPoint: .topLeading,
          endPoint: .bottomTrailing
        )
      }
      .clipShape(Capsule())
      .overlay {
        Capsule()
          .stroke(
            LinearGradient(
              colors: [
                Color.white.opacity(0.34),
                Color.white.opacity(0.08)
              ],
              startPoint: .top,
              endPoint: .bottom
            ),
            lineWidth: 0.7
          )
      }
      .shadow(color: .black.opacity(0.16), radius: 7, y: 2)
      .contentShape(Capsule())
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("aibill Glance")
      .accessibilityHint("Hover to show current AI usage. Right-click for options.")
  }
}

private struct VisualEffectView: NSViewRepresentable {
  let material: NSVisualEffectView.Material
  let blendingMode: NSVisualEffectView.BlendingMode

  func makeNSView(context: Context) -> NSVisualEffectView {
    let view = NSVisualEffectView()
    view.material = material
    view.blendingMode = blendingMode
    view.state = .active
    return view
  }

  func updateNSView(_ nsView: NSVisualEffectView, context: Context) {
    nsView.material = material
    nsView.blendingMode = blendingMode
  }
}
