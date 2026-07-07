import SwiftUI

/// Matcha (抹茶) design tokens for the whole app. Single source of colors so nothing is scattered
/// across views. Hex values come from docs/design/pager-im-direction-3A.md.
enum Theme {
    static let chatBG = Color(hex: 0xECEADD)
    static let barBG = Color(hex: 0xF5F4EA)
    static let brandGreen = Color(hex: 0x86A15C)
    static let deepGreen = Color(hex: 0x62823C)
    static let iconGreen = Color(hex: 0x6A8544)
    static let runningGreen = Color(hex: 0x7F9A54)
    static let amber = Color(hex: 0xE0A05A)
    static let amberText = Color(hex: 0xBD7F36)
    static let permBG = Color(hex: 0xF6EAD6)
    static let permBorder = Color(hex: 0xECD6AB)
    static let permMono = Color(hex: 0x8A6A2A)
    static let ink = Color(hex: 0x333A2D)
    static let cream = Color(hex: 0xFFFEF9)
    static let creamBorder = Color(hex: 0xE9E7D7)
    static let aiBubbleBorder = Color(hex: 0xEFE6CF)
    static let textSecondary = Color(hex: 0x5F6653)
    static let textTertiary = Color(hex: 0xA9AD97)
    static let toolChipBG = Color(hex: 0xF3F1E4)
    static let toolChipBorder = Color(hex: 0xE5E2D0)
    static let toolMono = Color(hex: 0x4D5C34)
    static let datePillBG = Color(hex: 0xE2E0D0)
    static let datePillText = Color(hex: 0xB0B39D)
    static let statusPillBG = Color(hex: 0xEEF1E0)
    static let denyBtnBorder = Color(hex: 0xE5D3AD)
    static let denyBtnText = Color(hex: 0x8A7A4A)
    static let failRed = Color(hex: 0xC06A55)
}

extension Color {
    init(hex: UInt) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xff) / 255,
                  green: Double((hex >> 8) & 0xff) / 255,
                  blue: Double(hex & 0xff) / 255,
                  opacity: 1)
    }
}

/// Reusable AI avatar: dark ink circle + amber ring + a small orbit/atom glyph in amber.
struct AIAvatar: View {
    var size: CGFloat = 32
    var body: some View {
        ZStack {
            Circle()
                .fill(Theme.ink)
                .overlay(Circle().stroke(Theme.amber, lineWidth: 1.5))
            Image(systemName: "atom")
                .font(.system(size: size * 0.45, weight: .semibold))
                .foregroundStyle(Theme.amber)
        }
        .frame(width: size, height: size)
    }
}

/// Avatar for another human in a room: a solid circle in a stable per-name color with the
/// name's first character. Amber is reserved for the AI, so this palette stays green/teal/olive.
struct HumanAvatar: View {
    let name: String
    var size: CGFloat = 32

    /// Matcha-friendly palette (no amber). A deterministic hash of the name picks one, so a given
    /// name always maps to the same color — across launches, not just within one session.
    private static let palette: [Color] = [
        Color(hex: 0x86A15C), // brandGreen
        Color(hex: 0x62823C), // deepGreen
        Color(hex: 0x6A8544), // iconGreen
        Color(hex: 0x5F8C7E), // teal
        Color(hex: 0x8A7A4A), // olive
        Color(hex: 0x7A8C4C), // moss
    ]

    private var color: Color {
        guard !name.isEmpty else { return Theme.textTertiary }
        let sum = name.unicodeScalars.reduce(0) { $0 &+ Int($1.value) }
        return Self.palette[sum % Self.palette.count]
    }

    private var initial: String {
        String(name.prefix(1)).uppercased()
    }

    var body: some View {
        ZStack {
            Circle().fill(color)
            Text(initial)
                .font(.system(size: size * 0.44, weight: .bold))
                .foregroundStyle(Color.white)
        }
        .frame(width: size, height: size)
    }
}
