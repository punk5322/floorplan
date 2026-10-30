// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Kit",
    platforms: [.iOS(.v17), .watchOS(.v10)],
    products: [
        .library(name: "KitUI", targets: ["KitUI"]),
        .library(name: "KitCore", targets: ["KitCore"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-collections.git", from: "1.1.0"),
    ],
    targets: [
        .target(name: "KitCore", dependencies: [.product(name: "Collections", package: "swift-collections")]),
        .target(name: "KitUI", dependencies: ["KitCore"]),
        .testTarget(name: "KitCoreTests", dependencies: ["KitCore"]),
    ]
)
