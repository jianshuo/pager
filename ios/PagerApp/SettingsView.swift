import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var token: String = Keychain.token ?? ""
    @State private var hubURLString: String = Keychain.hubURL
    @State private var displayName: String = Keychain.displayName
    @State private var isRegistered: Bool = Keychain.userToken != nil

    var body: some View {
        NavigationStack {
            Form {
                Section("我的昵称") {
                    TextField("我的昵称", text: $displayName)
                        .autocorrectionDisabled()
                    if isRegistered {
                        Text("已登记身份：\(Keychain.displayName)")
                            .font(.footnote)
                            .foregroundStyle(Theme.brandGreen)
                    } else {
                        Text("未登记（保存昵称后自动登记）")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Button("重新登记身份", role: .destructive) {
                        Keychain.userToken = nil
                        isRegistered = false
                    }
                    .disabled(!isRegistered)
                }
                Section("Hub 地址") {
                    TextField("Hub URL", text: $hubURLString)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }
                Section("Client Token") {
                    SecureField("粘贴 client token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section {
                    Text("Token 保存在系统 Keychain 里，仅用于访问你自己的 hub。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
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
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
        }
    }

    private func save() {
        let trimmedURL = hubURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        Keychain.hubURL = trimmedURL.isEmpty ? Keychain.defaultHubURL : trimmedURL

        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        Keychain.token = trimmedToken.isEmpty ? nil : trimmedToken

        // 空昵称 → getter 回落到默认「我」。
        Keychain.displayName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)

        dismiss()
    }
}

#Preview {
    SettingsView()
}
