import XCTest
@testable import KitCore

final class CartTests: XCTestCase {
    func testEmpty() { XCTAssertEqual(cartTotal(Cart(), prices: PriceList()), 0) }
}
