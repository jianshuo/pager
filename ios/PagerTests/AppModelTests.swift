import XCTest
@testable import Pager

/// Test seam for the WS-driven behaviors (resubscribe-on-reconnect) in `AppModel`: `ClientWS`
/// is a concrete class wrapping a real `URLSessionWebSocketTask`, so rather than mock that,
/// `AppModel` depends on the `WSClient` protocol (see `ClientWS.swift`) and this spy records
/// calls without any socket.
@MainActor
private final class SpyWSClient: WSClient {
    var onMessage: ((ServerMessage) -> Void)?
    var onConnected: (@MainActor () -> Void)?

    var connectCallCount = 0
    var disconnectCallCount = 0
    var subscribeCalls: [(conv: String, afterSeq: Int)] = []
    var sentMessages: [ClientMessage] = []

    func connect() { connectCallCount += 1 }
    func disconnect() { disconnectCallCount += 1 }

    func subscribe(conv: String, afterSeq: Int) {
        subscribeCalls.append((conv: conv, afterSeq: afterSeq))
    }

    func send(_ message: ClientMessage) {
        sentMessages.append(message)
    }
}

@MainActor
final class AppModelTests: XCTestCase {

    private func decodeServerMessage(_ json: String) throws -> ServerMessage {
        try JSONDecoder().decode(ServerMessage.self, from: Data(json.utf8))
    }

    private func textEventJSON(id: String, conv: String, seq: Int, markdown: String) -> String {
        #"{"kind":"event","event":{"id":"\#(id)","conv":"\#(conv)","seq":\#(seq),"ts":1751780000,"role":"agent","agent":"claude-code","type":"text","body":{"markdown":"\#(markdown)"}}}"#
    }

    func testIngestDedupesSameSeq() throws {
        let model = AppModel(api: HubAPI(), ws: ClientWS())
        let msg = try decodeServerMessage(textEventJSON(id: "evt_1", conv: "cnv_1", seq: 1, markdown: "hello"))
        model.ingest(msg)
        model.ingest(msg)
        XCTAssertEqual(model.events(for: "cnv_1").count, 1)
    }

    func testIngestSortsOutOfOrderEventsBySeq() throws {
        let model = AppModel(api: HubAPI(), ws: ClientWS())
        let seq3 = try decodeServerMessage(textEventJSON(id: "evt_3", conv: "cnv_1", seq: 3, markdown: "third"))
        let seq2 = try decodeServerMessage(textEventJSON(id: "evt_2", conv: "cnv_1", seq: 2, markdown: "second"))
        model.ingest(seq3)
        model.ingest(seq2)
        let events = model.events(for: "cnv_1")
        XCTAssertEqual(events.map { $0.seq }, [2, 3])
    }

    func testPatchReplacesTextMarkdown() throws {
        let model = AppModel(api: HubAPI(), ws: ClientWS())
        let original = try decodeServerMessage(textEventJSON(id: "evt_x", conv: "cnv_1", seq: 1, markdown: "partial"))
        model.ingest(original)

        let patchJSON = #"{"kind":"patch","conv":"cnv_1","eventId":"evt_x","markdown":"final"}"#
        let patch = try decodeServerMessage(patchJSON)
        model.ingest(patch)

        let events = model.events(for: "cnv_1")
        XCTAssertEqual(events.count, 1)
        guard case .text(let markdown, _) = events[0].body else {
            return XCTFail("expected .text, got \(events[0].body)")
        }
        XCTAssertEqual(markdown, "final")
    }

    func testEventsFilteredByConversation() throws {
        let model = AppModel(api: HubAPI(), ws: ClientWS())
        model.ingest(try decodeServerMessage(textEventJSON(id: "evt_a1", conv: "cnv_a", seq: 1, markdown: "a1")))
        model.ingest(try decodeServerMessage(textEventJSON(id: "evt_b1", conv: "cnv_b", seq: 1, markdown: "b1")))
        model.ingest(try decodeServerMessage(textEventJSON(id: "evt_a2", conv: "cnv_a", seq: 2, markdown: "a2")))

        let aEvents = model.events(for: "cnv_a")
        XCTAssertEqual(aEvents.map { $0.id }, ["evt_a1", "evt_a2"])
        XCTAssertEqual(model.events(for: "cnv_b").map { $0.id }, ["evt_b1"])
    }

    func testMachineStatusUpdatesOnlineFlag() throws {
        let model = AppModel(api: HubAPI(), ws: ClientWS())
        let json = #"{"kind":"machine_status","machine":{"id":"mch_1","name":"MacBook"},"online":true}"#
        model.ingest(try decodeServerMessage(json))

        XCTAssertEqual(model.machines["mch_1"]?.name, "MacBook")
        XCTAssertEqual(model.machines["mch_1"]?.online, true)

        let offlineJSON = #"{"kind":"machine_status","machine":{"id":"mch_1","name":"MacBook"},"online":false}"#
        model.ingest(try decodeServerMessage(offlineJSON))
        XCTAssertEqual(model.machines["mch_1"]?.online, false)
    }

    func testPatchBeforeEventIsBufferedThenSelfHealsOnArrival() throws {
        let model = AppModel(api: HubAPI(), ws: ClientWS())

        // Patch arrives first (out-of-order WS delivery) for an event we haven't seen yet.
        let patchJSON = #"{"kind":"patch","conv":"cnv_1","eventId":"evt_x","markdown":"final"}"#
        model.ingest(try decodeServerMessage(patchJSON))
        XCTAssertTrue(model.events(for: "cnv_1").isEmpty, "nothing should be stuck/created from an orphan patch")

        // The target text event now arrives with stale markdown; the buffered patch should
        // apply on top of it immediately.
        let original = try decodeServerMessage(textEventJSON(id: "evt_x", conv: "cnv_1", seq: 1, markdown: "partial"))
        model.ingest(original)

        let events = model.events(for: "cnv_1")
        XCTAssertEqual(events.count, 1)
        guard case .text(let markdown, _) = events[0].body else {
            return XCTFail("expected .text, got \(events[0].body)")
        }
        XCTAssertEqual(markdown, "final")
    }

    func testResubscribeOnReconnectUsesLastSeqPerOpenConversation() throws {
        let spy = SpyWSClient()
        let model = AppModel(api: HubAPI(), ws: spy)

        model.ingest(try decodeServerMessage(textEventJSON(id: "evt_1", conv: "cnv_a", seq: 5, markdown: "hi")))
        model.openConversation("cnv_a")
        spy.subscribeCalls.removeAll() // clear the subscribe issued by openConversation itself

        spy.onConnected?() // simulate ClientWS firing onConnected after a reconnect

        XCTAssertEqual(spy.subscribeCalls.count, 1)
        XCTAssertEqual(spy.subscribeCalls.first?.conv, "cnv_a")
        XCTAssertEqual(spy.subscribeCalls.first?.afterSeq, 5, "afterSeq must resume from the highest seq already held, not 0")
    }

    func testClosedConversationIsNotResubscribed() throws {
        let spy = SpyWSClient()
        let model = AppModel(api: HubAPI(), ws: spy)

        model.openConversation("cnv_a")
        model.closeConversation("cnv_a")
        spy.subscribeCalls.removeAll()

        spy.onConnected?()

        XCTAssertTrue(spy.subscribeCalls.isEmpty)
    }

    func testUnknownTypeEventIsStillIngested() throws {
        let model = AppModel(api: HubAPI(), ws: ClientWS())
        let json = #"{"kind":"event","event":{"id":"evt_u","conv":"cnv_1","seq":1,"ts":1751780000,"role":"agent","agent":"claude-code","type":"voice_note","body":{"audioUrl":"https://example.com/a.m4a"}}}"#
        model.ingest(try decodeServerMessage(json))

        let events = model.events(for: "cnv_1")
        XCTAssertEqual(events.count, 1)
        guard case .unknown(let type, _) = events[0].body else {
            return XCTFail("expected .unknown, got \(events[0].body)")
        }
        XCTAssertEqual(type, "voice_note")
    }
}
