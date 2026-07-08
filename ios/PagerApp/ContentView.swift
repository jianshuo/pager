import SwiftUI

/// App root. Gates on login: shows the auth screen until a session exists, then the conversations
/// list. All state lives in the shared `AppModel` injected by `PagerApp`.
struct ContentView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if model.isLoggedIn {
                ConversationListView()
            } else {
                AuthView()
            }
        }
        .tint(Theme.brandGreen)
    }
}

#Preview {
    ContentView()
        .environment(AppModel())
}
