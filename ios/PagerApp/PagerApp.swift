import SwiftUI

@main
struct PagerApp: App {
    /// The single shared event store, injected into the whole view tree via `.environment`.
    /// Child views read it with `@Environment(AppModel.self)`.
    @State private var model = AppModel()

    /// UIKit shim required for APNs device-token callbacks and `UNUserNotificationCenterDelegate`
    /// (SwiftUI's `App` protocol has no hook for either). See PushManager.swift.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    @Environment(\.scenePhase) private var scenePhase

    init() {
        #if DEBUG
        // 开发便利：Keychain 无 token 时，从启动环境变量注入（模拟器活体测试用，
        // simctl launch 时用 SIMCTL_CHILD_PAGER_DEBUG_TOKEN 传入）。生产无此变量即空操作。
        if Keychain.token == nil, let t = ProcessInfo.processInfo.environment["PAGER_DEBUG_TOKEN"], !t.isEmpty {
            Keychain.token = t
        }
        #endif
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(model)
                .task {
                    // Hand the (weak) model reference to the app delegate once it exists, so
                    // notification-tap deep-links (AppDelegate.model.deepLinkConv) can reach it.
                    // ALLOW/DENY don't need this — they call HubAPI directly.
                    appDelegate.model = model
                }
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
