import SwiftUI

/// The home screen: a machine online strip on top, the conversations list below, and toolbar
/// entry points for a new conversation and settings. Owns the `NavigationStack` and its path.
struct ConversationListView: View {
    @Environment(AppModel.self) private var model

    @State private var path: [ConvRoute] = []
    @State private var showNew = false
    @State private var showNewRoom = false
    @State private var showSettings = false
    @State private var toast: String?

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                machineStrip
                Divider().overlay(Theme.creamBorder)
                conversationList
            }
            .background(Theme.chatBG.ignoresSafeArea())
            .navigationTitle("Pager")
            .toolbarBackground(Theme.barBG, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .tint(Theme.brandGreen)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                        .tint(Theme.iconGreen)
                        .accessibilityLabel("设置")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { showNewRoom = true } label: { Label("新建群聊", systemImage: "person.2") }
                        Button { showNew = true } label: { Label("让 AI 干活", systemImage: "sparkles") }
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .tint(Theme.iconGreen)
                    .accessibilityLabel("新对话")
                }
            }
            .navigationDestination(for: ConvRoute.self) { route in
                ConversationView(conv: route.id, machineName: route.machineName, dir: route.dir)
            }
            .refreshable { await refresh() }
            .task {
                model.connect()   // idempotent; scenePhase .active may not fire on cold launch
                await refresh()
                #if DEBUG
                // 开发便利：SIMCTL_CHILD_PAGER_DEBUG_OPEN_CONV 指定的会话在刷新后自动打开
                // （模拟器活体测试用，避开 openurl 的系统确认弹窗）。生产无此变量即空操作。
                if let cid = ProcessInfo.processInfo.environment["PAGER_DEBUG_OPEN_CONV"],
                   cid.hasPrefix("cnv_"), path.isEmpty {
                    let s = model.conversations.first { $0.id == cid }
                    path.append(ConvRoute(id: cid, machineName: s?.machineName ?? "建硕的 Mac", dir: s?.dir ?? ""))
                }
                #endif
            }
            // 深链 pager://conversation/<convId>：APNs 通知点按 + 活体测试用。
            // 机器名/目录从已刷新的会话列表里查；查不到就留空（事件按 conv id 键，仍能流）。
            .onOpenURL { url in
                guard url.scheme == "pager", url.host == "conversation" else { return }
                let convId = url.lastPathComponent
                guard convId.hasPrefix("cnv_") else { return }
                let summary = model.conversations.first { $0.id == convId }
                path.append(ConvRoute(id: convId,
                                      machineName: summary?.machineName ?? "",
                                      dir: summary?.dir ?? ""))
            }
            // 深链来源二：锁屏/通知中心点按通知正文（非 ALLOW/DENY 按钮）。AppDelegate（见
            // PushManager.swift）把目标 conv id 写进 model.deepLinkConv，这里观察到后入栈并清空，
            // 复用与 .onOpenURL 相同的「从已刷新会话列表查机器名/目录」逻辑。
            .onChange(of: model.deepLinkConv) { _, newValue in
                guard let convId = newValue, convId.hasPrefix("cnv_") else { return }
                let summary = model.conversations.first { $0.id == convId }
                path.append(ConvRoute(id: convId,
                                      machineName: summary?.machineName ?? "",
                                      dir: summary?.dir ?? ""))
                model.deepLinkConv = nil
            }
            .sheet(isPresented: $showNew) {
                NewConversationView(
                    onCreated: { route in path.append(route) },
                    onCreatedButFailed: { showToast("已创建但失败，稍后在列表查看") }
                )
            }
            .sheet(isPresented: $showSettings, onDismiss: { Task { await refresh() } }) {
                SettingsView()
            }
            .sheet(isPresented: $showNewRoom) {
                NewRoomView(onCreated: { route in
                    path.append(route)
                    Task { await refresh() }
                })
            }
            .overlay(alignment: .bottom) { toastView }
        }
    }

    // MARK: - Machine strip

    private var machineStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 14) {
                if model.machines.isEmpty {
                    Text("暂无机器").font(.caption).foregroundStyle(Theme.textTertiary)
                }
                ForEach(sortedMachines) { machine in
                    HStack(spacing: 5) {
                        Circle()
                            .fill(machine.online ? Theme.runningGreen : Theme.textTertiary.opacity(0.5))
                            .frame(width: 7, height: 7)
                        Text(machine.name)
                            .font(.caption)
                            .foregroundStyle(machine.online ? Theme.ink : Theme.textSecondary)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .background(Theme.barBG)
    }

    private var sortedMachines: [MachineSummary] {
        model.machines.values.sorted { ($0.online ? 0 : 1, $0.name) < ($1.online ? 0 : 1, $1.name) }
    }

    // MARK: - Conversation list

    private var conversationList: some View {
        List {
            if model.conversations.isEmpty {
                Text("暂无对话")
                    .foregroundStyle(Theme.textSecondary)
                    .listRowBackground(Theme.chatBG)
            }
            ForEach(model.conversations) { conv in
                NavigationLink(value: ConvRoute(id: conv.id, machineName: conv.machineName, dir: conv.dir)) {
                    ConversationRow(
                        summary: conv,
                        dot: statusDot(for: conv)
                    )
                }
                .listRowBackground(Theme.chatBG)
                .listRowSeparatorTint(Theme.creamBorder)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.chatBG)
    }

    /// Derives the row's status dot from the live event stream, falling back to the REST summary
    /// state. Precedence: an unanswered permission request (🟠) outranks everything — the daemon
    /// is blocked waiting on the user. Otherwise we map the latest `status` state, preferring the
    /// live WS-derived state over the list summary's `state`.
    private func statusDot(for conv: ConversationSummary) -> Color {
        if model.pendingPermission(for: conv.id) != nil { return Theme.amber }
        // Rooms behave like conversations: an AI-bound room can go "running" while the AI works,
        // but a room with no live status has no machine failure state — show neutral, not red.
        let live = model.latestStatus(for: conv.id)
        let state = conv.kind == "room" ? (live ?? "idle") : (live ?? conv.state)
        switch state {
        case "running": return Theme.runningGreen
        case "failed": return Theme.failRed
        default: return Theme.textTertiary   // done / thinking / idle / unknown
        }
    }

    // MARK: - Refresh + toast

    private func refresh() async {
        await model.refreshMachines()
        await model.refreshConversations()
    }

    private func showToast(_ text: String) {
        toast = text
        Task {
            try? await Task.sleep(for: .seconds(2.5))
            if toast == text { toast = nil }
        }
    }

    @ViewBuilder
    private var toastView: some View {
        if let toast {
            Text(toast)
                .font(.footnote)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(.thinMaterial, in: Capsule())
                .padding(.bottom, 24)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

// MARK: - Row

private struct ConversationRow: View {
    let summary: ConversationSummary
    let dot: Color

    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(dot).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(summary.machineName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.ink)
                    if !shortDir.isEmpty {
                        Text(shortDir).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
                    }
                }
                Text(summary.lastMessage.isEmpty ? "（无消息）" : summary.lastMessage)
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }

    private var shortDir: String {
        (summary.dir as NSString).lastPathComponent
    }
}
