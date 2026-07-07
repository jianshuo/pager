import SwiftUI

/// App root. All state lives in the shared `AppModel` injected by `PagerApp` via `.environment`;
/// this view just hosts the conversations list.
struct ContentView: View {
    var body: some View {
        ConversationListView()
            .tint(Theme.brandGreen)
    }
}

#Preview {
    ContentView()
        .environment(AppModel())
}
