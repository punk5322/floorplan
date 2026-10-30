//
//  Cart.swift
//  Kit
//
//  Created by Someone on 1/2/26.
//

import Foundation
import Collections

/// The basket a shopper fills before paying.
public struct Cart {
    public var lines: OrderedDictionary<String, Int> = [:]
    public init() {}
    /// A nested type other modules can name, as Cart.Line.
    public struct Line { public let sku: String }
}

/// Adds up a cart in cents.
public func cartTotal(_ cart: Cart, prices: PriceList) -> Int {
    cart.lines.reduce(0) { $0 + (prices.cents[$1.key] ?? 0) * $1.value }
}

private struct Scratch {}
