import Foundation

/// The result of register/login.
struct AuthResult: Decodable, Sendable {
    let userId: String
    let username: String
    let token: String
}

enum HubError: Error, Equatable {
    /// No session token configured yet (logged out).
    case notConfigured
    /// 401 — bad credentials / invalid session.
    case unauthorized(String)
    /// 409 — conflict (e.g. username taken).
    case conflict(String)
    /// 400 — bad request (validation).
    case badRequest(String)
    /// 404 — not found (unknown user/conversation).
    case notFound(String)
    /// Any other non-2xx status.
    case http(Int, String)
}

/// Thin REST client for the Mesh hub (hub/src/index.ts). Base URL and session token are read
/// from `Keychain` by default; injectable for tests/previews.
struct HubAPI: Sendable {
    var session: URLSession
    var baseURLProvider: @Sendable () -> String
    var tokenProvider: @Sendable () -> String?

    init(
        session: URLSession = .shared,
        baseURLProvider: @escaping @Sendable () -> String = { Keychain.hubURL },
        tokenProvider: @escaping @Sendable () -> String? = { Keychain.sessionToken }
    ) {
        self.session = session
        self.baseURLProvider = baseURLProvider
        self.tokenProvider = tokenProvider
    }

    // MARK: - Account

    func register(username: String, password: String) async throws -> AuthResult {
        try await decode(AuthResult.self, path: "/api/register", method: "POST",
                         body: Credentials(username: username, password: password), authed: false)
    }

    func login(username: String, password: String) async throws -> AuthResult {
        try await decode(AuthResult.self, path: "/api/login", method: "POST",
                         body: Credentials(username: username, password: password), authed: false)
    }

    func me() async throws -> UserSummary {
        try await decode(UserSummary.self, path: "/api/me")
    }

    func logout() async throws {
        _ = try await raw(path: "/api/logout", method: "POST")
    }

    // MARK: - Friends

    func bots() async throws -> [BotSummary] {
        try await decode([BotSummary].self, path: "/api/bots")
    }

    func searchUsers(query: String) async throws -> [UserSummary] {
        let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        return try await decode([UserSummary].self, path: "/api/users?q=\(q)")
    }

    func addFriend(userId: String) async throws {
        _ = try await raw(path: "/api/friends", method: "POST", body: UserIdBody(userId: userId))
    }

    func friends() async throws -> [UserSummary] {
        try await decode([UserSummary].self, path: "/api/friends")
    }

    func deleteFriend(userId: String) async throws {
        _ = try await raw(path: "/api/friends/\(pathSafe(userId))", method: "DELETE")
    }

    // MARK: - Conversations

    func conversations() async throws -> [ConversationSummary] {
        try await decode([ConversationSummary].self, path: "/api/conversations")
    }

    func directConversation(userId: String) async throws -> String {
        try await decode(ConvIdBody.self, path: "/api/conversations/direct", method: "POST",
                         body: UserIdBody(userId: userId)).id
    }

    func newGroup(title: String, members: [String]) async throws -> String {
        try await decode(ConvIdBody.self, path: "/api/groups", method: "POST",
                         body: NewGroupBody(title: title, members: members)).id
    }

    func addMember(conv: String, userId: String) async throws {
        _ = try await raw(path: "/api/conversations/\(pathSafe(conv))/members", method: "POST", body: UserIdBody(userId: userId))
    }

    func leave(conv: String) async throws {
        _ = try await raw(path: "/api/conversations/\(pathSafe(conv))/members/me", method: "DELETE")
    }

    func registerDevice(token: String) async throws {
        _ = try await raw(path: "/api/register-device", method: "POST", body: DeviceBody(deviceToken: token))
    }

    // MARK: - Request plumbing

    private func decode<T: Decodable>(_ type: T.Type, path: String, method: String = "GET",
                                      body: Encodable? = nil, authed: Bool = true) async throws -> T {
        let data = try await raw(path: path, method: method, body: body, authed: authed)
        return try JSONDecoder().decode(T.self, from: data)
    }

    @discardableResult
    private func raw(path: String, method: String = "GET", body: Encodable? = nil, authed: Bool = true) async throws -> Data {
        guard let url = URL(string: baseURLProvider() + path) else { throw HubError.badRequest("invalid hub URL") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if authed {
            guard let token = tokenProvider(), !token.isEmpty else { throw HubError.notConfigured }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw HubError.http(-1, "no HTTP response") }
        switch http.statusCode {
        case 200..<300: return data
        case 400: throw HubError.badRequest(Self.message(data) ?? "参数不对")
        case 401: throw HubError.unauthorized(Self.message(data) ?? "未授权")
        case 404: throw HubError.notFound(Self.message(data) ?? "找不到")
        case 409: throw HubError.conflict(Self.message(data) ?? "冲突")
        default: throw HubError.http(http.statusCode, Self.message(data) ?? "")
        }
    }

    private func pathSafe(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }

    private static func message(_ data: Data) -> String? {
        if let decoded = try? JSONDecoder().decode(HubErrorBody.self, from: data) { return decoded.error }
        return String(data: data, encoding: .utf8)
    }
}

private struct Credentials: Encodable { let username: String; let password: String }
private struct UserIdBody: Encodable { let userId: String }
private struct NewGroupBody: Encodable { let title: String; let members: [String] }
private struct DeviceBody: Encodable { let deviceToken: String }
private struct ConvIdBody: Decodable { let id: String }
private struct HubErrorBody: Decodable { let error: String }

/// Type-erased Encodable so `raw(body:)` can take any Encodable value.
private struct AnyEncodable: Encodable {
    private let encodeFn: (Encoder) throws -> Void
    init(_ wrapped: Encodable) { encodeFn = wrapped.encode }
    func encode(to encoder: Encoder) throws { try encodeFn(encoder) }
}
