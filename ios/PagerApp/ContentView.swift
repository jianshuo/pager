import SwiftUI

struct ContentView: View {
    @State private var machines: [MachineSummary] = []
    @State private var notConfigured = false
    @State private var errorMessage: String?
    @State private var isLoading = false
    @State private var showSettings = false

    private let api = HubAPI()

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Pager")
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            showSettings = true
                        } label: {
                            Image(systemName: "gearshape")
                        }
                        .accessibilityLabel("设置")
                    }
                }
                .refreshable { await load() }
                .task { await load() }
                .sheet(isPresented: $showSettings, onDismiss: { Task { await load() } }) {
                    SettingsView()
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        if notConfigured {
            ContentUnavailableView {
                Label("尚未配置", systemImage: "key")
            } description: {
                Text("请在设置里填 token")
            } actions: {
                Button("打开设置") { showSettings = true }
            }
        } else if let errorMessage {
            ContentUnavailableView {
                Label("连接失败", systemImage: "wifi.exclamationmark")
            } description: {
                Text(errorMessage)
            } actions: {
                Button("重试") { Task { await load() } }
            }
        } else {
            List {
                if machines.isEmpty {
                    Text(isLoading ? "加载中…" : "暂无机器").foregroundStyle(.secondary)
                } else {
                    ForEach(machines) { machine in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(machine.name).font(.headline)
                            Text("\(machine.online ? "在线" : "离线")，\(machine.dirs.count) 个目录")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let result = try await api.machines()
            machines = result
            notConfigured = false
            errorMessage = nil
        } catch HubError.notConfigured {
            notConfigured = true
            errorMessage = nil
        } catch {
            notConfigured = false
            errorMessage = "\(error)"
        }
    }
}

#Preview {
    ContentView()
}
