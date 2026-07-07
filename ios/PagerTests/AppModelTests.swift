import XCTest
@testable import Pager

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
        guard case .text(let markdown) = events[0].body else {
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
