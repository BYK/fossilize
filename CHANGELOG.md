# Changelog
## 0.8.0

### New Features ✨

- Add `--hole-punch` flag to zero unused ICU data before signing, reducing compressed binary size by ~24%. Uses [binpunch](https://github.com/BYK/binpunch) internally. Opt-in via `--hole-punch` or `FOSSILIZE_HOLE_PUNCH=y` — drops non-English i18n data, so only enable for English-only CLIs.

## 0.7.0

### New Features ✨

- Strip debug symbols from Node binaries before SEA injection by @BYK in [#16](https://github.com/BYK/fossilize/pull/16)

### Bug Fixes 🐛

- Use client-id instead of deprecated app-id for GitHub App token by @BYK in [#15](https://github.com/BYK/fossilize/pull/15)

## 0.6.0

### New Features ✨

- Enable V8 code cache for host-platform binaries by @BYK in [#8](https://github.com/BYK/fossilize/pull/8)
- Implemenent --asset flag handling by @BYK in [#3](https://github.com/BYK/fossilize/pull/3)

### Bug Fixes 🐛

- Correct workflow name in .craft.yml artifact provider by @BYK in [#13](https://github.com/BYK/fossilize/pull/13)

### Internal Changes 🔧

- Add Craft-based release pipeline by @BYK in [#10](https://github.com/BYK/fossilize/pull/10)

### Other

- 0.6.0 by @BYK in [#9](https://github.com/BYK/fossilize/pull/9)

