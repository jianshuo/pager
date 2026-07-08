import SwiftUI

/// Login / register screen shown when there's no session. Username + password; toggles between
/// "登录" and "注册". On success `AppModel` stores the session and `ContentView` swaps to the list.
struct AuthView: View {
    @Environment(AppModel.self) private var model

    @State private var isRegister = false
    @State private var username = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?

    private enum Field { case username, password }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            header
            Spacer().frame(height: 36)
            form
            Spacer()
            switcher
        }
        .padding(.horizontal, 28)
        .background(Theme.chatBG.ignoresSafeArea())
        .tint(Theme.brandGreen)
    }

    private var header: some View {
        VStack(spacing: 10) {
            AIAvatar(size: 64)
            Text("Mesh")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundStyle(Theme.ink)
            Text(isRegister ? "注册一个新账号" : "登录你的账号")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
        }
    }

    private var form: some View {
        VStack(spacing: 14) {
            field("用户名", text: $username, field: .username, secure: false)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.next)
                .onSubmit { focus = .password }
            field("密码", text: $password, field: .password, secure: true)
                .submitLabel(.go)
                .onSubmit(submit)

            if let error {
                Text(error).font(.footnote).foregroundStyle(Theme.failRed)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Button(action: submit) {
                HStack {
                    if busy { ProgressView().tint(.white) }
                    Text(isRegister ? "注册并进入" : "登录")
                        .font(.system(size: 16, weight: .bold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(canSubmit ? Theme.brandGreen : Theme.brandGreen.opacity(0.4))
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!canSubmit || busy)
        }
    }

    @ViewBuilder
    private func field(_ placeholder: String, text: Binding<String>, field: Field, secure: Bool) -> some View {
        Group {
            if secure {
                SecureField(placeholder, text: text)
            } else {
                TextField(placeholder, text: text)
            }
        }
        .focused($focus, equals: field)
        .foregroundStyle(Theme.ink)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Theme.cream)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.creamBorder, lineWidth: 1))
    }

    private var switcher: some View {
        Button {
            withAnimation { isRegister.toggle(); error = nil }
        } label: {
            Text(isRegister ? "已有账号？去登录" : "还没账号？去注册")
                .font(.footnote)
                .foregroundStyle(Theme.deepGreen)
        }
        .padding(.bottom, 24)
    }

    private var canSubmit: Bool {
        username.trimmingCharacters(in: .whitespaces).count >= 3 && password.count >= 6
    }

    private func submit() {
        guard canSubmit, !busy else { return }
        let u = username.trimmingCharacters(in: .whitespaces)
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                if isRegister {
                    try await model.register(username: u, password: password)
                } else {
                    try await model.login(username: u, password: password)
                }
            } catch let e as HubError {
                error = describe(e)
            } catch {
                self.error = "\(error)"
            }
        }
    }

    private func describe(_ e: HubError) -> String {
        switch e {
        case .conflict: return "用户名已被占用，换一个试试"
        case .unauthorized: return "用户名或密码不对"
        case .badRequest(let m): return m
        case .notFound(let m): return m
        case .notConfigured: return "未配置"
        case .http(let c, let m): return "出错了（\(c)）\(m)"
        }
    }
}

#Preview {
    AuthView().environment(AppModel())
}
