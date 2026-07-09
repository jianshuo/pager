import Foundation
import Security

/// Stores the Mesh session credentials: the session token (Keychain), plus the logged-in
/// userId/username and hub URL (UserDefaults — not secret). Cleared on logout.
enum Keychain {
    // 自定义域（jianshuo.dev），中国大陆可达性远好于被墙的 *.workers.dev。
    static let defaultHubURL = "https://mesh-api.jianshuo.dev"

    private static let service = "dev.mesh"
    private static let sessionAccount = "sessionToken"
    private static let hubURLKey = "dev.mesh.hubURL"
    private static let userIdKey = "dev.mesh.userId"
    private static let usernameKey = "dev.mesh.username"

    /// The session token (starts "stk_"), issued by POST /api/register|login. nil = logged out.
    /// Used as the Bearer on every REST/WS call.
    static var sessionToken: String? {
        get { readString(account: sessionAccount) }
        set {
            if let newValue, !newValue.isEmpty { writeString(newValue, account: sessionAccount) }
            else { delete(account: sessionAccount) }
        }
    }

    static var userId: String {
        get { UserDefaults.standard.string(forKey: userIdKey) ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: userIdKey) }
    }

    static var username: String {
        get { UserDefaults.standard.string(forKey: usernameKey) ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: usernameKey) }
    }

    static var hubURL: String {
        get { UserDefaults.standard.string(forKey: hubURLKey) ?? defaultHubURL }
        set { UserDefaults.standard.set(newValue, forKey: hubURLKey) }
    }

    /// True once logged in. Drives the auth gate in `ContentView`.
    static var isLoggedIn: Bool { !(sessionToken ?? "").isEmpty }

    /// Wipe all session state (logout).
    static func clearSession() {
        sessionToken = nil
        userId = ""
        username = ""
    }

    // MARK: - SecItem plumbing

    private static func readString(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func writeString(_ value: String, account: String) {
        let data = Data(value.utf8)
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var addQuery = baseQuery
            addQuery[kSecValueData as String] = data
            addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(addQuery as CFDictionary, nil)
        }
    }

    private static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
