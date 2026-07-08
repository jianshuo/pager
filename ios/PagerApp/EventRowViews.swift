import SwiftUI

/// Renders a single `Event` by its body kind. This is the forward-compatible seam: every case
/// (including `.unknown`) renders *something* and never crashes, so a hub that grows new event
/// types degrades gracefully into a generic card rather than a blank screen or a trap.
struct EventRow: View {
    let event: Event
    /// True if this permission request has already been answered (locally or via a broadcast
    /// `permission_response`). Only meaningful for `.permissionRequest`.
    var isAnswered: Bool = false
    /// The choice that resolved this permission request ("allow"/"deny"), if known. Drives the
    /// resolved caption. Only meaningful for `.permissionRequest`.
    var answeredChoice: String? = nil
    /// Handler for a permission button tap: (requestId, choice).
    var onPermission: ((String, String) -> Void)? = nil

    var body: some View {
        switch event.body {
        case .text(let markdown, let author):
            TextBubble(markdown: markdown, role: event.role, author: author)
        case .system(let text):
            SystemLine(text: text)
        case .toolCard(let tool, let title, let summary, let detail, let diff):
            ToolCardView(tool: tool, title: title, summary: summary, detail: detail, diff: diff)
        case .permissionRequest(let requestId, let tool, let description, let options):
            PermissionRequestCard(
                requestId: requestId,
                tool: tool,
                description: description,
                options: options,
                isAnswered: isAnswered,
                answeredChoice: answeredChoice,
                onPermission: onPermission
            )
        case .status(let state, let note):
            StatusLine(state: state, note: note)
        case .permissionResponse:
            EmptyView()
        case .error(let message, _):
            Text(message)
                .font(.caption)
                .foregroundStyle(Theme.failRed)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 2)
        case .unknown(let type, _):
            UnknownCard(type: type)
        }
    }
}

// MARK: - Text bubble

private struct TextBubble: View {
    let markdown: String
    /// Event role: "user" for human messages, "agent" for the AI.
    let role: String
    /// Sender display name (only present on human messages in rooms). nil ⇒ treated as mine.
    let author: String?

    /// Mine = a human message I sent (no author, or author matches my username). Right green.
    private var isMine: Bool {
        role == "user" && (author == nil || author == Keychain.username)
    }

    /// The AI. Left cream bubble with the 百姓AI label + atom avatar.
    private var isAgent: Bool { role == "agent" }

    var body: some View {
        if isMine {
            userBubble
        } else if isAgent {
            aiBubble
        } else {
            humanBubble
        }
    }

    // 用户：绿底白字，右对齐，右上角 5px（其余 16px）
    private var userBubble: some View {
        HStack {
            Spacer(minLength: 40)
            rendered
                .foregroundStyle(Color.white)
                .padding(.horizontal, 13)
                .padding(.vertical, 9)
                .background(Theme.brandGreen)
                .clipShape(UnevenRoundedRectangle(
                    topLeadingRadius: 16, bottomLeadingRadius: 16,
                    bottomTrailingRadius: 16, topTrailingRadius: 5, style: .continuous))
                .frame(maxWidth: 300, alignment: .trailing)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    // AI：奶白气泡，左对齐，左上角 5px；上方琥珀「百姓AI」名，左侧原子头像
    private var aiBubble: some View {
        HStack(alignment: .top, spacing: 8) {
            AIAvatar(size: 32)
            VStack(alignment: .leading, spacing: 3) {
                Text("百姓AI")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Theme.amberText)
                rendered
                    .foregroundStyle(Theme.ink)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 9)
                    .background(Theme.cream)
                    .clipShape(UnevenRoundedRectangle(
                        topLeadingRadius: 5, bottomLeadingRadius: 16,
                        bottomTrailingRadius: 16, topTrailingRadius: 16, style: .continuous))
                    .overlay(
                        UnevenRoundedRectangle(
                            topLeadingRadius: 5, bottomLeadingRadius: 16,
                            bottomTrailingRadius: 16, topTrailingRadius: 16, style: .continuous)
                            .strokeBorder(Theme.aiBubbleBorder, lineWidth: 1))
            }
            Spacer(minLength: 40)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // 另一个人：奶白气泡，左对齐，左上角 5px；上方灰绿名字，左侧首字母头像（按名字取稳定颜色）
    private var humanBubble: some View {
        let name = author ?? ""
        return HStack(alignment: .top, spacing: 8) {
            HumanAvatar(name: name, size: 32)
            VStack(alignment: .leading, spacing: 3) {
                Text(name)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Theme.textSecondary)
                rendered
                    .foregroundStyle(Theme.ink)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 9)
                    .background(Theme.cream)
                    .clipShape(UnevenRoundedRectangle(
                        topLeadingRadius: 5, bottomLeadingRadius: 16,
                        bottomTrailingRadius: 16, topTrailingRadius: 16, style: .continuous))
                    .overlay(
                        UnevenRoundedRectangle(
                            topLeadingRadius: 5, bottomLeadingRadius: 16,
                            bottomTrailingRadius: 16, topTrailingRadius: 16, style: .continuous)
                            .strokeBorder(Theme.creamBorder, lineWidth: 1))
            }
            Spacer(minLength: 40)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// SwiftUI's `Text(.init(markdown))` parses inline markdown; if parsing fails we fall back to
    /// the raw string so nothing is ever dropped.
    private var rendered: Text {
        if let attributed = try? AttributedString(
            markdown: markdown,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            return Text(attributed)
        }
        return Text(markdown)
    }
}

// MARK: - Tool card (compact chip)

private struct ToolCardView: View {
    let tool: String
    let title: String
    let summary: String
    let detail: String
    let diff: String?

    @State private var expanded = false

    private var hasDetail: Bool {
        !detail.isEmpty || (diff.map { !$0.isEmpty } ?? false)
    }

    var body: some View {
        // 对齐到 AI 气泡下方（左缩进越过头像 ~40）
        VStack(alignment: .leading, spacing: 6) {
            chip
            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    if !detail.isEmpty { monoBlock(detail) }
                    if let diff, !diff.isEmpty { monoBlock(diff) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 40)
    }

    private var chip: some View {
        Button {
            guard hasDetail else { return }
            withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.left.forwardslash.chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.iconGreen)
                Text(chipLabel)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(Theme.toolMono)
                    .lineLimit(1)
                if !summary.isEmpty {
                    Text(summary)
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                }
                if hasDetail {
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(Theme.textTertiary)
                }
            }
            .padding(.vertical, 7)
            .padding(.horizontal, 11)
            .background(Theme.toolChipBG)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Theme.toolChipBorder, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private var chipLabel: String {
        let base = "\(tool) · \(title)".trimmingCharacters(in: .whitespaces)
        return base == "·" ? "工具" : base
    }

    private func monoBlock(_ text: String) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Theme.toolMono)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(10)
        }
        .frame(maxHeight: 260)
        .background(Theme.cream)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Theme.toolChipBorder, lineWidth: 1))
    }
}

// MARK: - Permission request card (amber)

private struct PermissionRequestCard: View {
    let requestId: String
    let tool: String
    let description: String
    let options: [String]
    let isAnswered: Bool
    let answeredChoice: String?
    let onPermission: ((String, String) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 6) {
                Image(systemName: "shield")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.amberText)
                Text("权限请求")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Theme.amberText)
                if !tool.isEmpty {
                    Text(tool)
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Theme.amberText)
                }
            }
            if !description.isEmpty {
                Text(description)
                    .font(.system(size: 12.5, design: .monospaced))
                    .foregroundStyle(Theme.permMono)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if isAnswered {
                HStack(spacing: 5) {
                    Image(systemName: answeredChoice == "deny" ? "xmark.circle.fill" : "checkmark.circle.fill")
                        .font(.system(size: 12))
                    Text(resolvedCaption)
                        .font(.system(size: 12, weight: .medium))
                }
                .foregroundStyle(answeredChoice == "deny" ? Theme.denyBtnText : Theme.deepGreen)
            } else {
                HStack(spacing: 10) {
                    Button {
                        onPermission?(requestId, "allow")
                    } label: {
                        Text("允许")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(Color.white)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(Theme.brandGreen)
                            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                    }
                    .buttonStyle(.plain)

                    Button {
                        onPermission?(requestId, "deny")
                    } label: {
                        Text("拒绝")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(Theme.denyBtnText)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(Theme.cream)
                            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 11, style: .continuous)
                                    .strokeBorder(Theme.denyBtnBorder, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.permBG)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Theme.permBorder, lineWidth: 1))
        .padding(.leading, 40)
    }

    private var resolvedCaption: String {
        switch answeredChoice {
        case "allow": return "已允许"
        case "deny": return "已拒绝"
        default: return "已回复"
        }
    }
}

// MARK: - Status line

private struct StatusLine: View {
    let state: String
    let note: String?

    @State private var pulse = false

    var body: some View {
        Group {
            switch state {
            case "running", "thinking":
                runningPill
            case "done":
                doneCaption
            case "failed":
                failedCaption
            default:
                doneCaption
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.vertical, 2)
    }

    private var runningPill: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(Theme.runningGreen)
                .frame(width: 7, height: 7)
                .scaleEffect(pulse ? 1.0 : 0.6)
                .opacity(pulse ? 1.0 : 0.4)
                .onAppear {
                    withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
                        pulse = true
                    }
                }
            Text(noteSuffixed(state == "thinking" ? "思考中" : "运行中"))
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.deepGreen)
        }
        .padding(.vertical, 5)
        .padding(.horizontal, 12)
        .background(Theme.statusPillBG)
        .clipShape(Capsule())
    }

    private var doneCaption: some View {
        Text(noteSuffixed("✓ 完成"))
            .font(.system(size: 11))
            .foregroundStyle(Theme.textTertiary)
    }

    private var failedCaption: some View {
        Text(noteSuffixed("✗ 失败"))
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Theme.failRed)
    }

    private func noteSuffixed(_ base: String) -> String {
        if let note, !note.isEmpty { return "\(base) · \(note)" }
        return base
    }
}

// MARK: - System line (进群/退群/建群)

private struct SystemLine: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.system(size: 11))
            .foregroundStyle(Theme.textTertiary)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Theme.cream.opacity(0.6))
            .clipShape(Capsule())
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 2)
    }
}

// MARK: - Unknown (forward-compat)

private struct UnknownCard: View {
    let type: String

    var body: some View {
        Text("未知事件 · \(type)")
            .font(.system(size: 11))
            .foregroundStyle(Theme.textTertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8)
            .padding(.horizontal, 11)
            .background(Theme.toolChipBG)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Theme.toolChipBorder, lineWidth: 1))
            .padding(.leading, 40)
    }
}
