// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "GHCPAgentHubCore",
  platforms: [
    .macOS(.v14)
  ],
  products: [
    .library(
      name: "GHCPAgentHubCore",
      targets: ["GHCPAgentHubCore"]
    ),
  ],
  dependencies: [
    .package(url: "https://github.com/jamesrochabrun/PierreDiffsSwift", exact: "1.1.4"),
    .package(url: "https://github.com/migueldeicaza/SwiftTerm", from: "1.2.0"),
    .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", from: "2.0.0"),
    .package(url: "https://github.com/groue/GRDB.swift", from: "6.24.0"),
    .package(url: "https://github.com/jpsim/Yams", from: "5.0.0"),
  ],
  targets: [
    .target(
      name: "GHCPAgentHubCore",
      dependencies: [
        .product(name: "PierreDiffsSwift", package: "PierreDiffsSwift"),
        .product(name: "SwiftTerm", package: "SwiftTerm"),
        .product(name: "MarkdownUI", package: "swift-markdown-ui"),
        .product(name: "GRDB", package: "GRDB.swift"),
        .product(name: "Yams", package: "Yams"),
      ],
      path: "Sources/GHCPAgentHub",
      swiftSettings: [
        .swiftLanguageMode(.v5)
      ]
    ),
    .testTarget(
      name: "GHCPAgentHubTests",
      dependencies: ["GHCPAgentHubCore"],
      path: "Tests/GHCPAgentHubTests"
    ),
  ]
)
