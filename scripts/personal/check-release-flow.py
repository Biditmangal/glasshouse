#!/usr/bin/env python3
"""
Runs the personal release tooling end to end on real git repositories made in
a temporary directory: a copy of this repository as the personal branch, a bare
repository as the fork, and another as the official one with a newer release.
Nothing leaves the machine and this repository is only read.

It covers what the schedule relies on: a new official release is merged with
.github kept, built and verified; an interrupted publication is reported rather
than silently skipped; once published, the same inputs (the official release and
the content tree) are a no-op even though the personal branch advanced; a patch
changes the inputs; a conflicting release stops without a build.

    scripts/personal/check-release-flow.py
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
TOOL = os.path.join(HERE, 'personal_release.py')
ENV = dict(os.environ, GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@example.invalid',
           GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@example.invalid')
for var in ('GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_ACTIONS', 'GITHUB_OUTPUT'):
    ENV.pop(var, None)


def sh(*cmd, cwd=None, ok=True):
    run = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=ENV)
    if ok and run.returncode != 0:
        sys.exit(f"FAILED: {' '.join(cmd)}\n{run.stdout}{run.stderr}")
    return run


def git(cwd, *args, ok=True):
    return sh('git', *args, cwd=cwd, ok=ok)


def tool(cwd, work, *args, expect=0):
    run = sh(sys.executable, TOOL, *args, cwd=cwd, ok=False)
    if run.returncode != expect:
        sys.exit(f'tool {args[0]} exited {run.returncode}, expected {expect}\n{run.stdout}{run.stderr}')
    plan = os.path.join(work, 'plan.json')
    return json.load(open(plan)) if args[0] == 'plan' and expect == 0 else None


def plan(p, upstream, work, event='schedule', publish='false', tag='v0.133.0', expect=0):
    return tool(p, work, 'plan', '--repo', p, '--work', work, '--upstream-tag', tag, '--upstream-url', upstream,
                '--event', event, '--publish-requested', publish, expect=expect)


def bump(path, old, new):
    text = open(path).read()
    assert f"TVWEB_VERSION = '{old}'" in text
    with open(path, 'w') as f:
        f.write(text.replace(f"TVWEB_VERSION = '{old}'", f"TVWEB_VERSION = '{new}'"))


def check(cond, what):
    print(('ok    ' if cond else 'FAIL  ') + what)
    if not cond:
        sys.exit(1)


def main():
    tmp = tempfile.mkdtemp(prefix='personal-flow-')
    upstream, fork, p = [os.path.join(tmp, n) for n in ('upstream.git', 'fork.git', 'personal')]
    # The official repository: this one's history up to v0.132.0, then a newer release.
    sh('git', 'clone', '--quiet', '--no-local', ROOT, os.path.join(tmp, 'u'))
    u = os.path.join(tmp, 'u')
    git(u, 'checkout', '--quiet', '-B', 'main', 'v0.132.0')
    git(u, 'tag', '-f', 'v0.132.0', 'v0.132.0')
    tv = os.path.join(u, 'server', 'tvweb.js')
    bump(tv, '0.132.0', '0.133.0')
    with open(os.path.join(u, 'server', 'official-note.txt'), 'w') as f:
        f.write('official 0.133.0\n')
    wf = os.path.join(u, '.github', 'workflows', 'official-only.yml')
    open(wf, 'w').write('name: official only\non: push\njobs: {}\n')
    git(u, 'add', '-A')
    git(u, 'commit', '-q', '-m', 'Bump version to 0.133.0')
    git(u, 'tag', 'v0.133.0')
    sh('git', 'clone', '--quiet', '--bare', u, upstream)

    # The fork, and the personal branch as it is in this repository.
    sh('git', 'init', '--quiet', '--bare', fork)
    # This checkout may be shallow; GitHub's own checkout in the workflow is not.
    git(fork, 'config', 'receive.shallowUpdate', 'true')
    sh('git', 'clone', '--quiet', '--no-local', '--branch', 'personal', ROOT, p)
    git(p, 'remote', 'set-url', 'origin', fork)
    git(p, 'push', '--quiet', 'origin', 'personal')
    tip0 = git(p, 'rev-parse', 'HEAD').stdout.strip()
    githubdir0 = git(p, 'rev-parse', 'HEAD:.github').stdout.strip()

    # 1. Bootstrap: v0.132.0 is already merged, so only a manual publish builds it.
    w = os.path.join(tmp, 'w0')
    r = plan(p, upstream, w, event='schedule', tag='v0.132.0')
    check(r['action'] == 'noop' and 'manual' in r['reason'], 'schedule: no new release, patch-only is not built')
    r = plan(p, upstream, w, event='workflow_dispatch', publish='true', tag='v0.132.0')
    check(r['action'] == 'build' and r['publish'] and r['rev'] == 1 and r['mode'] == 'patch-only',
          'dispatch with publish: bootstrap build is rev 1')
    r = plan(p, upstream, os.path.join(tmp, 'w0b'), event='workflow_dispatch', publish='false', tag='v0.132.0')
    check(r['action'] == 'build' and not r['publish'], 'dispatch without publish: artifacts only')

    # An earlier publication that stopped part way is reported even when the
    # schedule has no new release to build, so a late failure is not silent.
    git(p, 'push', '--quiet', 'origin', tip0 + ':refs/heads/build/v0.132.0-personal.1')
    plan(p, upstream, os.path.join(tmp, 'w0o'), event='schedule', tag='v0.132.0', expect=30)
    check(True, 'orphan build branch: exit 30 on a schedule that would otherwise be a no-op')
    git(p, 'push', '--quiet', 'origin', '--delete', 'build/v0.132.0-personal.1')
    plan(p, upstream, os.path.join(tmp, 'w0n'), tag='v0.133.0\n', expect=2)
    check(True, 'a tag with a trailing newline is not a tag')

    # 2. A new official release on the schedule: merged, .github kept.
    w1 = os.path.join(tmp, 'w1')
    r = plan(p, upstream, w1)
    check(r['action'] == 'build' and r['publish'] and r['mode'] == 'merge', 'schedule: new official release is built and publishable')
    cand = r['candidate']
    check(git(p, 'rev-parse', cand + ':.github').stdout.strip() == githubdir0,
          '.github in the candidate is the personal branch\'s own (official-only workflow not adopted)')
    check(git(p, 'cat-file', '-e', cand + ':server/official-note.txt', ok=False).returncode == 0, 'official files arrived')
    check(git(p, 'cat-file', '-e', cand + ':server/lib/btaudio.js', ok=False).returncode == 0, 'the personal patches (Bluetooth audio) remain')
    out1 = os.path.join(tmp, 'out1')
    tool(p, w1, 'build', '--repo', p, '--work', w1, '--out', out1)
    tool(p, w1, 'verify', '--repo', p, '--dir', out1, '--upstream-url', upstream)
    tool(p, w1, 'verify-assets', '--dir', out1)
    release = json.load(open(os.path.join(out1, 'release.json')))
    check(release['release_tag'] == 'v0.133.0-personal.1', 'tag is v<base>-personal.<rev>')

    # 3. Publish up to the interruption: build branch pushed, no tag yet.
    git(p, 'push', '--quiet', 'origin', release['stamp'] + ':refs/heads/build/' + release['release_tag'])
    plan(p, upstream, os.path.join(tmp, 'w1b'), expect=30)
    check(True, 'build branch without tag: reported as interrupted (exit 30), not a silent no-op')

    # 4. Finish publishing: tag, then the personal branch fast-forwards to the merge.
    git(p, 'push', '--quiet', 'origin', release['stamp'] + ':refs/tags/' + release['release_tag'])
    git(p, 'merge', '--quiet', '--ff-only', cand)
    git(p, 'push', '--quiet', 'origin', 'HEAD:refs/heads/personal')
    check(git(p, 'rev-parse', 'HEAD').stdout.strip() != tip0, 'personal advanced to the merge commit')
    # Publishing starts only if the fork's branch is where the run planned it.
    tip_now = git(p, 'rev-parse', 'HEAD').stdout.strip()
    pre = ['preflight', '--repo', p, '--remote', 'origin']
    tool(p, w1, *pre, '--tag', 'v0.134.0-personal.9', '--tip', tip_now)
    tool(p, w1, *pre, '--tag', 'v0.134.0-personal.9', '--tip', tip0, expect=2)
    tool(p, w1, *pre, '--tag', release['release_tag'], '--tip', tip_now, expect=2)
    tool(p, w1, *pre, '--tag', 'v0.134.0-personal.9\n', '--tip', tip_now, expect=2)
    check(True, 'preflight: refused when the fork moved or the name is taken, accepted otherwise')
    r = plan(p, upstream, os.path.join(tmp, 'w2'), event='workflow_dispatch', publish='true')
    check(r['action'] == 'noop' and 'already released' in r['reason'],
          'same official release and same content tree after personal advanced: no-op, even by hand')
    r = plan(p, upstream, os.path.join(tmp, 'w2b'))
    check(r['action'] == 'noop', 'schedule after publication: no-op')

    # 5. A patch changes the inputs; only a manual run publishes it, as revision 2.
    open(os.path.join(p, 'server', 'patch-note.txt'), 'w').write('a personal patch\n')
    git(p, 'add', '-A')
    git(p, 'commit', '-q', '-m', 'A personal patch')
    r = plan(p, upstream, os.path.join(tmp, 'w3'))
    check(r['action'] == 'noop', 'schedule: a patch alone does not publish')
    r = plan(p, upstream, os.path.join(tmp, 'w3b'), event='workflow_dispatch', publish='true')
    check(r['action'] == 'build' and r['rev'] == 2 and r['mode'] == 'patch-only', 'manual: patch is rev 2, not reusing rev 1')

    # 6. A release that conflicts stops without building anything.
    git(u, 'checkout', '--quiet', '-B', 'main', 'v0.133.0')
    bump(tv, '0.133.0', '0.134.0')
    with open(os.path.join(u, 'server', 'patch-note.txt'), 'w') as f:
        f.write('an official change to the same file\n')
    git(u, 'add', '-A')
    git(u, 'commit', '-q', '-m', 'Bump version to 0.134.0')
    git(u, 'tag', 'v0.134.0')
    sh('git', 'push', '--quiet', '--force', upstream, 'main', 'refs/tags/v0.134.0', cwd=u)
    w4 = os.path.join(tmp, 'w4')
    plan(p, upstream, w4, tag='v0.134.0', expect=20)
    check(not os.path.exists(os.path.join(w4, 'plan.json')), 'conflict: exit 20, no plan and nothing to build')
    control_plane(tmp)
    print('all checks passed; scratch repositories in ' + tmp)


def make_world(tmp, name, app_conflict):
    """An official repository one release ahead, a fork, and a personal branch whose
    gated workflow, .yamllint and tooling differ from the official ones in the
    same lines the release edits."""
    base = os.path.join(tmp, name)
    u, upstream, fork, p = [os.path.join(base, n) for n in ('u', 'upstream.git', 'fork.git', 'personal')]
    os.makedirs(base)
    sh('git', 'clone', '--quiet', '--no-local', ROOT, u)
    git(u, 'checkout', '--quiet', '-B', 'main', 'v0.132.0')
    git(u, 'tag', '-f', 'v0.132.0', 'v0.132.0')
    sh('git', 'init', '--quiet', '--bare', fork)
    git(fork, 'config', 'receive.shallowUpdate', 'true')
    sh('git', 'clone', '--quiet', '--no-local', '--branch', 'personal', ROOT, p)
    git(p, 'remote', 'set-url', 'origin', fork)

    # Personal: the gate beside the job key, its own .yamllint and tooling.
    checks = os.path.join(p, '.github', 'workflows', 'checks.yml')
    text = open(checks).read()
    assert '  checks:\n' in text
    with open(checks, 'w') as f:
        f.write(text.replace('  checks:\n', "  checks:\n    if: github.repository == 'Biditmangal/glasshouse'\n", 1))
    with open(os.path.join(p, '.yamllint'), 'w') as f:
        f.write('extends: relaxed\n')
    os.makedirs(os.path.join(p, 'scripts', 'personal'), exist_ok=True)
    with open(os.path.join(p, 'scripts', 'personal', 'marker.txt'), 'w') as f:
        f.write('personal tooling\n')
    if app_conflict:
        with open(os.path.join(p, 'server', 'official-note.txt'), 'w') as f:
            f.write('personal version of the note\n')
    git(p, 'add', '-A')
    git(p, 'commit', '-q', '-m', 'Personal control plane')
    git(p, 'push', '--quiet', 'origin', 'personal')

    # Official: the same lines edited, a .yamllint and tooling of its own, an app file.
    checks_u = os.path.join(u, '.github', 'workflows', 'checks.yml')
    text = open(checks_u).read()
    with open(checks_u, 'w') as f:
        f.write(text.replace('  checks:\n', '  checks:\n    timeout-minutes: 45\n', 1))
    with open(os.path.join(u, '.yamllint'), 'w') as f:
        f.write('extends: default\n')
    os.makedirs(os.path.join(u, 'scripts', 'personal'), exist_ok=True)
    with open(os.path.join(u, 'scripts', 'personal', 'upstream-added.txt'), 'w') as f:
        f.write('not ours\n')
    with open(os.path.join(u, 'server', 'official-note.txt'), 'w') as f:
        f.write('official 0.133.0\n')
    bump(os.path.join(u, 'server', 'tvweb.js'), '0.132.0', '0.133.0')
    git(u, 'add', '-A')
    git(u, 'commit', '-q', '-m', 'Bump version to 0.133.0')
    git(u, 'tag', 'v0.133.0')
    sh('git', 'clone', '--quiet', '--bare', u, upstream)
    return p, upstream, base


def forge(p, work, upstream_sha, edit_path, text):
    """A candidate that looks like the merge (the planned tip and release as parents) but
    also changes a file the merge would not, as code run during the checks could write one."""
    plan_json = json.load(open(os.path.join(work, 'plan.json')))
    scratch = os.path.join(work, 'forge-' + hashlib.sha256(edit_path.encode()).hexdigest()[:8])
    git(p, 'worktree', 'add', '--detach', '--quiet', scratch, plan_json['candidate'])
    with open(os.path.join(scratch, edit_path), 'a') as f:
        f.write(text)
    git(scratch, 'add', '-A')
    tree = git(scratch, 'write-tree').stdout.strip()
    forged = git(p, 'commit-tree', tree, '-p', plan_json['personal_tip'], '-p', upstream_sha, '-m', 'forged').stdout.strip()
    digest = hashlib.sha256(f'glasshouse-personal-inputs-v1\nupstream={upstream_sha}\ntree={tree}\n'.encode()).hexdigest()
    forged_work = work + '-forged-' + os.path.basename(scratch)
    os.makedirs(forged_work)
    with open(os.path.join(forged_work, 'plan.json'), 'w') as f:
        json.dump(dict(plan_json, candidate=forged, tree=tree, inputs_hash=digest), f)
    return forged_work


def control_plane(tmp):
    # A conflict only in the control plane keeps the personal branch's files.
    p, upstream, base = make_world(tmp, 'ctl', app_conflict=False)
    w = os.path.join(base, 'w')
    # The setup is a real conflict: a plain merge stops on the workflow file.
    probe = os.path.join(base, 'probe')
    git(p, 'fetch', '--quiet', upstream, 'refs/tags/v0.133.0')
    release_sha = git(p, 'rev-parse', 'FETCH_HEAD').stdout.strip()
    git(p, 'worktree', 'add', '--detach', '--quiet', probe, 'HEAD')
    merged = git(probe, 'merge', '--no-commit', release_sha, ok=False)
    unmerged = git(probe, 'diff', '--name-only', '--diff-filter=U').stdout.split()
    check(merged.returncode != 0 and '.github/workflows/checks.yml' in unmerged and '.yamllint' in unmerged,
          'a plain merge of the release conflicts in .github and .yamllint')
    git(probe, 'merge', '--abort')
    r = plan(p, upstream, w)
    check(r['action'] == 'build' and r['mode'] == 'merge', 'conflicts only in .github, .yamllint and scripts/personal: the merge goes ahead')
    cand, tip = r['candidate'], r['personal_tip']
    for path in ('.github', '.yamllint', 'scripts/personal'):
        check(git(p, 'rev-parse', f'{cand}:{path}').stdout == git(p, 'rev-parse', f'{tip}:{path}').stdout,
              f'{path} in the candidate is exactly the personal branch\'s')
    check(git(p, 'cat-file', '-e', cand + ':server/official-note.txt', ok=False).returncode == 0, 'the official app change arrived')
    out_dir = os.path.join(base, 'out')
    tool(p, w, 'build', '--repo', p, '--work', w, '--out', out_dir)
    tool(p, w, 'verify', '--repo', p, '--dir', out_dir, '--upstream-url', upstream)
    check(True, 'the genuine merge verifies by being made again from the two commits')

    # A candidate with anything the merge would not give is refused, in the control
    # plane or outside it.
    for edit, why in (('scripts/personal/personal_release_forged.py', 'a control plane file'),
                      ('server/lib/util.js', 'application code')):
        up_sha = r['upstream_sha']
        forged_work = forge(p, w, up_sha, edit, '# forged\n')
        forged_out = os.path.join(base, 'forged-out')
        shutil.rmtree(forged_out, ignore_errors=True)
        tool(p, forged_work, 'build', '--repo', p, '--work', forged_work, '--out', forged_out)
        run = sh(sys.executable, TOOL, 'verify', '--repo', p, '--dir', forged_out, '--upstream-url', upstream, ok=False)
        check(run.returncode == 2 and ('control plane' in run.stderr or 'merging the release' in run.stderr),
              f'a candidate with {why} forged in is refused by verify ({run.stderr.strip()[:70]})')

    # A conflict in anything else stops the run, even beside control plane ones.
    p2, upstream2, base2 = make_world(tmp, 'mixed', app_conflict=True)
    run = sh(sys.executable, TOOL, 'plan', '--repo', p2, '--work', os.path.join(base2, 'w'), '--upstream-tag', 'v0.133.0',
             '--upstream-url', upstream2, '--event', 'schedule', ok=False)
    check(run.returncode == 20 and 'official-note.txt' in run.stderr and 'checks.yml' not in run.stderr,
          'a mixed conflict stops (exit 20) and names only the application file')
    check(not os.path.exists(os.path.join(base2, 'w', 'plan.json')), 'and builds nothing')


main()
