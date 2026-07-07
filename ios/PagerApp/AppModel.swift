import Foundation
import Observation

/// The app's single event store: home-list summaries (REST-backed) plus the live,
/// deduped/sorted/patched per-conversation event streams (WS-backed). `@MainActor`-isolated
/// so SwiftUI views can read it directly and `ClientWS.onMessage` can call `ingest` without
/// crossing actors.
@MainActor
@Observable
final class AppModel {
    /// Machines by id, primarily refreshed via REST; `online` is also updated incrementally
    /// by `machine_status` WS frames.
    private(set) var machines: [String: MachineSummary] = [:]

    /// Home list, REST-refreshed.
    private(set) var conversations: [ConversationSummary] = []

    /// Per-conversation event lists — deduped by seq, kept sorted ascending, with `patch`
    /// frames applied in place. Not exposed directly; read via `events(for:)`.
    private var eventsByConv: [String: [Event]] = [:]

    /// Conversation ids currently open in the UI. Populated by `openConversation`, drained by
    /// `closeConversation`. Drives `resubscribeAll()` so a WS reconnect re-issues `subscribe`
    /// for everything still on screen.
    private var openConvs: Set<String> = []

    /// Patches that arrived before their target text event existed locally (out-of-order WS
    /// delivery, or a gap during a reconnect backlog pull). Keyed `[conv: [eventId: markdown]]`.
    /// Applied — and cleared — once the matching event is ingested; see `insert(_:)`.
    private var pendingPatches: [String: [String: String]] = [:]

    /// Set by `AppDelegate` (see PushManager.swift) when the user taps a notification body — the
    /// conversation id to deep-link into. `ConversationListView` observes this via `.onChange`,
    /// pushes the route, and resets it to nil.
    var deepLinkConv: String?

    let ws: any WSClient
    private let api: HubAPI

    init(api: HubAPI = HubAPI(), ws: any WSClient = ClientWS()) {
        self.api = api
        self.ws = ws
        self.ws.onMessage = { [weak self] message in
            self?.ingest(message)
        }
        self.ws.onConnected = { [weak self] in
            self?.resubscribeAll()
        }
    }

    // MARK: - Ingest (WS)

    func ingest(_ message: ServerMessage) {
        switch message {
        case .event(let event):
            insert(event)
        case .patch(let conv, let eventId, let markdown):
            applyPatch(conv: conv, eventId: eventId, markdown: markdown)
        case .machineStatus(let machine, let online):
            let dirs = machines[machine.id]?.dirs ?? []
            machines[machine.id] = MachineSummary(id: machine.id, name: machine.name, online: online, dirs: dirs)
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

        // Self-heal a patch that arrived before this event (out-of-order WS delivery).
        if case .text = event.body, let markdown = pendingPatches[event.conv]?[event.id] {
            applyPatch(conv: event.conv, eventId: event.id, markdown: markdown)
            pendingPatches[event.conv]?.removeValue(forKey: event.id)
        }
    }

    private func applyPatch(conv: String, eventId: String, markdown: String) {
        guard var list = eventsByConv[conv], let idx = list.firstIndex(where: { $0.id == eventId }) else {
            print("[AppModel] dropping patch, target event not seen yet — buffering: conv=\(conv) eventId=\(eventId)")
            pendingPatches[conv, default: [:]][eventId] = markdown
            return
        }
        list[idx] = list[idx].withPatchedText(markdown)
        eventsByConv[conv] = list
    }

    /// The sorted, deduped, patched event list for `conv` (empty if none seen yet).
    func events(for conv: String) -> [Event] {
        eventsByConv[conv] ?? []
    }

    // MARK: - Send (WS upstream)

    /// Sends a user text message over the WS. We build an unsealed `EventDraft` (no seq); the hub
    /// stamps the authoritative seq, ingests it, and broadcasts the sealed `Event` back to us —
    /// that echo is what actually appears in the list (via `ingest`). We deliberately do NOT
    /// optimistically insert a placeholder, so seq stays authoritative and there's no dedupe race.
    func sendText(conv: String, markdown: String) {
        let draft = EventDraft(
            id: "evt_\(UUID().uuidString)",
            conv: conv,
            ts: Int(Date().timeIntervalSince1970),
            role: "user",
            agent: "claude-code",
            type: "text",
            body: ["markdown": .string(markdown), "author": .string(Keychain.displayName)]
        )
        ws.send(.send(conv: conv, event: draft))
    }

    // MARK: - Identity registration (REST)

    /// Registers a personal identity with the hub if we haven't already, so subsequent
    /// REST/WS traffic authenticates as this person (see `Keychain.authToken`) instead of the
    /// shared workspace token. Idempotent — a no-op once `Keychain.userToken` is set. Call
    /// before `connect()` so the WS opens with the personal token from the very first frame.
    /// Best-effort: on failure we log and fall back to the workspace token (legacy identity,
    /// author self-declared) rather than blocking app usage.
    func ensureRegistered() async {
        guard Keychain.userToken == nil else { return }
        guard let workspaceToken = Keychain.token, !workspaceToken.isEmpty else { return }
        let name = Keychain.displayName
        guard !name.isEmpty else { return }
        do {
            let personalToken = try await api.registerUser(name: name)
            Keychain.userToken = personalToken
        } catch {
            print("[AppModel] ensureRegistered failed, falling back to workspace token: error=\(error)")
        }
    }

    // MARK: - Pairing (QR / deep link)

    /// Applies a `pager://pair?token=…&hub=…&name=…` deep link — the payload of the QR code the
    /// Mac-side `pair-qr` script prints. Stores the workspace token (plus optional hub URL and
    /// display name) into the Keychain, drops any stale personal token so `ensureRegistered`
    /// mints a fresh one under the (possibly new) name, then reconnects the WS and refreshes the
    /// lists. Returns false without changing anything if the URL carries no usable token.
    func pair(from url: URL) async -> Bool {
        guard url.scheme == "pager", url.host == "pair",
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        let items = comps.queryItems ?? []
        func value(_ name: String) -> String? {
            items.first { $0.name == name }?.value?.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard let token = value("token"), !token.isEmpty else { return false }

        Keychain.token = token
        if let hub = value("hub"), !hub.isEmpty { Keychain.hubURL = hub }
        if let name = value("name"), !name.isEmpty { Keychain.displayName = name }
        Keychain.userToken = nil   // new workspace token invalidates the old personal identity

        disconnect()
        await ensureRegistered()   // personal token under the paired name, before the WS opens
        connect()
        await refreshMachines()
        await refreshConversations()
        return true
    }

    // MARK: - Permission response (REST)

    /// Answers a pending permission request via REST (the hub relays it to the daemon and
    /// broadcasts a `permission_response` event back). Errors are swallowed/logged — the UI
    /// updates its local answered-set optimistically, and the broadcast echo confirms it.
    func permissionRespond(conv: String, requestId: String, choice: String) async {
        do {
            try await api.permissionResponse(conv: conv, requestId: requestId, choice: choice)
        } catch {
            print("[AppModel] permissionRespond failed: conv=\(conv) requestId=\(requestId) error=\(error)")
        }
    }

    // MARK: - Derived list status

    /// The most recent `status` event's state for `conv` (nil if none seen). Used for the list
    /// status dot (running / done / failed / thinking).
    func latestStatus(for conv: String) -> String? {
        for event in events(for: conv).reversed() {
            if case .status(let state, _) = event.body { return state }
        }
        return nil
    }

    /// The latest permission request in `conv` that has not yet been answered by a
    /// `permission_response` with the same `request_id`. Drives the 🟠 list dot and the
    /// conversation view's action buttons. Returns nil if nothing is waiting.
    func pendingPermission(for conv: String) -> (requestId: String, description: String)? {
        let list = events(for: conv)
        var answered: Set<String> = []
        for event in list {
            if case .permissionResponse(let rid, _) = event.body { answered.insert(rid) }
        }
        for event in list.reversed() {
            if case .permissionRequest(let rid, _, let desc, _) = event.body, !answered.contains(rid) {
                return (rid, desc)
            }
        }
        return nil
    }

    // MARK: - WS lifecycle

    /// Opens the shared WS (no-op if already connected or if no token is configured). Call when
    /// the app becomes active.
    func connect() { ws.connect() }

    /// Closes the shared WS. Call when the app backgrounds.
    func disconnect() { ws.disconnect() }

    // MARK: - REST refresh

    func refreshMachines() async {
        guard let result = try? await api.machines() else { return }
        machines = Dictionary(uniqueKeysWithValues: result.map { ($0.id, $0) })
    }

    func refreshConversations() async {
        guard let result = try? await api.conversations() else { return }
        conversations = result
    }

    // MARK: - Conversation open

    /// Subscribes over WS for `conv`, resuming after the highest seq already held locally
    /// (0 pulls the full backlog). Tracks `conv` as open so a later WS reconnect
    /// (`resubscribeAll`) re-issues this subscribe automatically.
    func openConversation(_ conv: String) {
        openConvs.insert(conv)
        ws.subscribe(conv: conv, afterSeq: lastSeq(for: conv))
    }

    /// Marks `conv` as no longer open, so a future reconnect won't re-subscribe it. Call from
    /// the conversation view's `.onDisappear` (wiring is a separate task).
    func closeConversation(_ conv: String) {
        openConvs.remove(conv)
    }

    /// Re-issues `subscribe` for every currently open conversation, each with `afterSeq` set to
    /// the highest seq already held locally (0 if none). Wired to `ClientWS.onConnected` so a
    /// dropped connection (background/foreground, cell↔wifi, hub DO cold start) never leaves an
    /// open conversation silently stale — the backlog pull on resubscribe covers exactly what
    /// was missed during the outage. Dedupe in `insert(_:)` handles any overlap with events
    /// already held locally.
    private func resubscribeAll() {
        for conv in openConvs {
            ws.subscribe(conv: conv, afterSeq: lastSeq(for: conv))
        }
    }

    private func lastSeq(for conv: String) -> Int {
        eventsByConv[conv]?.last?.seq ?? 0
    }
}
