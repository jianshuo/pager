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
