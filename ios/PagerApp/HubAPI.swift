import Foundation

/// Result of POST /api/conversations.
enum NewConvResult: Equatable, Sendable {
    /// 201 — conversation created and delivered to the daemon: `id`.
    case created(String)
    /// 502 — conversation was created but the daemon went offline before delivery.
    /// The hub doesn't return the conv id in this case; it will show up in the
    /// conversations list (marked failed) on next refresh.
    case createdButFailed
}

enum HubError: Error, Equatable {
    /// No client token configured yet (Keychain.token == nil).
    case notConfigured
    /// 409 — target machine is offline.
    case machineOffline
    /// 400 — bad request (e.g. "dir not allowed", or a zod validation error).
    case badRequest(String)
    /// 404 — unknown conversation (permission-response).
    case notFound
    /// Any other non-2xx status.
    case http(Int, String)
}

/// Thin REST client for the Pager hub (hub/src/index.ts).
///
/// Every request needs `Authorization: Bearer <clientToken>`. Base URL and token are read from
/// `Keychain` by default, but can be injected (for tests, or previews).
struct HubAPI: Sendable {
    var session: URLSession
    var baseURLProvider: @Sendable () -> String
    var tokenProvider: @Sendable () -> String?

    init(
        session: URLSession = .shared,
        baseURLProvider: @escaping @Sendable () -> String = { Keychain.hubURL },
        tokenProvider: @escaping @Sendable () -> String? = { Keychain.authToken }
    ) {
        self.session = session
        self.baseURLProvider = baseURLProvider
        self.tokenProvider = tokenProvider
    }

    func machines() async throws -> [MachineSummary] {
        let request = try makeRequest(path: "/api/machines")
        let (data, response) = try await session.data(for: request)
        try Self.checkOK(response, data: data)
        return try JSONDecoder().decode([MachineSummary].self, from: data)
    }

    func conversations() async throws -> [ConversationSummary] {
        let request = try makeRequest(path: "/api/conversations")
        let (data, response) = try await session.data(for: request)
        try Self.checkOK(response, data: data)
        return try JSONDecoder().decode([ConversationSummary].self, from: data)
    }

    func newConversation(machineId: String, dir: String, message: String) async throws -> NewConvResult {
        let body = try JSONEncoder().encode(
            NewConversationRequestBody(machineId: machineId, dir: dir, message: message)
        )
        let request = try makeRequest(path: "/api/conversations", method: "POST", body: body)
        let (data, response) = try await session.data(for: request)
        let http = try Self.httpResponse(response)
        switch http.statusCode {
        case 201:
            let decoded = try JSONDecoder().decode(NewConversationResponseBody.self, from: data)
            return .created(decoded.id)
        case 502:
            return .createdButFailed
        case 409:
            throw HubError.machineOffline
        case 400:
            throw HubError.badRequest(Self.errorMessage(from: data) ?? "bad request")
        default:
            throw HubError.http(http.statusCode, Self.errorMessage(from: data) ?? "")
        }
    }

    /// Creates a "room" conversation via POST /api/rooms. With no binding it's a human-to-human
    /// room; pass `machineId`+`dir` to make it an AI-enabled room where "@百姓AI" dispatches a
    /// Claude task to the bound daemon. Returns the new conversation id from the 201 `{id}` body.
    func createRoom(title: String, machineId: String? = nil, dir: String? = nil) async throws -> String {
        let body = try JSONEncoder().encode(CreateRoomRequestBody(title: title, machineId: machineId, dir: dir))
        let request = try makeRequest(path: "/api/rooms", method: "POST", body: body)
        let (data, response) = try await session.data(for: request)
        let http = try Self.httpResponse(response)
        switch http.statusCode {
        case 201:
            return try JSONDecoder().decode(NewConversationResponseBody.self, from: data).id
        case 400:
            throw HubError.badRequest(Self.errorMessage(from: data) ?? "bad request")
        default:
            throw HubError.http(http.statusCode, Self.errorMessage(from: data) ?? "")
        }
    }

    func permissionResponse(conv: String, requestId: String, choice: String) async throws {
        let body = try JSONEncoder().encode(
            PermissionResponseRequestBody(conv: conv, request_id: requestId, choice: choice)
        )
        let request = try makeRequest(path: "/api/permission-response", method: "POST", body: body)
        let (data, response) = try await session.data(for: request)
        let http = try Self.httpResponse(response)
        switch http.statusCode {
        case 200:
            return
        case 404:
            throw HubError.notFound
        default:
            throw HubError.http(http.statusCode, Self.errorMessage(from: data) ?? "")
        }
    }

    func registerDevice(token: String) async throws {
        let body = try JSONEncoder().encode(RegisterDeviceRequestBody(deviceToken: token))
        let request = try makeRequest(path: "/api/register-device", method: "POST", body: body)
        let (data, response) = try await session.data(for: request)
        try Self.checkOK(response, data: data)
    }

    /// Registers a personal identity for `name` with the hub and returns the personal token
    /// (starts "utk_"). Uses the WORKSPACE token (`Keychain.token`), NOT `Keychain.authToken` —
    /// registering a new identity requires the workspace secret, not a previously-issued
    /// personal token. Callers store the result in `Keychain.userToken` and use it thereafter.
    func registerUser(name: String) async throws -> String {
        guard let workspaceToken = Keychain.token, !workspaceToken.isEmpty else {
            throw HubError.notConfigured
        }
        let body = try JSONEncoder().encode(RegisterUserRequestBody(name: name))
        let request = try makeRequest(
            path: "/api/users", method: "POST", body: body, tokenOverride: workspaceToken
        )
        let (data, response) = try await session.data(for: request)
        try Self.checkOK(response, data: data)
        return try JSONDecoder().decode(RegisterUserResponseBody.self, from: data).token
    }

    // MARK: - Request building / response handling

    private func makeRequest(
        path: String, method: String = "GET", body: Data? = nil, tokenOverride: String? = nil
    ) throws -> URLRequest {
        guard let token = tokenOverride ?? tokenProvider(), !token.isEmpty else {
            throw HubError.notConfigured
        }
        guard let url = URL(string: baseURLProvider() + path) else {
            throw HubError.badRequest("invalid hub URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private static func httpResponse(_ response: URLResponse) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else {
            throw HubError.http(-1, "no HTTP response")
        }
        return http
    }

    private static func checkOK(_ response: URLResponse, data: Data) throws {
        let http = try httpResponse(response)
        guard (200..<300).contains(http.statusCode) else {
            throw HubError.http(http.statusCode, errorMessage(from: data) ?? "")
        }
    }

    /// Best-effort extraction of a human-readable message from an error body. The hub returns
    /// `{"error": "some string"}` for most handled errors, but zod-validation failures caught at
    /// the top level return `{"error": <ZodIssue[]>}` — fall back to the raw body in that case.
    private static func errorMessage(from data: Data) -> String? {
        if let decoded = try? JSONDecoder().decode(HubErrorBody.self, from: data) {
            return decoded.error
        }
        return String(data: data, encoding: .utf8)
    }
}

private struct NewConversationRequestBody: Encodable {
    let machineId: String
    let dir: String
    let message: String
}

private struct NewConversationResponseBody: Decodable {
    let id: String
}

private struct CreateRoomRequestBody: Encodable {
    let title: String
    let machineId: String?
    let dir: String?

    // Only emit machineId/dir when bound (AI-enabled room); a plain room sends just {title}.
    enum CodingKeys: String, CodingKey { case title, machineId, dir }
    func encode(to e: Encoder) throws {
        var c = e.container(keyedBy: CodingKeys.self)
        try c.encode(title, forKey: .title)
        try c.encodeIfPresent(machineId, forKey: .machineId)
        try c.encodeIfPresent(dir, forKey: .dir)
    }
}

private struct PermissionResponseRequestBody: Encodable {
    let conv: String
    let request_id: String
    let choice: String
}

private struct RegisterDeviceRequestBody: Encodable {
    let deviceToken: String
}

private struct RegisterUserRequestBody: Encodable {
    let name: String
}

private struct RegisterUserResponseBody: Decodable {
    let userId: String
    let name: String
    let token: String
}

private struct HubErrorBody: Decodable {
    let error: String
}
