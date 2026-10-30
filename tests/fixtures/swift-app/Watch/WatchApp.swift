import SwiftUI
import KitCore

/// The Watch app: just the total.
@main
struct WatchApp: App {
    var body: some Scene { WindowGroup { Text("\(cartTotal(Cart(), prices: PriceList()))") } }
}
