// swift-tools-version: 6.1

import PackageDescription

let package = Package(
  name: "AibillGlance",
  platforms: [
    .macOS(.v14)
  ],
  products: [
    .executable(name: "AibillGlance", targets: ["AibillGlance"])
  ],
  dependencies: [
    .package(
      url: "https://github.com/sparkle-project/Sparkle",
      exact: "2.9.2"
    )
  ],
  targets: [
    .executableTarget(
      name: "AibillGlance",
      dependencies: [
        .product(name: "Sparkle", package: "Sparkle")
      ]
    ),
    .testTarget(
      name: "AibillGlanceTests",
      dependencies: ["AibillGlance"]
    )
  ]
)
