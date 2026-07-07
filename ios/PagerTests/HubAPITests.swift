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

    // MARK: - machines()

    func testMachinesDecodesA200Array() async throws {
        let session = makeSession()
        stub(status: 200, json: #"[{"id":"mch_1","name":"建硕的 Mac","online":true,"dirs":["/repo"]}]"#)
        let api = makeAPI(session: session)

        let machines = try await api.machines()

        XCTAssertEqual(machines.count, 1)
        XCTAssertEqual(machines[0].id, "mch_1")
        XCTAssertEqual(machines[0].name, "建硕的 Mac")
        XCTAssertTrue(machines[0].online)
        XCTAssertEqual(machines[0].dirs, ["/repo"])
    }

    func testMachinesThrowsNotConfiguredWhenTokenNil() async throws {
        let session = makeSession()
        stub(status: 200, json: "[]")
        let api = makeAPI(session: session, token: nil)

        do {
            _ = try await api.machines()
            XCTFail("expected HubError.notConfigured")
        } catch HubError.notConfigured {
            // expected
        }
    }

    // MARK: - newConversation()

    func testNewConversationReturnsCreatedOn201() async throws {
        let session = makeSession()
        stub(status: 201, json: #"{"id":"cnv_x"}"#)
        let api = makeAPI(session: session)

        let result = try await api.newConversation(machineId: "mch_1", dir: "/repo", message: "hi")

        XCTAssertEqual(result, .created("cnv_x"))
    }

    func testNewConversationReturnsCreatedButFailedOn502() async throws {
        let session = makeSession()
        stub(status: 502, json: #"{"error":"daemon went offline"}"#)
        let api = makeAPI(session: session)

        let result = try await api.newConversation(machineId: "mch_1", dir: "/repo", message: "hi")

        XCTAssertEqual(result, .createdButFailed)
    }

    func testNewConversationThrowsMachineOfflineOn409() async throws {
        let session = makeSession()
        stub(status: 409, json: #"{"error":"machine offline"}"#)
        let api = makeAPI(session: session)

        do {
            _ = try await api.newConversation(machineId: "mch_1", dir: "/repo", message: "hi")
            XCTFail("expected HubError.machineOffline")
        } catch HubError.machineOffline {
            // expected
        }
    }

    func testNewConversationThrowsBadRequestOn400() async throws {
        let session = makeSession()
        stub(status: 400, json: #"{"error":"dir not allowed"}"#)
        let api = makeAPI(session: session)

        do {
            _ = try await api.newConversation(machineId: "mch_1", dir: "/nope", message: "hi")
            XCTFail("expected HubError.badRequest")
        } catch HubError.badRequest(let message) {
            XCTAssertEqual(message, "dir not allowed")
        }
    }

    // MARK: - permissionResponse()

    func testPermissionResponseSucceedsOn200() async throws {
        let session = makeSession()
        stub(status: 200, json: #"{"ok":true}"#)
        let api = makeAPI(session: session)

        try await api.permissionResponse(conv: "cnv_1", requestId: "req_1", choice: "allow")
        // no throw == success
    }

    func testPermissionResponseThrowsNotFoundOn404() async throws {
        let session = makeSession()
        stub(status: 404, json: #"{"error":"unknown conversation"}"#)
        let api = makeAPI(session: session)

        do {
            try await api.permissionResponse(conv: "cnv_missing", requestId: "req_1", choice: "allow")
            XCTFail("expected HubError.notFound")
        } catch HubError.notFound {
            // expected
        }
    }
}
