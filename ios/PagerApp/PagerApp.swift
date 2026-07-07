import SwiftUI

@main
struct PagerApp: App {
    init() {
        // 开发便利：Keychain 无 token 时，从启动环境变量注入（模拟器活体测试用，
        // simctl launch 时用 SIMCTL_CHILD_PAGER_DEBUG_TOKEN 传入）。生产无此变量即空操作。
        if Keychain.token == nil, let t = ProcessInfo.processInfo.environment["PAGER_DEBUG_TOKEN"], !t.isEmpty {
            Keychain.token = t
        }
    }
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}
