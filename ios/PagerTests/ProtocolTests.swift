import XCTest
@testable import Pager

final class ProtocolTests: XCTestCase {

    private func decodeEvent(_ json: String) throws -> Event {
        try JSONDecoder().decode(Event.self, from: Data(json.utf8))
    }

    func testTextEventDecodesMarkdown() throws {
        let json = #"{"id":"evt_1","conv":"cnv_1","seq":1,"ts":1751780000,"role":"agent","agent":"claude-code","type":"text","body":{"markdown":"hello **world**"}}"#
        let e = try decodeEvent(json)
        guard case .text(let markdown, _) = e.body else {
            return XCTFail("expected .text, got \(e.body)")
        }
        XCTAssertEqual(markdown, "hello **world**")
    }

    func testTextEventDecodesAuthorInRoom() throws {
        let json = #"{"id":"evt_r","conv":"cnv_room","seq":1,"ts":1751780000,"role":"user","agent":"claude-code","type":"text","body":{"markdown":"hi","author":"小林"}}"#
        let e = try decodeEvent(json)
        guard case .text(let markdown, let author) = e.body else {
            return XCTFail("expected .text, got \(e.body)")
        }
        XCTAssertEqual(markdown, "hi")
        XCTAssertEqual(author, "小林")
    }

    func testTextEventWithoutAuthorHasNilAuthor() throws {
        let json = #"{"id":"evt_n","conv":"cnv_1","seq":1,"ts":1751780000,"role":"agent","agent":"claude-code","type":"text","body":{"markdown":"hello"}}"#
        let e = try decodeEvent(json)
        guard case .text(_, let author) = e.body else {
            return XCTFail("expected .text, got \(e.body)")
        }
        XCTAssertNil(author)
    }

    func testToolCardEventDecodesFields() throws {
        let json = #"{"id":"evt_2","conv":"cnv_1","seq":2,"ts":1751780001,"role":"agent","agent":"claude-code","type":"tool_card","body":{"tool":"Edit","title":"Edit file","summary":"changed 3 lines","detail":"full diff here","diff":"--- a\n+++ b"}}"#
        let e = try decodeEvent(json)
        guard case .toolCard(let tool, let title, _, let detail, let diff) = e.body else {
            return XCTFail("expected .toolCard, got \(e.body)")
        }
        XCTAssertEqual(tool, "Edit")
        XCTAssertEqual(title, "Edit file")
        XCTAssertEqual(detail, "full diff here")
        XCTAssertEqual(diff, "--- a\n+++ b")
    }

    func testPermissionRequestEventDecodesFields() throws {
        let json = #"{"id":"evt_3","conv":"cnv_1","seq":3,"ts":1751780002,"role":"agent","agent":"claude-code","type":"permission_request","body":{"request_id":"req_1","tool":"Bash","description":"run rm -rf","options":["allow","deny","allow_always"]}}"#
        let e = try decodeEvent(json)
        guard case .permissionRequest(let requestId, let tool, _, let options) = e.body else {
            return XCTFail("expected .permissionRequest, got \(e.body)")
        }
        XCTAssertEqual(requestId, "req_1")
        XCTAssertEqual(tool, "Bash")
        XCTAssertEqual(options, ["allow", "deny", "allow_always"])
    }

    func testStatusEventDecodesStateAndNilNote() throws {
        let json = #"{"id":"evt_4","conv":"cnv_1","seq":4,"ts":1751780003,"role":"agent","agent":"claude-code","type":"status","body":{"state":"running"}}"#
        let e = try decodeEvent(json)
        guard case .status(let state, let note) = e.body else {
            return XCTFail("expected .status, got \(e.body)")
        }
        XCTAssertEqual(state, "running")
        XCTAssertNil(note)
    }

    func testErrorEventDecodesMessageAndRecoverable() throws {
        let json = #"{"id":"evt_5","conv":"cnv_1","seq":5,"ts":1751780004,"role":"agent","agent":"claude-code","type":"error","body":{"message":"boom","recoverable":true}}"#
        let e = try decodeEvent(json)
        guard case .error(let message, let recoverable) = e.body else {
            return XCTFail("expected .error, got \(e.body)")
        }
        XCTAssertEqual(message, "boom")
        XCTAssertTrue(recoverable)
    }

    func testUnknownTypeFallsBackToUnknownForForwardCompat() throws {
        let json = #"{"id":"evt_6","conv":"cnv_1","seq":6,"ts":1751780005,"role":"agent","agent":"claude-code","type":"voice_note","body":{"audioUrl":"https://example.com/a.m4a","durationSec":12}}"#
        let e = try decodeEvent(json)
        guard case .unknown(let type, let raw) = e.body else {
            return XCTFail("expected .unknown, got \(e.body)")
        }
        XCTAssertEqual(type, "voice_note")
        XCTAssertFalse(raw.isEmpty)
    }

    func testAgentDefaultsToClaudeCodeWhenAbsent() throws {
        let json = #"{"id":"evt_7","conv":"cnv_1","seq":7,"ts":1751780006,"role":"agent","type":"text","body":{"markdown":"no agent field"}}"#
        let e = try decodeEvent(json)
        XCTAssertEqual(e.agent, "claude-code")
    }

    func testServerMessageDecodesEventKind() throws {
        let json = #"{"kind":"event","event":{"id":"evt_8","conv":"cnv_1","seq":8,"ts":1751780007,"role":"agent","agent":"claude-code","type":"text","body":{"markdown":"hi"}}}"#
        let msg = try JSONDecoder().decode(ServerMessage.self, from: Data(json.utf8))
        guard case .event(let event) = msg else {
            return XCTFail("expected .event, got \(msg)")
        }
        XCTAssertEqual(event.id, "evt_8")
    }

    func testServerMessageDecodesPatchKind() throws {
        let json = #"{"kind":"patch","conv":"cnv_1","eventId":"evt_1","markdown":"updated text"}"#
        let msg = try JSONDecoder().decode(ServerMessage.self, from: Data(json.utf8))
        guard case .patch(let conv, let eventId, let markdown) = msg else {
            return XCTFail("expected .patch, got \(msg)")
        }
        XCTAssertEqual(conv, "cnv_1")
        XCTAssertEqual(eventId, "evt_1")
        XCTAssertEqual(markdown, "updated text")
    }

    func testServerMessageDecodesMachineStatusKind() throws {
        let json = #"{"kind":"machine_status","machine":{"id":"mch_1","name":"MacBook"},"online":true}"#
        let msg = try JSONDecoder().decode(ServerMessage.self, from: Data(json.utf8))
        guard case .machineStatus(let machine, let online) = msg else {
            return XCTFail("expected .machineStatus, got \(msg)")
        }
        XCTAssertEqual(machine.id, "mch_1")
        XCTAssertEqual(machine.name, "MacBook")
        XCTAssertTrue(online)
    }

    func testClientMessageSubscribeEncodesKindAndAfterSeq() throws {
        let data = try JSONEncoder().encode(ClientMessage.subscribe(conv: "cnv_1", afterSeq: 42))
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["kind"] as? String, "subscribe")
        XCTAssertEqual(obj?["conv"] as? String, "cnv_1")
        XCTAssertEqual(obj?["afterSeq"] as? Int, 42)
    }

    func testClientMessageSendEncodesKindAndNestedEvent() throws {
        let draft = EventDraft(id: "evt_9", conv: "cnv_1", ts: 1751780008, role: "user", agent: "claude-code",
                                type: "text", body: ["markdown": .string("go")])
        let data = try JSONEncoder().encode(ClientMessage.send(conv: "cnv_1", event: draft))
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["kind"] as? String, "send")
        XCTAssertEqual(obj?["conv"] as? String, "cnv_1")
        let event = obj?["event"] as? [String: Any]
        XCTAssertEqual(event?["id"] as? String, "evt_9")
        XCTAssertEqual(event?["type"] as? String, "text")
        let body = event?["body"] as? [String: Any]
        XCTAssertEqual(body?["markdown"] as? String, "go")
    }
}
