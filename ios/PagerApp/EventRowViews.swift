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
        case .text(let markdown):
            TextBubble(markdown: markdown, isUser: event.role == "user")
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
                .foregroundStyle(.red)
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
    let isUser: Bool

    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 40) }
            rendered
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(isUser ? Color.accentColor : Color(.secondarySystemBackground))
                .foregroundStyle(isUser ? Color.white : Color.primary)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
            if !isUser { Spacer(minLength: 40) }
        }
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

// MARK: - Tool card

private struct ToolCardView: View {
    let tool: String
    let title: String
    let summary: String
    let detail: String
    let diff: String?

    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 8) {
                if !detail.isEmpty {
                    scrollableMono(detail)
                }
                if let diff, !diff.isEmpty {
                    scrollableMono(diff)
                }
            }
            .padding(.top, 6)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(tool) \(title)".trimmingCharacters(in: .whitespaces))
                    .font(.system(.footnote, design: .monospaced))
                    .lineLimit(1)
                if !summary.isEmpty {
                    Text(summary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(12)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func scrollableMono(_ text: String) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxHeight: 260)
    }
}

// MARK: - Permission request card

private struct PermissionRequestCard: View {
    let requestId: String
    let tool: String
    let description: String
    let options: [String]
    let isAnswered: Bool
    let answeredChoice: String?
    let onPermission: ((String, String) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(tool.isEmpty ? "权限请求" : tool, systemImage: "lock.shield")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.orange)
            if !description.isEmpty {
                Text(description)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if isAnswered {
                Text(resolvedCaption)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 10) {
                    Button {
                        onPermission?(requestId, "allow")
                    } label: {
                        Text("允许").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)

                    Button(role: .destructive) {
                        onPermission?(requestId, "deny")
                    } label: {
                        Text("拒绝").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.orange.opacity(0.35), lineWidth: 1)
        )
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

    var body: some View {
        Text(caption)
            .font(.caption)
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 2)
    }

    private var caption: String {
        let base: String
        switch state {
        case "done": base = "✓ done"
        case "failed": base = "✗ failed"
        case "running": base = "● running"
        case "thinking": base = "○ thinking"
        default: base = state
        }
        if let note, !note.isEmpty { return "\(base) · \(note)" }
        return base
    }

    private var color: Color {
        switch state {
        case "failed": return .red
        case "done": return .secondary
        default: return .secondary
        }
    }
}

// MARK: - Unknown (forward-compat)

private struct UnknownCard: View {
    let type: String

    var body: some View {
        Text("未知事件: \(type)")
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(Color(.tertiarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}
