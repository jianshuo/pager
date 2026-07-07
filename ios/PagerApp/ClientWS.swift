import Foundation

/// WebSocket client for the Pager hub's single multiplexed connection (`/ws/client`).
///
/// One socket carries events for *all* conversations; callers filter by `conv` on the
/// receiving end (see `AppModel.ingest`). `@MainActor`-isolated (not an `actor`) so that the
/// `onMessage` handler — and every other call site — runs on the main actor without needing
/// `Event`/`ServerMessage` to cross actor boundaries or conform to `Sendable`. All async work
/// spawned from this class (`Task { ... }` inside its own methods) inherits `@MainActor`
/// isolation because the enclosing function is main-actor-isolated, so capturing `self`/state
/// here is safe under Swift 6 strict concurrency without extra ceremony.
@MainActor
final class ClientWS {
    /// Called on the main actor for every decoded frame from the hub.
    var onMessage: ((ServerMessage) -> Void)?

    private let session: URLSession
    private let baseURLProvider: () -> String
    private let tokenProvider: () -> String?

    private var webSocketTask: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?

    /// Set true by `connect()`, false by `disconnect()`. Gates whether a socket failure
    /// triggers a reconnect attempt (vs. an intentional, user-requested disconnect).
    private var shouldReconnect = false

    private let baseBackoff: Double = 1
    private let maxBackoff: Double = 30
    private var currentBackoff: Double = 1

    init(
        session: URLSession = .shared,
        baseURLProvider: @escaping () -> String = { Keychain.hubURL },
        tokenProvider: @escaping () -> String? = { Keychain.token }
    ) {
        self.session = session
        self.baseURLProvider = baseURLProvider
        self.tokenProvider = tokenProvider
    }

    /// Opens the socket (no-op if already connected/connecting). Call on foreground.
    /// No-ops silently if there's no token configured yet or the hub URL is malformed —
    /// the app is expected to gate this behind `Keychain.token != nil` at the call site.
    func connect() {
        guard webSocketTask == nil else { return }
        guard let token = tokenProvider(), !token.isEmpty else { return }
        guard let url = Self.webSocketURL(from: baseURLProvider()) else { return }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let task = session.webSocketTask(with: request)
        webSocketTask = task
        shouldReconnect = true
        resetBackoff()
        task.resume()
        startReceiving(task)
    }

    /// Closes the socket and stops any pending reconnect. Call on background.
    func disconnect() {
        shouldReconnect = false
        reconnectTask?.cancel()
        reconnectTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
    }

    /// Subscribes to backlog + live events for `conv`, starting after `afterSeq`
    /// (0 to pull the full history).
    func subscribe(conv: String, afterSeq: Int) {
        send(.subscribe(conv: conv, afterSeq: afterSeq))
    }

    /// Encodes and sends a client message. If the socket isn't currently connected, the
    /// message is dropped (best-effort, not queued): the hub is the source of truth via
    /// REST (`HubAPI`) for anything that must survive a dropped connection, and
    /// `AppModel.openConversation` re-subscribes with the correct `afterSeq` once the
    /// socket reconnects, so a dropped `subscribe`/`send` here just means "try again once
    /// connected" rather than silent data loss.
    func send(_ message: ClientMessage) {
        guard let task = webSocketTask else {
            print("ClientWS: dropping send, socket not connected")
            return
        }
        guard let data = try? JSONEncoder().encode(message),
              let text = String(data: data, encoding: .utf8) else {
            return
        }
        Task { [weak self] in
            do {
                try await task.send(.string(text))
            } catch {
                self?.handleDisconnect()
            }
        }
    }

    // MARK: - Receive loop

    private func startReceiving(_ task: URLSessionWebSocketTask) {
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            await self?.receiveLoop(task)
        }
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) async {
        while !Task.isCancelled {
            do {
                let message = try await task.receive()
                resetBackoff()
                handle(message: message)
            } catch {
                if Task.isCancelled { return }
                handleDisconnect()
                return
            }
        }
    }

    private func handle(message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .string(let text):
            data = Data(text.utf8)
        case .data(let raw):
            data = raw
        @unknown default:
            return
        }
        guard let decoded = try? JSONDecoder().decode(ServerMessage.self, from: data) else {
            print("ClientWS: failed to decode server message")
            return
        }
        onMessage?(decoded)
    }

    // MARK: - Reconnect (exponential backoff, base 1s, cap 30s)

    private func handleDisconnect() {
        webSocketTask = nil
        receiveTask = nil
        guard shouldReconnect else { return }
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        reconnectTask?.cancel()
        let delay = currentBackoff
        currentBackoff = min(currentBackoff * 2, maxBackoff)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled else { return }
            self.connect()
        }
    }

    private func resetBackoff() {
        currentBackoff = baseBackoff
    }

    // MARK: - URL

    private static func webSocketURL(from hubURL: String) -> URL? {
        guard var components = URLComponents(string: hubURL) else { return nil }
        switch components.scheme {
        case "https": components.scheme = "wss"
        case "http": components.scheme = "ws"
        default: break
        }
        let base = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = base + "/ws/client"
        return components.url
    }
}
