import SwiftUI

/// Sheet for creating a group: a title plus a multi-select of friends to add. On create the hub
/// makes the group, indexes it for every member, and the list navigates into it.
struct NewGroupView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    /// Called after creation: (convId, title).
    var onCreated: (String, String) -> Void

    @State private var title = ""
    @State private var selected: Set<String> = []
    @State private var creating = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("群名称") {
                    TextField("给这个群起个名字", text: $title)
                        .autocorrectionDisabled()
                }
                Section("拉谁进群") {
                    if model.friends.isEmpty {
                        Text("你还没有好友，先去通讯录加人。").foregroundStyle(Theme.textSecondary)
                    }
                    ForEach(model.friends) { friend in
                        Button { toggle(friend.userId) } label: {
                            HStack(spacing: 11) {
                                HumanAvatar(name: friend.username, size: 32)
                                Text(friend.username).foregroundStyle(Theme.ink)
                                Spacer()
                                if selected.contains(friend.userId) {
                                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.brandGreen)
                                } else {
                                    Image(systemName: "circle").foregroundStyle(Theme.textTertiary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                if let error {
                    Section { Text(error).font(.footnote).foregroundStyle(Theme.failRed) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.chatBG.ignoresSafeArea())
            .tint(Theme.brandGreen)
            .toolbarBackground(Theme.barBG, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .navigationTitle("新建群聊")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("创建", action: submit).disabled(!canCreate || creating)
                }
            }
            .task { await model.refreshFriends() }
        }
    }

    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canCreate: Bool { !trimmedTitle.isEmpty && !selected.isEmpty }

    private func toggle(_ id: String) {
        if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
    }

    private func submit() {
        guard canCreate, !creating else { return }
        let name = trimmedTitle
        creating = true
        error = nil
        Task {
            defer { creating = false }
            if let conv = await model.newGroup(title: name, members: Array(selected)) {
                onCreated(conv, name)
                dismiss()
            } else {
                error = "创建失败，稍后再试"
            }
        }
    }
}
