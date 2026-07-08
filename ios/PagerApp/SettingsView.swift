import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var hubURLString: String = Keychain.hubURL

    var body: some View {
        NavigationStack {
            Form {
                Section("账号") {
                    HStack {
                        HumanAvatar(name: Keychain.username, size: 40)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(Keychain.username).font(.headline).foregroundStyle(Theme.ink)
                            Text(Keychain.userId).font(.caption2).foregroundStyle(Theme.textTertiary).lineLimit(1)
                        }
                    }
                }
                Section {
                    TextField("Hub URL", text: $hubURLString)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                } header: {
                    Text("Hub 地址")
                } footer: {
                    Text("连接的中心服务器地址。改完保存后重新登录生效。")
                }
                Section {
                    Button("退出登录", role: .destructive) {
                        Task { await model.logout(); dismiss() }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.chatBG.ignoresSafeArea())
            .tint(Theme.brandGreen)
            .toolbarBackground(Theme.barBG, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("保存") { save() } }
                ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
            }
        }
    }

    private func save() {
        let trimmed = hubURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        Keychain.hubURL = trimmed.isEmpty ? Keychain.defaultHubURL : trimmed
        dismiss()
    }
}

#Preview {
    SettingsView().environment(AppModel())
}
