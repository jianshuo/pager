import Foundation

enum EventBody {
    case text(markdown: String)
    case toolCard(tool: String, title: String, summary: String, detail: String, diff: String?)
    case permissionRequest(requestId: String, tool: String, description: String, options: [String])
    case permissionResponse(requestId: String, choice: String)
    case status(state: String, note: String?)
    case error(message: String, recoverable: Bool)
    case unknown(type: String, raw: [String: JSONValue])
}

struct Event: Decodable, Identifiable {
    let id: String
    let conv: String
    let seq: Int
    let ts: Int
    let role: String
    let agent: String
    let type: String
    let body: EventBody

    enum CodingKeys: String, CodingKey { case id, conv, seq, ts, role, agent, type, body }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        conv = try c.decode(String.self, forKey: .conv)
        seq = try c.decode(Int.self, forKey: .seq)
        ts = try c.decode(Int.self, forKey: .ts)
        role = try c.decode(String.self, forKey: .role)
        agent = (try? c.decode(String.self, forKey: .agent)) ?? "claude-code"
        type = try c.decode(String.self, forKey: .type)
        let b = try c.nestedContainer(keyedBy: BodyKeys.self, forKey: .body)
        body = try Event.decodeBody(type: type, b, raw: c, forKey: .body)
    }

    enum BodyKeys: String, CodingKey {
        case markdown, tool, title, summary, detail, diff
        case request_id, description, options, choice, state, note, message, recoverable
    }

    static func decodeBody(type: String, _ b: KeyedDecodingContainer<BodyKeys>,
                           raw: KeyedDecodingContainer<CodingKeys>, forKey: CodingKeys) throws -> EventBody {
        switch type {
        case "text":
            return .text(markdown: (try? b.decode(String.self, forKey: .markdown)) ?? "")
        case "tool_card":
            return .toolCard(
                tool: (try? b.decode(String.self, forKey: .tool)) ?? "",
                title: (try? b.decode(String.self, forKey: .title)) ?? "",
                summary: (try? b.decode(String.self, forKey: .summary)) ?? "",
                detail: (try? b.decode(String.self, forKey: .detail)) ?? "",
                diff: try? b.decode(String.self, forKey: .diff))
        case "permission_request":
            return .permissionRequest(
                requestId: (try? b.decode(String.self, forKey: .request_id)) ?? "",
                tool: (try? b.decode(String.self, forKey: .tool)) ?? "",
                description: (try? b.decode(String.self, forKey: .description)) ?? "",
                options: (try? b.decode([String].self, forKey: .options)) ?? [])
        case "permission_response":
            return .permissionResponse(
                requestId: (try? b.decode(String.self, forKey: .request_id)) ?? "",
                choice: (try? b.decode(String.self, forKey: .choice)) ?? "")
        case "status":
            return .status(state: (try? b.decode(String.self, forKey: .state)) ?? "",
                           note: try? b.decode(String.self, forKey: .note))
        case "error":
            return .error(message: (try? b.decode(String.self, forKey: .message)) ?? "",
                          recoverable: (try? b.decode(Bool.self, forKey: .recoverable)) ?? false)
        default:
            let rawBody = (try? raw.decode([String: JSONValue].self, forKey: forKey)) ?? [:]
            return .unknown(type: type, raw: rawBody)
        }
    }
}

// 最小 JSON 值类型，装未知 body
enum JSONValue: Codable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null
    init(from d: Decoder) throws {
        let c = try d.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { self = .null }
    }
    func encode(to e: Encoder) throws {
        var c = e.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }
}

struct MachineSummary: Decodable, Identifiable {
    let id: String; let name: String; let online: Bool; let dirs: [String]
}
struct ConversationSummary: Decodable, Identifiable {
    let id: String; let machineId: String; let machineName: String; let dir: String
    let state: String; let lastMessage: String; let lastSeq: Int; let updatedAt: Int
}

// 上行草稿（无 seq）
struct EventDraft: Encodable {
    let id: String; let conv: String; let ts: Int; let role: String; let agent: String
    let type: String; let body: [String: JSONValue]
}

// 客户端 → hub
enum ClientMessage: Encodable {
    case subscribe(conv: String, afterSeq: Int)
    case send(conv: String, event: EventDraft)
    func encode(to e: Encoder) throws {
        var c = e.container(keyedBy: K.self)
        switch self {
        case .subscribe(let conv, let after):
            try c.encode("subscribe", forKey: .kind); try c.encode(conv, forKey: .conv); try c.encode(after, forKey: .afterSeq)
        case .send(let conv, let event):
            try c.encode("send", forKey: .kind); try c.encode(conv, forKey: .conv); try c.encode(event, forKey: .event)
        }
    }
    enum K: String, CodingKey { case kind, conv, afterSeq, event }
}

// hub → 客户端
enum ServerMessage: Decodable {
    case event(Event)
    case patch(conv: String, eventId: String, markdown: String)
    case machineStatus(machine: MachineSummaryLite, online: Bool)
    struct MachineSummaryLite: Decodable { let id: String; let name: String }
    enum K: String, CodingKey { case kind, event, conv, eventId, markdown, machine, online }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "event": self = .event(try c.decode(Event.self, forKey: .event))
        case "patch": self = .patch(conv: try c.decode(String.self, forKey: .conv),
                                    eventId: try c.decode(String.self, forKey: .eventId),
                                    markdown: try c.decode(String.self, forKey: .markdown))
        case "machine_status": self = .machineStatus(machine: try c.decode(MachineSummaryLite.self, forKey: .machine),
                                                     online: try c.decode(Bool.self, forKey: .online))
        case let k: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown kind \(k)")
        }
    }
}
