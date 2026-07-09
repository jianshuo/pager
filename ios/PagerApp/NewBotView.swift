import SwiftUI

/// Sheet for creating an agent "work bot": a username + bind an online machine + a dir. The bot
/// is backed by Claude Code on that machine; only you (the creator) can approve its actions.
struct NewBotView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var selectedMachineId: String?
    @State private var selectedDir: String?
    @State private var creating = false
    @State private var error: String?

    private var onlineMachines: [MachineSummary] { model.machines.filter { $0.online } }
    private var selectedMachine: MachineSummary? { selectedMachineId.flatMap { id in model.machines.first { $0.id == id } } }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("给这个 bot 起个用户名", text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("名字")
                } footer: {
                    Text("3–20 位小写字母/数字/下划线。别人可以在群里 @ 这个名字唤起它。")
                }
                Section("机器") {
                    if onlineMachines.isEmpty {
                        Text("没有在线机器。先在你的电脑上跑 Mesh daemon。").foregroundStyle(Theme.textSecondary)
                    }
                    ForEach(onlineMachines) { m in
                        Button { selectedMachineId = m.id; selectedDir = nil } label: {
                            HStack {
                                Circle().fill(Theme.runningGreen).frame(width: 8, height: 8)
                                Text(m.name).foregroundStyle(Theme.ink)
                                Spacer()
                                if selectedMachineId == m.id { Image(systemName: "checkmark").foregroundStyle(.tint) }
                            }
                        }
                    }
                }
                if let m = selectedMachine, !m.dirs.isEmpty {
                    Section("工作目录") {
                        ForEach(m.dirs, id: \.self) { dir in
                            Button { selectedDir = dir } label: {
                                HStack {
                                    Text(dir).font(.system(.subheadline, design: .monospaced)).lineLimit(1)
                                    Spacer()
                                    if selectedDir == dir { Image(systemName: "checkmark").foregroundStyle(.tint) }
                                }
                            }
                        }
                    }
                }
                if let error {
                    Section { Text(error).font(.footnote).foregroundStyle(Theme.failRed) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.chatBG.ignoresSafeArea())
            .tint(Theme.brandGreen)
            .toolbarBackground(Theme.barBG, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .navigationTitle("新建干活 bot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("创建", action: submit).disabled(!canCreate || creating)
                }
            }
            .task { await model.refreshMachines() }
        }
    }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespaces).lowercased() }
    private var canCreate: Bool { trimmedName.count >= 3 && selectedMachineId != nil && selectedDir != nil }

    private func submit() {
        guard canCreate, !creating, let machineId = selectedMachineId, let dir = selectedDir else { return }
        creating = true
        error = nil
        Task {
            defer { creating = false }
            if await model.createBot(name: trimmedName, machineId: machineId, dir: dir) {
                dismiss()
            } else {
                error = "创建失败（用户名可能已被占用）"
            }
        }
    }
}
