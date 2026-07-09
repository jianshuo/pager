import SwiftUI

/// The contacts screen: my friends (tap to start a 1:1) plus a search bar to find and add people
/// by username. Single-direction — adding a friend needs no approval.
struct ContactsView: View {
    @Environment(AppModel.self) private var model

    /// Called after a friend tap resolves a 1:1 conversation: (convId, title).
    var onStartChat: (String, String) -> Void

    @State private var query = ""
    @State private var results: [UserSummary] = []
    @State private var searching = false
    @State private var opening = false
    @State private var showNewBot = false

    var body: some View {
        List {
            if !trimmedQuery.isEmpty {
                Section("搜索结果") {
                    if searching { ProgressView() }
                    if !searching && results.isEmpty {
                        Text("没找到「\(trimmedQuery)」").foregroundStyle(Theme.textSecondary)
                    }
                    ForEach(results) { user in
                        searchRow(user)
                    }
                }
            }
            if trimmedQuery.isEmpty && !model.bots.isEmpty {
                Section("助手") {
                    ForEach(model.bots) { bot in
                        Button { start(botUserId: bot.userId, name: bot.displayName) } label: {
                            HStack(spacing: 11) {
                                AIAvatar(size: 36)
                                Text(bot.displayName).foregroundStyle(Theme.ink)
                                Spacer()
                                Image(systemName: "bubble.left").foregroundStyle(Theme.iconGreen)
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(opening)
                    }
                }
            }
            Section("我的好友") {
                if model.friends.isEmpty {
                    Text("还没有好友。上面搜个用户名加一下。").foregroundStyle(Theme.textSecondary)
                }
                ForEach(model.friends) { friend in
                    Button { start(with: friend) } label: { friendRow(friend) }
                        .buttonStyle(.plain)
                        .disabled(opening)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.chatBG.ignoresSafeArea())
        .navigationTitle("通讯录")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.barBG, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .tint(Theme.brandGreen)
        .searchable(text: $query, prompt: "按用户名搜人")
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .onChange(of: query) { _, _ in scheduleSearch() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showNewBot = true } label: { Image(systemName: "cpu") }
                    .tint(Theme.iconGreen)
                    .accessibilityLabel("新建干活 bot")
            }
        }
        .sheet(isPresented: $showNewBot) { NewBotView() }
        .task { await model.refreshBots(); await model.refreshFriends() }
    }

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespaces).lowercased() }

    private func friendRow(_ friend: UserSummary) -> some View {
        HStack(spacing: 11) {
            HumanAvatar(name: friend.username, size: 36)
            Text(friend.username).foregroundStyle(Theme.ink)
            Spacer()
            Image(systemName: "bubble.left").foregroundStyle(Theme.iconGreen)
        }
    }

    private func searchRow(_ user: UserSummary) -> some View {
        let already = model.friends.contains { $0.userId == user.userId } || user.userId == Keychain.userId
        return HStack(spacing: 11) {
            HumanAvatar(name: user.username, size: 36)
            Text(user.username).foregroundStyle(Theme.ink)
            Spacer()
            if user.userId == Keychain.userId {
                Text("这是你").font(.caption).foregroundStyle(Theme.textTertiary)
            } else if already {
                Text("已是好友").font(.caption).foregroundStyle(Theme.textTertiary)
            } else {
                Button("加好友") { Task { await model.addFriend(userId: user.userId) } }
                    .font(.system(size: 13, weight: .semibold))
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.brandGreen)
            }
        }
    }

    private func scheduleSearch() {
        let q = trimmedQuery
        guard !q.isEmpty else { results = []; return }
        searching = true
        Task {
            let found = await model.searchUsers(q)
            // 只在查询没变时应用结果，避免快速输入时旧结果覆盖新结果
            if trimmedQuery == q {
                results = found
                searching = false
            }
        }
    }

    private func start(with friend: UserSummary) {
        start(botUserId: friend.userId, name: friend.username)
    }

    private func start(botUserId: String, name: String) {
        guard !opening else { return }
        opening = true
        Task {
            defer { opening = false }
            if let conv = await model.openDirect(userId: botUserId) {
                onStartChat(conv, name)
            }
        }
    }
}
