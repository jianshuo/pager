import Foundation
import Security

/// Stores the Pager client token in the iOS Keychain (service "dev.pager", account "clientToken"),
/// and the hub base URL in UserDefaults (not secret, just a config value).
enum Keychain {
    static let defaultHubURL = "https://pager-hub.jianshuo.workers.dev"

    private static let service = "dev.pager"
    private static let tokenAccount = "clientToken"
    private static let userTokenAccount = "userToken"
    private static let hubURLDefaultsKey = "dev.pager.hubURL"
    private static let displayNameDefaultsKey = "dev.pager.displayName"

    /// The workspace-level token (legacy identity, author self-declared). Used only for
    /// `HubAPI.registerUser` and as a fallback when no personal token has been registered yet.
    static var token: String? {
        get { readString(account: tokenAccount) }
        set {
            if let newValue, !newValue.isEmpty {
                writeString(newValue, account: tokenAccount)
            } else {
                delete(account: tokenAccount)
            }
        }
    }

    /// The person's personal token (starts "utk_"), returned by `POST /api/users` and stored
    /// after `AppModel.ensureRegistered()` runs. Nil until registered. The hub stamps every
    /// message's `author` with the authenticated name for this token (ignoring any
    /// self-declared author in the request body).
    static var userToken: String? {
        get { readString(account: userTokenAccount) }
        set {
            if let newValue, !newValue.isEmpty {
                writeString(newValue, account: userTokenAccount)
            } else {
                delete(account: userTokenAccount)
            }
        }
    }

    /// Single source of truth for the Bearer token used on every REST/WS call except
    /// registration itself: the personal token once registered, else the workspace token.
    static var authToken: String? {
        userToken ?? token
    }

    static var hubURL: String {
        get { UserDefaults.standard.string(forKey: hubURLDefaultsKey) ?? defaultHubURL }
        set { UserDefaults.standard.set(newValue, forKey: hubURLDefaultsKey) }
    }

    /// The user's display name, attached to every human message they send (`body.author`) so
    /// peers in a room can tell who's talking. Not secret — stored in UserDefaults. Defaults to "我".
    static var displayName: String {
        get {
            let stored = UserDefaults.standard.string(forKey: displayNameDefaultsKey) ?? ""
            return stored.isEmpty ? "我" : stored
        }
        set {
            let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            UserDefaults.standard.set(trimmed, forKey: displayNameDefaultsKey)
        }
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
