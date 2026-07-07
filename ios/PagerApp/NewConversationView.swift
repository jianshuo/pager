import SwiftUI

/// A navigable route into a conversation. Carries the title bits so `ConversationView` can show a
/// proper title immediately after creation, before the conversations list has refreshed.
struct ConvRoute: Hashable {
    let id: String
    let machineName: String
    let dir: String
}

/// Sheet for starting a new conversation: pick an online machine → pick a dir → type a first
/// message → send. On success it hands a `ConvRoute` back to the list to navigate into.
struct NewConversationView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    /// Called after a 201: the list dismisses the sheet and navigates into the new conversation.
    var onCreated: (ConvRoute) -> Void
    /// Called after a 502 (created but the daemon dropped before delivery): show a toast.
    var onCreatedButFailed: () -> Void

    @State private var selectedMachineId: String?
    @State private var selectedDir: String?
    @State private var message = ""
    @State private var sending = false
    @State private var errorMessage: String?

    private var machines: [MachineSummary] {
        model.machines.values.sorted { ($0.online ? 0 : 1, $0.name) < ($1.online ? 0 : 1, $1.name) }
    }

    private var selectedMachine: MachineSummary? {
        selectedMachineId.flatMap { model.machines[$0] }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("机器") {
                    if machines.isEmpty {
                        Text("暂无机器").foregroundStyle(.secondary)
                    }
                    ForEach(machines) { machine in
                        machineRow(machine)
                    }
                }

                if let machine = selectedMachine, machine.online {
                    Section("目录") {
                        if machine.dirs.isEmpty {
                            Text("该机器没有已授权目录").foregroundStyle(.secondary)
                        }
                        ForEach(machine.dirs, id: \.self) { dir in
                            dirRow(dir)
                        }
                    }

                    Section("消息") {
                        TextField("说点什么…", text: $message, axis: .vertical)
                            .lineLimit(2...6)
                    }
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage).font(.footnote).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("新对话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("发送", action: submit).disabled(!canSend || sending)
                }
            }
            .task {
                await model.refreshMachines()
            }
        }
    }

    private func machineRow(_ machine: MachineSummary) -> some View {
        Button {
            selectedMachineId = machine.id
            selectedDir = nil
        } label: {
            HStack {
                Circle()
                    .fill(machine.online ? Color.green : Color.gray)
                    .frame(width: 8, height: 8)
                Text(machine.name)
                    .foregroundStyle(machine.online ? Color.primary : Color.secondary)
                Spacer()
                if selectedMachineId == machine.id {
                    Image(systemName: "checkmark").foregroundStyle(.tint)
                }
            }
        }
        .disabled(!machine.online)
    }

    private func dirRow(_ dir: String) -> some View {
        Button {
            selectedDir = dir
        } label: {
            HStack {
                Text(dir).font(.system(.subheadline, design: .monospaced)).lineLimit(1)
                Spacer()
                if selectedDir == dir {
                    Image(systemName: "checkmark").foregroundStyle(.tint)
                }
            }
        }
    }

    private var canSend: Bool {
        selectedMachine?.online == true
            && selectedDir != nil
            && !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submit() {
        guard let machine = selectedMachine, let dir = selectedDir else { return }
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        sending = true
        errorMessage = nil
        Task {
            defer { sending = false }
            do {
                let result = try await HubAPI().newConversation(machineId: machine.id, dir: dir, message: text)
                switch result {
                case .created(let id):
                    onCreated(ConvRoute(id: id, machineName: machine.name, dir: dir))
                    dismiss()
                case .createdButFailed:
                    onCreatedButFailed()
                    dismiss()
                }
            } catch let error as HubError {
                errorMessage = describe(error)
            } catch {
                errorMessage = "\(error)"
            }
        }
    }

    private func describe(_ error: HubError) -> String {
        switch error {
        case .notConfigured: return "尚未配置 token"
        case .machineOffline: return "该机器已离线"
        case .badRequest(let m): return m
        case .notFound: return "对话不存在"
        case .http(let code, let m): return "HTTP \(code) \(m)"
        }
    }
}
