import SwiftUI
import KitCore

/// Shows what's in the cart and its total.
public struct CartView: View {
    let cart: Cart
    let prices: PriceList
    public var body: some View {
        Text(Format.cents(cartTotal(cart, prices: prices)))
    }
}
