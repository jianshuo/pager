import SwiftUI

/// The live transcript for one conversation plus a composer. Subscribes on appear, unsubscribes
/// on disappear, auto-scrolls to the newest event. For groups, a toolbar action adds members;
/// an overflow menu leaves the group.
struct ConversationView: View {
    let conv: String
    var title: String = "对话"

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var draft = ""
    @State private var showAddMember = false
    @FocusState private var composerFocused: Bool

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
        .toolbar {
            if isGroup {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { showAddMember = true } label: { Label("拉人进群", systemImage: "person.badge.plus") }
                        Button(role: .destructive) { leave() } label: { Label("退出群聊", systemImage: "rectangle.portrait.and.arrow.right") }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .tint(Theme.iconGreen)
                }
            }
        }
        .sheet(isPresented: $showAddMember) {
            AddMemberSheet(conv: conv)
        }
        .onAppear { model.openConversation(conv) }
        .onDisappear { model.closeConversation(conv) }
    }

    private var isGroup: Bool {
        model.conversations.first(where: { $0.id == conv })?.isGroup ?? false
    }

    // MARK: - Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(events) { event in
                        EventRow(event: event).id(event.id)
                    }
                    Color.clear.frame(height: 1).id(bottomAnchor)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            }
            .background(Theme.chatBG)
            .onChange(of: events.count) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomAnchor, anchor: .bottom) }
            }
            .onAppear { proxy.scrollTo(bottomAnchor, anchor: .bottom) }
        }
    }

    private let bottomAnchor = "conv-bottom"
    private var events: [Event] { model.events(for: conv) }

    // MARK: - Composer

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("", text: $draft, axis: .vertical)
                .focused($composerFocused)
                .textFieldStyle(.plain)
                .foregroundStyle(Theme.ink)
                .tint(Theme.brandGreen)
                .lineLimit(1...5)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Theme.cream)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Theme.creamBorder, lineWidth: 1))
                .overlay(alignment: .leading) {
                    if draft.isEmpty {
                        Text("发消息…").foregroundStyle(Theme.textTertiary).padding(.leading, 14).allowsHitTesting(false)
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

    private var trimmedDraft: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func send() {
        let text = trimmedDraft
        guard !text.isEmpty else { return }
        model.sendText(conv: conv, markdown: text)
        // iOS 听写(dictation)会在发送后把识别文本异步回写到输入框，导致普通 draft="" 清不掉
        // （键盘打字无此回写，所以能清）。先结束编辑逼听写落定+结束会话，清空，下一拍恢复聚焦保持键盘。
        composerFocused = false
        draft = ""
        DispatchQueue.main.async {
            draft = ""
            composerFocused = true
        }
    }

    private func leave() {
        Task {
            await model.leave(conv: conv)
            dismiss()
        }
    }
}

/// Friend picker for adding a member to a group.
private struct AddMemberSheet: View {
    let conv: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if model.friends.isEmpty {
                    Text("你还没有好友。").foregroundStyle(Theme.textSecondary)
                }
                ForEach(model.friends) { friend in
                    Button {
                        Task {
                            await model.addMember(conv: conv, userId: friend.userId)
                            dismiss()
                        }
                    } label: {
                        HStack(spacing: 11) {
                            HumanAvatar(name: friend.username, size: 32)
                            Text(friend.username).foregroundStyle(Theme.ink)
                            Spacer()
                            Image(systemName: "plus.circle").foregroundStyle(Theme.iconGreen)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.chatBG.ignoresSafeArea())
            .navigationTitle("拉人进群")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
            .task { await model.refreshFriends() }
        }
    }
}
