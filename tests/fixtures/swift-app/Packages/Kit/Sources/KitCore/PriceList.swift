/**
 * Prices for every product, in cents,
 * fetched from the shop's price service.
 */
import Foundation

public struct PriceList {
    public var cents: [String: Int] = [:]
    public init() {}

    /// Loads today's prices.
    public static func load() async throws -> PriceList {
        let url = URL(string: "https://prices.example-shop.com/v1/today")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONDecoder().decode(PriceList.self, from: data)
    }
}
