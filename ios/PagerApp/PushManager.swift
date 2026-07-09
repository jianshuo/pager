import UIKit
import UserNotifications

/// APNs glue: requests notification authorization, forwards the device token to the hub, shows
/// message banners, and deep-links into a conversation when a notification is tapped.
///
/// This is the app's `UIApplicationDelegate`, wired in via `PagerApp`'s
/// `@UIApplicationDelegateAdaptor(AppDelegate.self)` (SwiftUI's `App` protocol has no hook for
/// `didRegisterForRemoteNotificationsWithDeviceToken` or `UNUserNotificationCenterDelegate`).
/// `PagerApp` hands over a weak `AppModel` reference once it exists, used for the tap deep-link.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    weak var model: AppModel?
    private nonisolated let api = HubAPI()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        requestAuthorization()
        return true
    }

    private func requestAuthorization() {
        #if DEBUG
        // 截图/演示时跳过推送授权弹窗（保持画面干净）。生产无此变量即正常请求。
        if ProcessInfo.processInfo.environment["MESH_DEBUG_NO_PUSH"] != nil { return }
        #endif
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error { print("[AppDelegate] requestAuthorization error: \(error)") }
            guard granted else { return }
            Task { @MainActor in UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    // MARK: - Device token registration

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor [api] in
            // Only register the device once logged in — the hub attaches it to the session's user.
            guard Keychain.isLoggedIn else { return }
            try? await api.registerDevice(token: hex)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Expected on simulators / restricted networks — no real APNs token there.
        print("[AppDelegate] didFailToRegisterForRemoteNotifications: \(error)")
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Show the banner + sound even when the app is foregrounded.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    /// Tapping a notification deep-links into its conversation.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let conv = response.notification.request.content.userInfo["conv"] as? String
        if let conv {
            await MainActor.run { model?.deepLinkConv = conv }
        }
    }
}
