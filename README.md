# Fossilize

Create self-contained binaries with cross-compiling from your Node.JS application
using [Node SEA][1].

## Description

Fossilize is a tool to create Node SEA (Single Executable Applications) binaries
for different platforms. It bundles your Node.js application and its dependencies
into a single CJS file using `esbuild` first and then creates a self-contained
binary from that using the [Node SEA][1] feature.

It also supports embedding assets either file by file, from a directory, or
through a Vite manifest.

[1]: https://nodejs.org/api/single-executable-applications.html#single-executable-applications
