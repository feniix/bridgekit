# Docs

Internal documentation for BridgeKit maintainers. Consumer-facing docs live at the repo root (`README.md`, `llms.txt`, `examples/README.md`).

| File | Purpose |
| --- | --- |
| [extraction.md](extraction.md) | Historical record of how this package was extracted from the `pi-experiments` monorepo. Source commit, filter-repo command, verification summary. Read when investigating why something looks the way it does. |
| [packaging-invariants.md](packaging-invariants.md) | Per-check catalog backing `scripts/smoke-package.mjs`. Stable `inv-*` anchors per check. **Read before touching the verification pipeline.** |
| [releasing.md](releasing.md) | Release process, OIDC trusted publishing setup, threat model, pre-1.0 compatibility policy, bad-version response procedures. Read before cutting a release. |

## Reading order for new maintainers

1. `../README.md` and `../CLAUDE.md` — what the package is and the load-bearing constraints.
2. [`releasing.md`](releasing.md) — how versions ship.
3. [`packaging-invariants.md`](packaging-invariants.md) — what the verification pipeline guards.
4. [`extraction.md`](extraction.md) — why the shape is what it is.
