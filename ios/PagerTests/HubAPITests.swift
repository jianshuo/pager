import XCTest
@testable import Pager

/// Canned-response URLProtocol mock. Tests set `MockURLProtocol.requestHandler` before firing a
/// request; the handler runs synchronously off the main actor inside URLSession's loading
/// machinery, so the storage is a plain `nonisolated(unsafe) static var` guarded by test ordering
/// (each test overwrites it before use; XCTest runs test methods serially within a class).
final class MockURLProtocol: URLProtocol {
    nonisolated(unsafe) static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = MockURLProtocol.requestHandler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

final class HubAPITests: XCTestCase {
    private static let baseURL = "https://hub.test"

    private func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: config)
    }

    private func makeAPI(session: URLSession, token: String? = "test-token") -> HubAPI {
        HubAPI(
            session: session,
            baseURLProvider: { Self.baseURL },
            tokenProvider: { token }
        )
    }

    private func stub(status: Int, json: String) {
        let url = URL(string: Self.baseURL)!
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url ?? url,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, Data(json.utf8))
        }
    }

    // MARK: - register / login

    func testRegisterDecodesAuthResult() async throws {
        let session = makeSession()
        stub(status: 200, json: #"{"userId":"usr_1","username":"jianshuo","token":"stk_abc"}"#)
        let api = makeAPI(session: session, token: nil) // register needs no prior token

        let auth = try await api.register(username: "jianshuo", password: "hunter2")
        XCTAssertEqual(auth.userId, "usr_1")
        XCTAssertEqual(auth.username, "jianshuo")
        XCTAssertEqual(auth.token, "stk_abc")
    }

    func testLoginThrowsUnauthorizedOn401() async throws {
        let session = makeSession()
        stub(status: 401, json: #"{"error":"用户名或密码不对"}"#)
        let api = makeAPI(session: session, token: nil)

        do {
            _ = try await api.login(username: "x", password: "wrongpass")
            XCTFail("expected HubError.unauthorized")
        } catch HubError.unauthorized {
            // expected
        }
    }

    func testRegisterThrowsConflictOn409() async throws {
        let session = makeSession()
        stub(status: 409, json: #"{"error":"用户名已被占用"}"#)
        let api = makeAPI(session: session, token: nil)

        do {
            _ = try await api.register(username: "taken", password: "hunter2")
            XCTFail("expected HubError.conflict")
        } catch HubError.conflict {
            // expected
        }
    }

    // MARK: - authed endpoints

    func testConversationsThrowsNotConfiguredWhenTokenNil() async throws {
        let session = makeSession()
        stub(status: 200, json: "[]")
        let api = makeAPI(session: session, token: nil)

        do {
            _ = try await api.conversations()
            XCTFail("expected HubError.notConfigured")
        } catch HubError.notConfigured {
            // expected
        }
    }

    func testSearchUsersDecodesArray() async throws {
        let session = makeSession()
        stub(status: 200, json: #"[{"userId":"usr_2","username":"xiaolin"}]"#)
        let api = makeAPI(session: session)

        let users = try await api.searchUsers(query: "xiao")
        XCTAssertEqual(users.count, 1)
        XCTAssertEqual(users[0].username, "xiaolin")
    }

    func testDirectConversationReturnsConvId() async throws {
        let session = makeSession()
        stub(status: 201, json: #"{"id":"dm_a_b"}"#)
        let api = makeAPI(session: session)

        let conv = try await api.directConversation(userId: "usr_b")
        XCTAssertEqual(conv, "dm_a_b")
    }

    func testNewGroupReturnsConvId() async throws {
        let session = makeSession()
        stub(status: 201, json: #"{"id":"cnv_g"}"#)
        let api = makeAPI(session: session)

        let conv = try await api.newGroup(title: "家人群", members: ["usr_b"])
        XCTAssertEqual(conv, "cnv_g")
    }
}
