import SwiftUI

/// App root. Gates on login: shows the auth screen until a session exists, then the conversations
/// list. All state lives in the shared `AppModel` injected by `PagerApp`.
struct ContentView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if model.isLoggedIn {
                ConversationListView()
            } else {
                AuthView()
            }
        }
        .tint(Theme.brandGreen)
        .task {
            #if DEBUG
            // 模拟器活体演示：simctl launch 时用 SIMCTL_CHILD_MESH_DEBUG_* 注入一个已注册账号的
            // session，直接进主界面（免手打）。生产/无变量即空操作。
            await debugAutoLoginIfRequested()
            #endif
        }
    }

    #if DEBUG
    private func debugAutoLoginIfRequested() async {
        let env = ProcessInfo.processInfo.environment
        guard let token = env["MESH_DEBUG_TOKEN"], !token.isEmpty,
              let userId = env["MESH_DEBUG_USERID"],
              let username = env["MESH_DEBUG_USERNAME"] else { return }
        // 强制覆盖已存的会话（demo 里切换账号用）——不 guard isLoggedIn，否则会沿用旧 token。
        guard token != Keychain.sessionToken || !model.isLoggedIn else { return }
        Keychain.sessionToken = token
        Keychain.userId = userId
        Keychain.username = username
        await model.adoptDebugSession()
    }
    #endif
}

#Preview {
    ContentView()
        .environment(AppModel())
}
