import Foundation
import Observation

/// The app's single store: account/friends/home-list (REST-backed) plus the live, deduped/sorted
/// per-conversation event streams (WS-backed). `@MainActor`-isolated so SwiftUI reads it directly
/// and `ClientWS.onMessage` can call `ingest` without crossing actors.
@MainActor
@Observable
final class AppModel {
    /// True once logged in — drives the auth gate. Mirrors `Keychain.isLoggedIn`, but observable.
    var isLoggedIn: Bool = Keychain.isLoggedIn

    /// My friends (single-direction contacts), REST-refreshed.
    private(set) var friends: [UserSummary] = []

    /// Home list, REST-refreshed.
    private(set) var conversations: [ConversationSummary] = []

    /// Per-conversation event lists — deduped by seq, kept sorted ascending, with `patch`
    /// frames applied in place.
    private var eventsByConv: [String: [Event]] = [:]

    private var openConvs: Set<String> = []
    private var pendingPatches: [String: [String: String]] = [:]

    /// Set by push-tap (see PushManager) to deep-link into a conversation.
    var deepLinkConv: String?

    let ws: any WSClient
    private let api: HubAPI

    init(api: HubAPI = HubAPI(), ws: any WSClient = ClientWS()) {
        self.api = api
        self.ws = ws
        self.ws.onMessage = { [weak self] message in self?.ingest(message) }
        self.ws.onConnected = { [weak self] in self?.resubscribeAll() }
    }

    // MARK: - Auth

    /// Registers a new account, stores the session, connects. Throws on failure (e.g. username taken).
    func register(username: String, password: String) async throws {
        let auth = try await api.register(username: username, password: password)
        applyAuth(auth)
    }

    /// Logs in, stores the session, connects. Throws on bad credentials.
    func login(username: String, password: String) async throws {
        let auth = try await api.login(username: username, password: password)
        applyAuth(auth)
    }

    private func applyAuth(_ auth: AuthResult) {
        Keychain.sessionToken = auth.token
        Keychain.userId = auth.userId
        Keychain.username = auth.username
        isLoggedIn = true
        connect()
    }

    /// Logs out: revokes the session server-side (best effort), clears local state, disconnects.
    func logout() async {
        try? await api.logout()
        disconnect()
        Keychain.clearSession()
        friends = []
        conversations = []
        eventsByConv = [:]
        openConvs = []
        isLoggedIn = false
    }

    // MARK: - Ingest (WS)

    func ingest(_ message: ServerMessage) {
        switch message {
        case .event(let event): insert(event)
        case .patch(let conv, let eventId, let markdown): applyPatch(conv: conv, eventId: eventId, markdown: markdown)
        }
    }

    private func insert(_ event: Event) {
        var list = eventsByConv[event.conv] ?? []
        if let idx = list.firstIndex(where: { $0.seq == event.seq }) {
            list[idx] = event
        } else {
            list.append(event)
        }
        list.sort { $0.seq < $1.seq }
        eventsByConv[event.conv] = list

        if case .text = event.body, let markdown = pendingPatches[event.conv]?[event.id] {
            applyPatch(conv: event.conv, eventId: event.id, markdown: markdown)
            pendingPatches[event.conv]?.removeValue(forKey: event.id)
        }
    }

    private func applyPatch(conv: String, eventId: String, markdown: String) {
        guard var list = eventsByConv[conv], let idx = list.firstIndex(where: { $0.id == eventId }) else {
            pendingPatches[conv, default: [:]][eventId] = markdown
            return
        }
        list[idx] = list[idx].withPatchedText(markdown)
        eventsByConv[conv] = list
    }

    func events(for conv: String) -> [Event] { eventsByConv[conv] ?? [] }

    // MARK: - Send (WS upstream)

    /// Sends a text message. Author is stamped server-side by identity; we include our username
    /// locally too. No optimistic insert — the hub's echo (via fanout) is what appears.
    func sendText(conv: String, markdown: String) {
        let draft = EventDraft(
            id: "evt_\(UUID().uuidString)",
            conv: conv,
            ts: Int(Date().timeIntervalSince1970),
            role: "user",
            agent: "claude-code",
            type: "text",
            body: ["markdown": .string(markdown), "author": .string(Keychain.username)]
        )
        ws.send(.send(conv: conv, event: draft))
    }

    // MARK: - Friends (REST)

    func searchUsers(_ query: String) async -> [UserSummary] {
        (try? await api.searchUsers(query: query)) ?? []
    }

    func addFriend(userId: String) async {
        try? await api.addFriend(userId: userId)
        await refreshFriends()
    }

    func refreshFriends() async {
        guard let result = try? await api.friends() else { return }
        friends = result
    }

    // MARK: - Conversations (REST)

    /// Finds or creates the 1:1 conversation with `userId`, returns its id (nil on failure).
    func openDirect(userId: String) async -> String? {
        let conv = try? await api.directConversation(userId: userId)
        await refreshConversations()
        return conv
    }

    /// Creates a group, returns its id (nil on failure).
    func newGroup(title: String, members: [String]) async -> String? {
        let conv = try? await api.newGroup(title: title, members: members)
        await refreshConversations()
        return conv
    }

    func addMember(conv: String, userId: String) async {
        try? await api.addMember(conv: conv, userId: userId)
    }

    func leave(conv: String) async {
        try? await api.leave(conv: conv)
        await refreshConversations()
    }

    func refreshConversations() async {
        guard let result = try? await api.conversations() else { return }
        conversations = result
    }

    // MARK: - WS lifecycle

    func connect() { ws.connect() }
    func disconnect() { ws.disconnect() }

    // MARK: - Conversation open

    func openConversation(_ conv: String) {
        openConvs.insert(conv)
        ws.subscribe(conv: conv, afterSeq: lastSeq(for: conv))
    }

    func closeConversation(_ conv: String) {
        openConvs.remove(conv)
    }

    private func resubscribeAll() {
        for conv in openConvs {
            ws.subscribe(conv: conv, afterSeq: lastSeq(for: conv))
        }
    }

    private func lastSeq(for conv: String) -> Int {
        eventsByConv[conv]?.last?.seq ?? 0
    }
}
