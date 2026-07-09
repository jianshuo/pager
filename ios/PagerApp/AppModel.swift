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

    /// Built-in AI bots (Claude / ChatGPT), REST-refreshed. Shown in Contacts + group add-member.
    private(set) var bots: [BotSummary] = []

    /// Online machines a daemon runs on — bind an agent bot to one. REST-refreshed.
    private(set) var machines: [MachineSummary] = []

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

    #if DEBUG
    /// Adopts a session already written into the Keychain (simulator demo auto-login): flips the
    /// gate, opens the socket, and pulls the lists.
    func adoptDebugSession() async {
        isLoggedIn = true
        connect()
        await refreshFriends()
        await refreshConversations()
    }
    #endif

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

        reflectInList(event)
    }

    /// Keeps the home conversation list live as events stream in: a brand-new conversation (a group
    /// you were just pulled into, a first DM) triggers a list pull; an existing one updates its
    /// last-message preview + timestamp in place and re-sorts. Without this the list only refreshed
    /// on launch / pull-to-refresh, so a new group looked like "nothing showed up" to the invitee.
    private func reflectInList(_ event: Event) {
        let preview: String?
        switch event.body {
        case .text(let markdown, _): preview = markdown
        case .system(let text): preview = text
        default: preview = nil
        }
        if let idx = conversations.firstIndex(where: { $0.id == event.conv }) {
            let c = conversations[idx]
            conversations[idx] = ConversationSummary(
                id: c.id, kind: c.kind, title: c.title, peerUserId: c.peerUserId,
                peerUsername: c.peerUsername, lastMessage: preview ?? c.lastMessage,
                lastSeq: max(c.lastSeq, event.seq), updatedAt: max(c.updatedAt, event.ts))
            conversations.sort { $0.updatedAt > $1.updatedAt }
        } else {
            refreshListIfNewConv(event.conv)
        }
    }

    private var refreshingList = false
    private func refreshListIfNewConv(_ conv: String) {
        guard !refreshingList else { return }
        refreshingList = true
        Task {
            await refreshConversations()
            refreshingList = false
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

    func refreshBots() async {
        guard let result = try? await api.bots() else { return }
        bots = result
    }

    func refreshMachines() async {
        guard let result = try? await api.machines() else { return }
        machines = result
    }

    /// Creates an agent bot bound to a machine + dir; refreshes the bot list.
    /// Returns nil on success, or a human-readable error message on failure.
    func createBot(name: String, machineId: String, dir: String) async -> String? {
        do {
            _ = try await api.createBot(name: name, machineId: machineId, dir: dir)
            await refreshBots()
            return nil
        } catch let e as HubError {
            switch e {
            case .conflict: return "用户名已被占用，换一个"
            case .badRequest(let m): return "参数不对：\(m)"
            case .unauthorized: return "登录失效，重新登录试试"
            case .notConfigured: return "还没登录"
            case .notFound(let m): return m
            case .http(let c, let m): return "出错了（\(c)）\(m)"
            }
        } catch {
            return "网络错误：\(error.localizedDescription)"
        }
    }

    /// Answers an agent bot's permission request (owner only, enforced server-side too).
    func permissionRespond(conv: String, requestId: String, choice: String) async {
        try? await api.permissionResponse(conv: conv, requestId: requestId, choice: choice)
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
