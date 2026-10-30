// The app's front door: opens the cart screen and keeps the shopper's iCloud copy in step.
import SwiftUI
import KitUI
import KitCore
import CloudKit

@main
struct ShopApp: App {
    var body: some Scene { WindowGroup { CartScreen() } }
}
