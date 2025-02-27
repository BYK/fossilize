# Fossilize

![NPM Version][1] ![Build Status][2]

Create self-contained binaries for all platforms supported by Node.js using [Node SEA][3].

## Usage

### With `npx`

In the root of your Node.js project

```shell
npx fossilize
```

or just give it your entrypoint file

```shell
npx fossilize main.js
```

### As a dev dependency

It is also possible to use fossilize as a dev dependency. Add it to your project first:

```shell
npm add --save-dev fossilize
```

and then add a `compile` script to your project referencing fossilize:

```json
{
   "scripts": {
      "compile": "fossilize -a some.html -n lts"
   }
}
```

### Supported Environment Variables

- `FOSSILIZE_SIGN`
- `FOSSILIZE_NODE_VERSION`
- `FOSSILIZE_CACHE_DIR`
- `FOSSILIZE_PLATFORMS` (comma separated)
- `FOSSILIZE_CONCURRENCY_LIMIT`

## What is it?

Fossilize is a tool to create Node SEAs (Single Executable Applications)
for different platforms. It bundles your Node.js application and its dependencies
into a single CJS file using `esbuild`. Then creates a self-contained binary from
that using the [Node SEA][3] feature.

It also supports embedding assets either file by file, from a directory, or
through a Vite manifest.

## Why?

Long version: [https://byk.im/posts/fossilize/](https://byk.im/posts/fossilize/)

### Why would I want a single-executable Node.js application?

If you are building a CLI application using Node.js, it becomes a challenge to
distribute it. You may rely on `npx` which requires Node.js but you'd also need
to make sure your app works with many Node.js versions. Your tool being written
in JS does not necessarily mean it is for Node.js users but it would require
Node.js on their system. With Node SEA, you just give them a self-contained
binary without any other system requirements (except for `libc`) and you are
done.

Alternatively, you might be developing a server application that you want to
distribute and deploy using Docker. Now you need to maintain a Docker image
build pipeline, optimize the image building process based on dependencies,
learn how to minimize image size by deleting package manager caches etc.
On the other hand, if you distribute your application as a Node SEA, then
all you need to do is copy a single binary into a base Linux distro image
that has `libc` (sorry Alpine) and you are good to go.

### Why do I need `fossilize`?

If you go check the documentation for Node SEA, not only you'd see that it is
marked as "under active development", you'd also realize that there are these
manual and hand-wavy steps that you need to follow to build a Node SEA binary.
Just the macOS signing part is a big discovery journey itself whereas if you
are using [Deno][5] for instance, it is just [`deno compile`][6].

_Yes, we can improve the docs and we probably should but an automated tool is still better._

### Why is `fossilize` itself not a Node SEA?

Oh the irony! I actually tried but there are two main blockers right now:

1. I want to include a bundler and both `esbuild` and `rollup` have native
   components. They do support and have WASM so this is still possible but
   I just didn't have that time to work on this yet.
2. [postject][7], the library we use to inject your app into the Node.js binary
   gets confused if you try to inject itself (or some code contains itself).
   This is most probably solvable with a pull request but that requires time
   like the item above, which I've yet to spend.

## Notes

Currently, it supports signing macOS binaries which is required for them to run
on any system. It uses [`rcodesign`][4] for this through the following env variables:

- `APPLE_TEAM_ID`
- `APPLE_CERT_PATH`
- `APPLE_CERT_PASSWORD`
- `APPLE_API_KEY_PATH`

Further documentation will be added about how to obtain and use these.

[1]: https://img.shields.io/npm/v/fossilize
[2]: https://github.com/BYK/fossilize/actions/workflows/build.yml/badge.svg?branch=main
[3]: https://nodejs.org/api/single-executable-applications.html#single-executable-applications
[4]: https://github.com/indygreg/apple-platform-rs/releases
[5]: https://deno.com/
[6]: https://docs.deno.com/runtime/reference/cli/compile/
[7]: https://www.npmjs.com/package/postject
