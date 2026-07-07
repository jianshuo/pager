import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var token: String = Keychain.token ?? ""
    @State private var hubURLString: String = Keychain.hubURL

    var body: some View {
        NavigationStack {
            Form {
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

        dismiss()
    }
}

#Preview {
    SettingsView()
}
