import Foundation

/// A paid order, ready to show or email.
public struct Receipt {
    public let total: Int
    // Cart is mentioned only in this comment, and below only inside strings.
    public var summary: String { "Paid for your Cart" }
    public static let template = """
        Thanks! Your PriceList was applied.
        """
    public static let raw = #"No Cart here either: \(not code)"#
    public static let mixed = "Total: \(Format.cents(1))"
}

public enum Format {
    public static func cents(_ n: Int) -> String { "$\(n / 100)" }
}
