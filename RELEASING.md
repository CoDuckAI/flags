# Releasing CoDuck Flags

The six packages share one version and ship together. The monorepo root is a private npm workspace;
only the individual packages are publishable. A GitHub release is not npm publication.

## Current release line

`0.1.0` is the initial release line. The SDK implementation and local consumer evidence exist;
production adoption, a managed fleet service, and public npm publication are separate milestones.
Before publication, confirm ownership/write access for the `@coduck` npm scope. An unavailable
public registry lookup does not prove that a scope or name is yours to publish.

## Prepare a release

1. Set the same version in all six package manifests. Update the changelog and installation status.
2. Run `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm proof` and `pnpm release:pack`.
3. Review the complete proof recordings and their limitations. Behavioral changes require fresh
   consumer proof; do not relabel old recordings as evidence for new behavior.
4. Review the actual archive contents and `release/<version>/manifest.json`. It records the
   source commit, dirty state, exact hashes and successful isolated-consumer checks.
5. Push the branch, wait for exact-head CI, and merge only with the maintainer's approval.
6. From a clean checkout of the approved main commit, run `pnpm release:pack` again. Release
   artifacts must have `gitDirty: false`; do not publish archives from a dirty worktree.

The release script uses `pnpm pack`, which replaces internal `workspace:*` dependencies with
the exact release version. It validates public manifests, ESM/CommonJS exports, declarations,
license files, schemas/vectors and every tarball entry, then installs all six archives in an
isolated project and runs the quickstart and live-rollout examples. SHA-256 checksums are
written beside the archives. Generated archives are not source files and are ignored by Git.

## Create the GitHub release

Create an annotated `v<version>` tag on the verified main commit. Attach all six `.tgz` files,
`SHA256SUMS.txt` and `manifest.json` to the matching GitHub release. Release notes must explicitly
state whether the packages are available on npm. Do not use an npm version badge before
registry verification succeeds.

GitHub repository visibility is a separate decision because making a repo public exposes its
history. Review that history for secrets and private material before changing visibility.

## Publish to npm

The repository includes a manually dispatched `publish.yml` workflow. It rebuilds a version
tag, checks that it belongs to main, runs the verification gate and publishes packed archives
in dependency order. It uses GitHub-hosted runners and npm trusted publishing; there is no
long-lived npm token stored in this repository.

There is still an account-side setup step. An authorized npm maintainer must bootstrap the
packages if necessary, configure trusted publishing for **each** package, and select the
appropriate allowed publishing action:

| Field               | Value                                  |
| ------------------- | -------------------------------------- |
| GitHub organization | `CoDuckAI`                             |
| Repository          | `flags`                                |
| Workflow filename   | `publish.yml`                          |
| GitHub environment  | Not used by this workflow              |
| Allowed action      | Direct `npm publish` for this workflow |

Do not change account security settings or create publish credentials just to bypass a setup
error. Initial publication may require an authorized maintainer's interactive npm login/2FA.
If package ownership or scope access is unresolved, stop before publishing. Never publish
placeholder packages just to claim a name.

After the account setup and public-repository approval, dispatch **Publish SDK** with the
exact tag, for example `v0.1.0`. The workflow rejects a package/tag version mismatch and dirty
source. It intentionally does not automatically publish whenever someone creates a release.

Existing versions cannot be overwritten. If a run partially publishes, inspect registry
integrity before retrying; the publisher skips an existing version only when its archive
integrity matches the newly verified artifact, otherwise it stops.

Consult the primary documentation for the current account-side steps:
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/),
and [provenance](https://docs.npmjs.com/generating-provenance-statements/).
Provenance attests where a package was built; it does not establish that its behavior is correct.

## Verify publication

For every package, verify version, public accessibility and `dist.integrity` against the release
manifest. Install from npm in a fresh application, run the examples again, and then update the
root README's npm status and installation instructions. Keep the source tag and release assets.

Use the `0.x` changelog to document any breaking API changes. Do not mutate existing bucketing
golden vectors or published schema contracts without explicitly versioning the compatibility change.
