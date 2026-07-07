import SwiftUI

/// Sheet for creating a room. A room is a human-to-human conversation by default; flip the
/// "拉 百姓AI 进群" toggle to bind an online machine + dir as the AI's workspace, making it an
/// AI-enabled room where "@百姓AI" dispatches a Claude task to the bound daemon.
struct NewRoomView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    /// Called after a 201: the list dismisses the sheet and navigates into the new room.
    var onCreated: (ConvRoute) -> Void

    @State private var title = ""
    @State private var bindAI = false
    @State private var selectedMachineId: String?
    @State private var selectedDir: String?
    @State private var creating = false
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
                Section("群聊名称") {
                    TextField("给这个群起个名字", text: $title)
                }

                Section {
                    Toggle("拉 百姓AI 进群", isOn: $bindAI.animation())
                        .tint(Theme.brandGreen)
                } footer: {
                    Text("打开后为群绑定一台机器和目录作为 AI 的工作区，在群里 @百姓AI 就能让它干活。")
                }

                if bindAI {
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
                    }
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage).font(.footnote).foregroundStyle(.red)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.chatBG.ignoresSafeArea())
            .tint(Theme.brandGreen)
            .toolbarBackground(Theme.barBG, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .navigationTitle("新建群聊")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("创建", action: submit).disabled(!canCreate || creating)
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
                    .fill(machine.online ? Theme.runningGreen : Theme.textTertiary)
                    .frame(width: 8, height: 8)
                Text(machine.name)
                    .foregroundStyle(machine.online ? Theme.ink : Theme.textSecondary)
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

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canCreate: Bool {
        guard !trimmedTitle.isEmpty else { return false }
        if bindAI {
            return selectedMachine?.online == true && selectedDir != nil
        }
        return true
    }

    private func submit() {
        let name = trimmedTitle
        guard !name.isEmpty else { return }
        let machineId = bindAI ? selectedMachine?.id : nil
        let dir = bindAI ? selectedDir : nil
        creating = true
        errorMessage = nil
        Task {
            defer { creating = false }
            do {
                let id = try await HubAPI().createRoom(title: name, machineId: machineId, dir: dir)
                onCreated(ConvRoute(id: id, machineName: name, dir: ""))
                dismiss()
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
