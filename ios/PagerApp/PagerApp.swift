import SwiftUI

@main
struct PagerApp: App {
    /// The single shared event store, injected into the whole view tree via `.environment`.
    /// Child views read it with `@Environment(AppModel.self)`.
    @State private var model = AppModel()

    @Environment(\.scenePhase) private var scenePhase

    init() {
        // 开发便利：Keychain 无 token 时，从启动环境变量注入（模拟器活体测试用，
        // simctl launch 时用 SIMCTL_CHILD_PAGER_DEBUG_TOKEN 传入）。生产无此变量即空操作。
        if Keychain.token == nil, let t = ProcessInfo.processInfo.environment["PAGER_DEBUG_TOKEN"], !t.isEmpty {
            Keychain.token = t
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(model)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: model.connect()
            case .background: model.disconnect()
            default: break
            }
        }
    }
}
