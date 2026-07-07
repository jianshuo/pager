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

    let ws: ClientWS
    private let api: HubAPI

    init(api: HubAPI = HubAPI(), ws: ClientWS = ClientWS()) {
        self.api = api
        self.ws = ws
        self.ws.onMessage = { [weak self] message in
            self?.ingest(message)
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
    }

    private func applyPatch(conv: String, eventId: String, markdown: String) {
        guard var list = eventsByConv[conv] else { return }
        guard let idx = list.firstIndex(where: { $0.id == eventId }) else { return }
        list[idx] = list[idx].withPatchedText(markdown)
        eventsByConv[conv] = list
    }

    /// The sorted, deduped, patched event list for `conv` (empty if none seen yet).
    func events(for conv: String) -> [Event] {
        eventsByConv[conv] ?? []
    }

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
    /// (0 pulls the full backlog).
    func openConversation(_ conv: String) {
        let afterSeq = eventsByConv[conv]?.last?.seq ?? 0
        ws.subscribe(conv: conv, afterSeq: afterSeq)
    }
}
