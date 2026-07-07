import Foundation
import Security

/// Stores the Pager client token in the iOS Keychain (service "dev.pager", account "clientToken"),
/// and the hub base URL in UserDefaults (not secret, just a config value).
enum Keychain {
    static let defaultHubURL = "https://pager-hub.jianshuo.workers.dev"

    private static let service = "dev.pager"
    private static let tokenAccount = "clientToken"
    private static let hubURLDefaultsKey = "dev.pager.hubURL"

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

    static var hubURL: String {
        get { UserDefaults.standard.string(forKey: hubURLDefaultsKey) ?? defaultHubURL }
        set { UserDefaults.standard.set(newValue, forKey: hubURLDefaultsKey) }
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
