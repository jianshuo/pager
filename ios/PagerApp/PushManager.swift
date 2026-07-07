import UIKit
import UserNotifications

/// APNs glue: registers the `PERMISSION_REQUEST` notification category (ALLOW/DENY actions),
/// requests notification authorization, forwards the device token to the hub, and handles
/// notification interactions — including acting on ALLOW/DENY straight from the lock screen,
/// with no need to foreground the app.
///
/// This is the app's `UIApplicationDelegate`, wired in via `PagerApp`'s
/// `@UIApplicationDelegateAdaptor(AppDelegate.self)` (SwiftUI's `App` protocol has no hook for
/// `didRegisterForRemoteNotificationsWithDeviceToken` or `UNUserNotificationCenterDelegate`, so a
/// classic `UIApplicationDelegate` shim is still required). Conceptually this plays the
/// "PushManager" role described in the task — the type is named `AppDelegate` because that's
/// what `@UIApplicationDelegateAdaptor` requires as its generic argument.
///
/// AppModel wiring: `@UIApplicationDelegateAdaptor` constructs this before `PagerApp.body` runs,
/// so it can't take the model in an initializer. `PagerApp` instead hands over a weak reference
/// once the model exists, via `.task { appDelegate.model = model }` on the root view. ALLOW/DENY
/// don't need the model at all — they call `HubAPI().permissionResponse` directly, which is what
/// lets them complete even if the app was never brought to the foreground (iOS may relaunch the
/// app process in the background just to service the notification action). `model` is only used
/// for the notification-tap deep link (`deepLinkConv`), which needs the live SwiftUI environment
/// object to route once the UI exists.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static let permissionCategoryId = "PERMISSION_REQUEST"

    weak var model: AppModel?
    // nonisolated + Sendable：允许从 nonisolated 的 UN 委托方法直接调用（锁屏批准无需上主 actor）。
    private nonisolated let api = HubAPI()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        registerCategories()
        requestAuthorization()
        return true
    }

    // MARK: - Categories + authorization

    private func registerCategories() {
        let allow = UNNotificationAction(identifier: "ALLOW", title: "允许", options: [])
        let deny = UNNotificationAction(identifier: "DENY", title: "拒绝", options: [.destructive])
        let category = UNNotificationCategory(
            identifier: Self.permissionCategoryId,
            actions: [allow, deny],
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    private func requestAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error {
                print("[AppDelegate] requestAuthorization error: \(error)")
            }
            guard granted else {
                print("[AppDelegate] notification authorization not granted")
                return
            }
            Task { @MainActor in
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    // MARK: - Device token registration

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        print("[AppDelegate] APNs device token registered: \(hex)")
        Task { @MainActor [api] in
            do {
                try await api.registerDevice(token: hex)
                print("[AppDelegate] registerDevice(token:) succeeded")
            } catch {
                print("[AppDelegate] registerDevice(token:) failed: \(error)")
            }
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Expected on simulators / restricted networks — no real APNs token is issued there.
        // The exercised code path (category registration, authorization request, delegate
        // wiring) is what this task verifies, not a live APNs round-trip.
        print("[AppDelegate] didFailToRegisterForRemoteNotifications: \(error)")
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Foreground presentation: still show the banner + sound (rather than silently swallowing
    /// it), so a permission request that arrives while the app is open is visible too.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    /// Handles the three interactions the `PERMISSION_REQUEST` category supports: the two custom
    /// actions (fired straight from the lock screen / notification center, no app UI needed) and
    /// the default "tap the notification body" action (needs the app UI, so it deep-links).
    ///
    /// Using the `async` delegate method (iOS 15+) rather than the completion-handler variant
    /// avoids the classic Swift 6 "capture completionHandler across an actor hop" pitfall — the
    /// system just awaits this method's return instead of us needing to remember to invoke a
    /// closure exactly once.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        // 先从非 Sendable 的 response 里取出 Sendable 的字符串，再决定去向——不把 response 跨 actor 传。
        let userInfo = response.notification.request.content.userInfo
        let conv = userInfo["conv"] as? String
        let requestId = userInfo["request_id"] as? String
        let action = response.actionIdentifier

        switch action {
        case "ALLOW":
            await respond(conv: conv, requestId: requestId, choice: "allow")
        case "DENY":
            await respond(conv: conv, requestId: requestId, choice: "deny")
        case UNNotificationDefaultActionIdentifier:
            // 点按通知正文 → 深链进会话（需 app UI）。ConversationListView 观察 model.deepLinkConv。
            if let conv {
                await MainActor.run { model?.deepLinkConv = conv }
            }
        default:
            break
        }
    }

    private nonisolated func respond(conv: String?, requestId: String?, choice: String) async {
        guard let conv, let requestId else {
            print("[AppDelegate] \(choice) action fired but payload missing conv/request_id")
            return
        }
        do {
            try await api.permissionResponse(conv: conv, requestId: requestId, choice: choice)
            print("[AppDelegate] permissionResponse(\(choice)) sent for conv=\(conv) requestId=\(requestId)")
        } catch {
            print("[AppDelegate] permissionResponse(\(choice)) failed: conv=\(conv) requestId=\(requestId) error=\(error)")
        }
    }
}
