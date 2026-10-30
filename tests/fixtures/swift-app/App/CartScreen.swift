import SwiftUI
import KitUI
import KitCore
import HealthKit

/// The cart tab: the list, the total and the Pay button.
struct CartScreen: View {
    @State var cart = Cart()
    var body: some View { CartView(cart: cart, prices: PriceList()) }
}

enum Secrets {
    /// The Keychain item holding the shopper's sign-in, by account name.
    static let account = isWatch ? "shop-password" : "shop-password-watch"
    static func save(_ token: String) { Keychain.save(token, service: "shop-password-store", account: "shop-password") }
}
let isWatch = false
