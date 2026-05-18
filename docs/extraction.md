# BridgeKit extraction record

Date: 2026-05-18

## Source

- Source repository: `/Users/feniix/src/personal/pi/pi-experiments`
- Source commit (`git rev-parse HEAD`): `b86fb59c4213f985c64202adb3ab4ca2a29a6f9b`
- Source branch at extraction time: `feat/graduate-bridgekit-standalone`
- Source `git status --short` before extraction: empty
- Source `git status --short` after extraction: empty

## Dependency baseline

- Node engine before extraction: `>=20`
- Standalone Node engine floor: `>=22.19.0`
- `@modelcontextprotocol/sdk` dependency: `^1.29.0`
- `@modelcontextprotocol/sdk` lockfile resolution: `1.29.0`
- TypeBox dependency: `^1.1.31`
- TypeBox lockfile resolution: `1.1.38`

MCP SDK v2 was intentionally not evaluated or adopted during this extraction. BridgeKit remains on the MCP SDK v1 baseline.

## Target remote preflight

Command:

```sh
git ls-remote --heads --tags git@github.com:feniix/bridgekit.git
```

Output: empty (no remote heads or tags).

## History extraction command

Tooling used: `git-filter-repo` 2.47.0 installed as `/Users/feniix/.local/bin/git-filter-repo`.

Command sequence:

```sh
git clone --no-local /Users/feniix/src/personal/pi/pi-experiments /Users/feniix/src/personal/pi/bridgekit
cd /Users/feniix/src/personal/pi/bridgekit
git checkout --detach b86fb59c4213f985c64202adb3ab4ca2a29a6f9b
/Users/feniix/.local/bin/git-filter-repo --force \
  --path packages/pi-portable-tools/ \
  --path packages/bridgekit/ \
  --path-rename packages/pi-portable-tools/: \
  --path-rename packages/bridgekit/:
git checkout main
```

`git-filter-repo` removed the temporary source `origin` remote, which had pointed at `/Users/feniix/src/personal/pi/pi-experiments`. The standalone target remote is added separately after local verification.

## Rewritten commit traceability

Exact source commit hashes are expected to change after path rewriting. Verification uses subject, author, authored date, and content traceability instead.

| Original source SHA | Rewritten SHA | Subject | Author | Authored date | Notes |
| --- | --- | --- | --- | --- | --- |
| `c2ffbab907987ce581aa86ea0c6f917edccb78c1` | `58dbf56a717bcf5f4915dd4ef8eef052d8535fd2` | `feat(portable-tools): add core sdk package` | Sebastian Otaegui `<feniix@gmail.com>` | `2026-05-16T22:12:27-03:00` | Pre-rename portable-tool history retained. |
| `72d4701c735e07d6d80666e24233da1d77f637b0` | `61832951b7c9d6d2f91a4e922795deb0a1a6a0af` | `chore: rename portable tool SDK to BridgeKit` | Sebastian Otaegui `<feniix@gmail.com>` | `2026-05-17T15:03:30-03:00` | Rename commit survived path rewriting and was not pruned. |

## Verification summary

- Root files after filtering: `package.json`, `README.md`, `llms.txt`, `examples/README.md`, `src/`, and `tsconfig.json` existed at repository root.
- No `packages/` directory remained after filtering.
- The source checkout remained unchanged before and after extraction.
- Target remote preflight showed no heads or tags before any push.
- `npm run check`: passed.
- `npm run test`: passed; 12 built Node tests passed.
- `npm run pack:dry-run`: passed; `prepack` rebuilt and verified standalone dist metadata.
- `npm run package-smoke`: passed; a temporary consumer installed the tarball, imported all public subpaths, compiled a NodeNext TypeScript fixture with a direct TypeBox dependency, and confirmed unsupported deep imports fail.
