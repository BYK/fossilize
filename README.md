# Fossilize

Create self-contained binaries with cross-compiling from your Node.JS application
using [Node SEA][1].

## What is it?

Fossilize is a tool to create Node SEA (Single Executable Applications) binaries
for different platforms. It bundles your Node.js application and its dependencies
into a single CJS file using `esbuild` first and then creates a self-contained
binary from that using the [Node SEA][1] feature.

It also supports embedding assets either file by file, from a directory, or
through a Vite manifest.

## Notes

Currently, it supports signing macOS binaries which is required for them to run
on any system. It uses [`rcodesign`][2] for this through the following env variables:

- `APPLE_TEAM_ID`
- `APPLE_CERT_PATH`
- `APPLE_CERT_PASSWORD`
- `APPLE_API_KEY_PATH`

Further documentation will be added about how to obtain and use these.

[1]: https://nodejs.org/api/single-executable-applications.html#single-executable-applications
[2]: https://github.com/indygreg/apple-platform-rs/releases
