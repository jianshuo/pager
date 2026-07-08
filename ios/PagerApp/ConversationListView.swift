import SwiftUI

/// Navigation target: the contacts screen, or a specific conversation.
enum MeshRoute: Hashable {
    case contacts
    case conversation(id: String, title: String)
}

/// Home: the conversations list, with toolbar entries for contacts (start a 1:1), a new group,
/// and settings. Owns the `NavigationStack` and its path.
struct ConversationListView: View {
    @Environment(AppModel.self) private var model

    @State private var path: [MeshRoute] = []
    @State private var showNewGroup = false
    @State private var showSettings = false

    var body: some View {
        NavigationStack(path: $path) {
            conversationList
                .background(Theme.chatBG.ignoresSafeArea())
                .navigationTitle("Mesh")
                .toolbarBackground(Theme.barBG, for: .navigationBar)
                .toolbarBackground(.visible, for: .navigationBar)
                .tint(Theme.brandGreen)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { showSettings = true } label: { Image(systemName: "gearshape") }
                            .tint(Theme.iconGreen)
                            .accessibilityLabel("设置")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { path.append(.contacts) } label: { Image(systemName: "person.2") }
                            .tint(Theme.iconGreen)
                            .accessibilityLabel("通讯录")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showNewGroup = true } label: { Image(systemName: "square.and.pencil") }
                            .tint(Theme.iconGreen)
                            .accessibilityLabel("新建群聊")
                    }
                }
                .navigationDestination(for: MeshRoute.self) { route in
                    switch route {
                    case .contacts:
                        ContactsView(onStartChat: { id, title in path.append(.conversation(id: id, title: title)) })
                    case .conversation(let id, let title):
                        ConversationView(conv: id, title: title)
                    }
                }
                .refreshable { await refresh() }
                .task {
                    model.connect()
                    await refresh()
                    #if DEBUG
                    // 模拟器活体演示：MESH_DEBUG_OPEN_CONV 指定的会话在刷新后自动打开。
                    if let cid = ProcessInfo.processInfo.environment["MESH_DEBUG_OPEN_CONV"],
                       !cid.isEmpty, path.isEmpty {
                        let title = model.conversations.first { $0.id == cid }?.displayName ?? "对话"
                        path.append(.conversation(id: cid, title: title))
                    }
                    #endif
                }
                .onChange(of: model.deepLinkConv) { _, newValue in
                    guard let convId = newValue, !convId.isEmpty else { return }
                    let title = model.conversations.first { $0.id == convId }?.displayName ?? "对话"
                    path.append(.conversation(id: convId, title: title))
                    model.deepLinkConv = nil
                }
                .sheet(isPresented: $showSettings) { SettingsView() }
                .sheet(isPresented: $showNewGroup) {
                    NewGroupView(onCreated: { id, title in
                        path.append(.conversation(id: id, title: title))
                    })
                }
        }
    }

    private var conversationList: some View {
        List {
            if model.conversations.isEmpty {
                Text("还没有会话。点右上角通讯录，找个人聊聊吧。")
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
                    .listRowBackground(Theme.chatBG)
            }
            ForEach(model.conversations) { conv in
                NavigationLink(value: MeshRoute.conversation(id: conv.id, title: conv.displayName)) {
                    ConversationRow(summary: conv)
                }
                .listRowBackground(Theme.chatBG)
                .listRowSeparatorTint(Theme.creamBorder)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.chatBG)
    }

    private func refresh() async {
        await model.refreshConversations()
        await model.refreshFriends()
    }
}

private struct ConversationRow: View {
    let summary: ConversationSummary

    var body: some View {
        HStack(spacing: 11) {
            if summary.isGroup {
                GroupAvatar(size: 40)
            } else {
                HumanAvatar(name: summary.peerUsername, size: 40)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(summary.displayName.isEmpty ? "对话" : summary.displayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                Text(summary.lastMessage.isEmpty ? "（无消息）" : summary.lastMessage)
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 3)
    }
}

/// A round tile for group conversations (people glyph on a soft green fill).
struct GroupAvatar: View {
    var size: CGFloat = 40
    var body: some View {
        Circle()
            .fill(Theme.statusPillBG)
            .frame(width: size, height: size)
            .overlay(
                Image(systemName: "person.3.fill")
                    .font(.system(size: size * 0.42))
                    .foregroundStyle(Theme.deepGreen)
            )
            .overlay(Circle().strokeBorder(Theme.brandGreen.opacity(0.3), lineWidth: 1))
    }
}
