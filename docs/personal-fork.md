# The personal fork

This fork (`Biditmangal/glasshouse`) follows the official releases of
[rorygallagher2024/glasshouse](https://github.com/rorygallagher2024/glasshouse)
and adds a few patches. A TV runs the official build unless someone selects the
**personal channel** on the Server tab and presses **Install**. Nothing here
installs on a TV by itself.

## Branches

| Branch | Holds | Rules |
| :----- | :---- | :---- |
| `main` | A mirror of the official `main` | Fast-forwarded only, by the `mirror` job. Never edited, reset or force-pushed. |
| `personal` | The patches, this automation, and the official releases merged in | The default branch, so the schedule runs. A merge advances it; a person adds patches. It never holds `server/personal.json`. |
| `build/v<base>-personal.<rev>` | One stamped commit per release | Written once. The release tag points at it. |

The official pull-request branches are separate and untouched. This automation
never pushes to the official repository.

## Versions

`TVWEB_VERSION` stays the official base (`0.132.0`) on every branch, so merges
never conflict on the version line and Home Assistant, the package builder and
the Homebrew Channel see no change. A personal build is the base plus a
revision, recorded in `server/personal.json` and shown as
`0.132.0+personal.2.1a2b3c4`:

```json
{"channel":"personal","base":"0.132.0","rev":2,"commit":"<40 hex>",
 "upstream_tag":"v0.132.0","upstream_sha":"<40 hex>","inputs_hash":"<64 hex>",
 "built_by":"github-actions:<run id>"}
```

The revision only goes up, across bases, and is never reused. A release is the
tag `v0.132.0-personal.2`. A build is newer when its base is higher, or the
base is equal and the revision is higher. `built_by` is written only by a
GitHub Actions run, so a build made anywhere else makes no such claim; a
`deploy.sh` build has no `personal.json` at all.

No four-part version is used anywhere: the package tools were not shown to
accept one.

## What a release holds

- `glasshouse-personal-<base>-p<rev>.tar.gz`: the files of `deploy.sh`'s
  `FILES`, `50-tvweb.sh` and `personal.json`, under `glasshouse-personal/`.
  It is reproducible, so the same commit gives the same bytes.
- `glasshouse-personal.manifest.json`: channel, base, rev, commit, file name,
  sha256 and size.
- `SHA256SUMS`.

There is no `.ipk`. An install made by the Homebrew Channel is refused by the
personal channel, as by any in-place update.

## The release run

`.github/workflows/personal-release.yml`, on a daily schedule and by hand
(**Run workflow**, with an input to publish).

1. **`prepare`**, read-only, no secrets. Finds the newest official release
   (not a draft or pre-release, tag `vX.Y.Z`, on the official `main`, declaring
   that version). If the personal branch has it already, only a manual run
   goes on. Otherwise it merges the release into a scratch copy of `personal`.
   The control plane (`.github/`, `scripts/personal/`, `.yamllint`) always
   keeps the personal branch's files: a conflict only there is settled that way,
   and upstream changes to those paths are never adopted. A conflict anywhere
   else, alone or beside those, stops the run with the application paths named
   (exit 20); the automation never resolves one. It runs the static checks on the
   result, builds the bundle, and verifies it.
2. **`mirror`** fast-forwards `main` to the official `main`.
3. **`publish`**, the only job with write access, and only for a run that
   publishes. It runs the tool from the `personal` checkout, never from the
   candidate. It verifies the artifact again: hashes, the commits' shape, every
   file against the commit, the official release looked up afresh, and the
   candidate's tree against the merge made again from the planned tip and the
   release, so nothing outside a genuine merge (and no control plane change)
   gets through. Before it makes any ref it checks that the fork's `personal`
   is where the run planned it and that the release name is unused. It then
   pushes `build/<tag>`, drafts the release, downloads the assets back and
   compares them, advances `personal` with a plain push, and publishes last.
4. **`notify`** opens or comments on one issue, "Personal release automation
   failed", when any job failed. It names which jobs failed and what to check,
   and does not claim whether anything was published: after a publish failure
   look at the Releases and `build/` branches. Issues are off by default in a
   fork; enable them (see below).

A scheduled run publishes only when a new official release is available. The
first release, and any patch-only rebuild, publish only from a manual run with
the input set. A run without it builds and verifies, and leaves a workflow
artifact: that is not a release, and no TV can reach it.

### No spurious builds

Whether a build exists is decided by the *inputs*: the official release's commit
and the candidate's content tree. It is not decided by any commit id. A merge
advances `personal`, so its tip changes, but its tree does not; the next run
finds the same inputs already released and stops. A new patch changes the tree
and is a new build.

### When a run stops

- **Conflict** (exit 20): nothing was built or pushed. Merge the release into a
  branch of the fork by hand, resolve it, and fast-forward `personal`.
- **Interrupted publication** (exit 30): `build/<tag>` exists but no tag does.
  Every run checks this first, scheduled ones included, so a failure late in
  publishing is not hidden by a day with no new official release. Open the
  draft release. Either publish it after checking its assets, or
  delete the draft and the `build/<tag>` branch and run again. A published
  release, its assets and its tag are never edited, replaced or deleted by the
  automation, so the last working release stays the latest.
- **A refused push to `main`**: GitHub refuses the workflow token when the
  official release changed a workflow file. The `mirror` job fails with that
  message, the issue says so, and publishing waits (it fails closed). Use the
  fork's **Sync fork** as the owner, then run again. No token with workflow
  scope is put into the automation to avoid this.

### What is checked, and what is not

Checked on every build: syntax, strict ES5, module calls, UI ids, strings,
screen savers, drift, the entity check against a recorded fixture, `tsc`, the
bundle against its manifest and the commit, and the sha256 after a download
from GitHub. Not run: the fixture tests, the dashboard smoke test, and any
install on a TV. A release says only what its run did.

## Opting a TV in

The personal channel is off by default. Until it is selected, the updater is the
official one and reads only the official releases, with or without a
`personal.json` on the TV.

1. The first personal build has to reach the TV another way, since the official
   updater cannot see this fork: `server/deploy.sh <tv>` from a checkout of the
   `personal` branch (a source build, shown as `0.132.0+<commit>`).
2. On the Server tab, switch **Personal release channel** on, or set
   `"update": { "channel": "personal" }` in `config.json`. The check then reads
   `glasshouse-personal.manifest.json` from this fork's latest release.
3. **Install** puts the release in place, keeps the previous files under
   `.previous`, and restarts the server. `personal.json` is written last, so the
   identity never gets ahead of the files. A failure part way puts the files back.
4. **Roll back** restores the files, removes the ones the update added, and
   the personal identity with them.

The fork's address is in the code, not in a setting or a manifest. The manifest
is held to a fixed shape: the file name is derived, the size and sha256 are
checked before the bundle is opened, and the bundle may hold only plain files
inside `glasshouse-personal/`, with a `tvweb.js` and `personal.json` that agree
with the manifest.

### Going back to the official releases

Switch the channel off. The official updater offers a release only when its
version is higher than the installed base, so on the same base nothing is
offered: roll back (if the previous build was official), or run
`tvwebctl update --force` with the channel off, which installs the official
release and removes `personal.json`. A `deploy.sh` deploy also removes it. Files
only the personal build carries stay in the folder, unused, until the next
`deploy.sh` or an uninstall. There is no automatic switch back.

## Setting it up

These steps need the owner's own credentials; the automation does none of them.

1. Make `personal` the default branch.
2. Fast-forward `main` to the official `main` (the **Sync fork** button).
3. Keep the fork public (the run reads it without credentials, and the TV
   downloads from it), enable Issues (the failure notice needs them), and
   enable Actions. The inherited workflows are gated with
   `if: github.repository == 'rorygallagher2024/glasshouse'` on `personal`, so
   they do nothing here; `main` is a mirror and keeps its own copies, which run
   on pushes the token cannot trigger.
4. Create the `release` environment, limited to the `personal` branch, with a
   required reviewer if a manual approval is wanted.
5. Run **Personal release** by hand with **publish** set. That is the first
   build, `v0.132.0-personal.1`.
6. Install it on a TV as above, once, deliberately.

Scheduled workflows in a fork are switched off by GitHub after 60 days without
activity, with no notice; a quiet fork needs them re-enabled by hand. A release
number is only never reused while the refs holding it stay, so protect them:
add repository rulesets for the tags `v*-personal.*` and the branches `build/*`
(no deletion, no update), and enable immutable releases.

## Patch ledger

What `personal` carries beyond the official release. Each is also an upstream
pull request.

| Patch | Source | Notes |
| :---- | :----- | :---- |
| Type into apps that draw their own keyboard (Control tab) | official PR [#1100](https://github.com/rorygallagher2024/glasshouse/pull/1100) | Branch `fix/custom-keyboard-input` |
| Paired Bluetooth audio devices under Sound, list and choose | official PR [#1101](https://github.com/rorygallagher2024/glasshouse/pull/1101) | Branch `feat/bluetooth-audio` |
| The personal release channel and this automation | this fork only | `server/lib/personal.js`, the updater, `scripts/personal/`, `personal-release.yml` |

When an official release contains a patch, the merge takes the official version
and the entry here is removed.

## Checks to run locally

```
python3 scripts/personal/check-release-flow.py   # real git: merge, build, no-op, interruption, conflict
node test/test-personal.js                       # real bundle, real tar, real install and rollback
```

The first builds scratch repositories in a temporary directory and only reads
this one. Neither needs the network or a TV.
