// swift-tools-version: 6.2

import PackageDescription

let package = Package(
  name: "AibillGlance",
  platforms: [
    .macOS(.v14)
  ],
  products: [
    .executable(name: "AibillGlance", targets: ["AibillGlance"])
  ],
  targets: [
    .executableTarget(name: "AibillGlance")
  ]
)
