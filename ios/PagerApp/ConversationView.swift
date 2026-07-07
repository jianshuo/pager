import SwiftUI

/// The live event stream for one conversation: a scrolling transcript of `EventRow`s plus a
/// composer at the bottom. Subscribes on appear, unsubscribes on disappear, auto-scrolls to the
/// newest event, and answers permission requests inline.
struct ConversationView: View {
    let conv: String
    /// Best-effort title bits (machine name + dir) captured at navigation time. The events
    /// stream doesn't carry them, so we thread them through from the list.
    var machineName: String? = nil
    var dir: String? = nil

    @Environment(AppModel.self) private var model

    @State private var draft = ""
    /// Permission request_ids answered locally this session, mapped to the chosen option, so the
    /// buttons flip to a resolved state immediately — before the broadcast echo arrives.
    @State private var locallyAnswered: [String: String] = [:]

    var body: some View {
        VStack(spacing: 0) {
            transcript
            Divider().overlay(Theme.creamBorder)
            composer
        }
        .background(Theme.chatBG.ignoresSafeArea())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.barBG, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .tint(Theme.brandGreen)
        .onAppear { model.openConversation(conv) }
        .onDisappear { model.closeConversation(conv) }
    }

    // MARK: - Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(events) { event in
                        EventRow(
                            event: event,
                            isAnswered: isAnswered(event),
                            answeredChoice: answeredChoice(event),
                            onPermission: handlePermission
                        )
                        .id(event.id)
                    }
                    Color.clear.frame(height: 1).id(bottomAnchor)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            }
            .background(Theme.chatBG)
            .onChange(of: events.count) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(bottomAnchor, anchor: .bottom)
                }
            }
            .onAppear {
                proxy.scrollTo(bottomAnchor, anchor: .bottom)
            }
        }
    }

    private let bottomAnchor = "conv-bottom"

    private var events: [Event] { model.events(for: conv) }

    // MARK: - Composer

    private var composer: some View {
        HStack(spacing: 8) {
            Button {
                // v2: 语音输入占位
            } label: {
                Image(systemName: "mic")
                    .font(.system(size: 17))
                    .foregroundStyle(Theme.textTertiary)
            }
            .disabled(true)

            TextField("", text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .foregroundStyle(Theme.ink)
                .tint(Theme.brandGreen)
                .lineLimit(1...5)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Theme.cream)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .strokeBorder(Theme.creamBorder, lineWidth: 1))
                .overlay(alignment: .leading) {
                    if draft.isEmpty {
                        Text("发消息…")
                            .foregroundStyle(Theme.textTertiary)
                            .padding(.leading, 14)
                            .allowsHitTesting(false)
                    }
                }
                .onSubmit(send)

            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(Color.white)
                    .frame(width: 36, height: 36)
                    .background(trimmedDraft.isEmpty ? Theme.brandGreen.opacity(0.4) : Theme.brandGreen)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(trimmedDraft.isEmpty)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.barBG)
    }

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func send() {
        let text = trimmedDraft
        guard !text.isEmpty else { return }
        model.sendText(conv: conv, markdown: text)
        draft = ""
    }

    // MARK: - Permission handling

    private func handlePermission(_ requestId: String, _ choice: String) {
        locallyAnswered[requestId] = choice
        Task { await model.permissionRespond(conv: conv, requestId: requestId, choice: choice) }
    }

    /// A permission request is answered if we answered it locally this session OR a
    /// `permission_response` with the same request_id has arrived over the wire.
    private func isAnswered(_ event: Event) -> Bool {
        guard case .permissionRequest(let requestId, _, _, _) = event.body else { return false }
        return answeredChoice(event) != nil || locallyAnswered[requestId] != nil
    }

    /// The choice ("allow"/"deny") that resolved this permission request, preferring the wire
    /// echo, falling back to the local optimistic answer.
    private func answeredChoice(_ event: Event) -> String? {
        guard case .permissionRequest(let requestId, _, _, _) = event.body else { return nil }
        for e in events {
            if case .permissionResponse(let rid, let choice) = e.body, rid == requestId {
                return choice
            }
        }
        return locallyAnswered[requestId]
    }

    // MARK: - Title

    private var title: String {
        if let summary = model.conversations.first(where: { $0.id == conv }) {
            return "\(summary.machineName) · \(shorten(summary.dir))"
        }
        if let machineName {
            return dir.map { "\(machineName) · \(shorten($0))" } ?? machineName
        }
        return "对话"
    }

    private func shorten(_ path: String) -> String {
        (path as NSString).lastPathComponent
    }
}
