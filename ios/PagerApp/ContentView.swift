import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack(spacing: 12) {
            Text("Pager").font(.largeTitle.bold())
            Text(selfCheck()).font(.footnote).foregroundStyle(.secondary)
        }
        .padding()
    }
    private func selfCheck() -> String {
        let json = #"{"id":"evt_1","conv":"cnv_1","seq":1,"ts":1751780000,"role":"agent","agent":"claude-code","type":"text","body":{"markdown":"hi"}}"#
        do {
            let e = try JSONDecoder().decode(Event.self, from: Data(json.utf8))
            if case .text(let md) = e.body { return "协议 OK：\(md)" }
            return "协议解码到非 text"
        } catch { return "协议解码失败：\(error)" }
    }
}
