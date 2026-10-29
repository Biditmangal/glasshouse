#!/usr/bin/env python3
"""
The personal fork's release tooling: pick the official release to follow, plan
and stage a candidate, build the server bundle the personal update channel
installs, and verify it.

Standard library and git only. The workflow runs this from the personal
branch's own checkout, never from a candidate tree, so the job that holds a
write token does not run code a merged release brought in.

    resolve          print the newest official release tag (GitHub API, read only)
    plan             decide what a run does; stage the candidate commit
    build            stamp the candidate, build the bundle, manifest and sums
    bundle           build the bundle from a server directory (no git)
    verify           check a built bundle against its manifest and the commits,
                     and that the candidate is nothing but the genuine merge
    preflight        before publishing: the fork's branch and names are as planned
    verify-assets    check a directory of downloaded assets against SHA256SUMS

Exit codes: 0 done (plan.json says whether there is work), 20 merge conflict,
30 a publication was interrupted and needs a person, 2 anything else.
docs/personal-fork.md describes the whole arrangement.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

UPSTREAM_URL = 'https://github.com/rorygallagher2024/glasshouse.git'
UPSTREAM_API = 'https://api.github.com/repos/rorygallagher2024/glasshouse/releases?per_page=30'

TAG_RE = re.compile(r'^v(\d{1,4})\.(\d{1,4})\.(\d{1,4})$')
BUILD_RE = re.compile(r'^v(\d{1,4}\.\d{1,4}\.\d{1,4})-personal\.(\d{1,6})$')
SHA_RE = re.compile(r'^[0-9a-f]{40}$')
SHA256_RE = re.compile(r'^[0-9a-f]{64}$')
BASE_RE = re.compile(r'^\d{1,4}\.\d{1,4}\.\d{1,4}$')
# The same shape lib/personal.js accepts for a name inside the server directory.
REL_RE = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9._-]*(/[A-Za-z0-9_][A-Za-z0-9._-]*)*$')
VERSION_LINE = re.compile(r"^var TVWEB_VERSION = '([^']+)';", re.M)

BUNDLE_TOP = 'glasshouse-personal'
MANIFEST_NAME = 'glasshouse-personal.manifest.json'
MAX_BUNDLE_BYTES = 16 * 1024 * 1024
EXECUTABLE = re.compile(r'(\.sh$|(^|/)tvwebctl$)')
# The control plane: what the release runs on and with. The personal branch's
# own copy always wins over whatever an official release brings, in the merge
# and in the check that the merge was nothing more.
CONTROL_PLANE = ('.github', 'scripts/personal', '.yamllint')
STAMP_AUTHOR = ['-c', 'user.name=glasshouse-personal[bot]',
                '-c', 'user.email=glasshouse-personal@users.noreply.github.com']

EXIT_CONFLICT = 20
EXIT_INTERRUPTED = 30


class Fail(Exception):
    def __init__(self, message, code=2):
        Exception.__init__(self, message)
        self.code = code


def git(*args, cwd=None, check=True, binary=False):
    run = subprocess.run(['git'] + list(args), cwd=cwd, capture_output=True, text=not binary)
    if check and run.returncode != 0:
        err = run.stderr if not binary else run.stderr.decode(errors='replace')
        raise Fail(f"git {' '.join(args[:3])} failed: {err.strip()}")
    return run


def out(*args, cwd=None):
    return git(*args, cwd=cwd).stdout.strip()


def sha256_of(data):
    return hashlib.sha256(data).hexdigest()


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def version_tuple(v):
    return tuple(int(x) for x in v.split('.'))


def declared_version(text):
    m = VERSION_LINE.search(text)
    if not m:
        raise Fail('no TVWEB_VERSION in tvweb.js')
    return m.group(1)


def version_at(repo, rev):
    return declared_version(out('show', f'{rev}:server/tvweb.js', cwd=repo))


def bundle_name(base, rev):
    return f'glasshouse-personal-{base}-p{rev}.tar.gz'


def inputs_hash(upstream_sha, tree):
    """What a build is a function of: the official release and the candidate's
    content tree. Not a commit id: a merge advancing the branch changes those."""
    return sha256_of((f'glasshouse-personal-inputs-v1\nupstream={upstream_sha}\ntree={tree}\n').encode())


# ---------------------------------------------------------------- resolve

def cmd_resolve(args):
    req = urllib.request.Request(UPSTREAM_API, headers={'Accept': 'application/vnd.github+json',
                                                         'User-Agent': 'glasshouse-personal-release'})
    token = os.environ.get('GH_TOKEN')
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    with urllib.request.urlopen(req, timeout=30) as r:
        releases = json.loads(r.read().decode())
    best = None
    for rel in releases:
        tag = str(rel.get('tag_name', ''))
        m = TAG_RE.fullmatch(tag)
        if not m or rel.get('draft') or rel.get('prerelease'):
            continue
        key = tuple(int(x) for x in m.groups())
        if best is None or key > best[0]:
            best = (key, tag)
    if not best:
        raise Fail('the official repository lists no release')
    print(best[1])
    return 0


# ---------------------------------------------------------------- plan

def fork_history(repo, fork):
    """What the fork already holds: {build name: {'hash', 'published'}} and the
    highest revision seen in any build branch or tag. A build branch is written
    once, per release; its tag exists only once the release was published."""
    refs = out('ls-remote', fork, 'refs/heads/build/*', 'refs/tags/*', cwd=repo)
    builds, tags, top = set(), set(), 0
    for line in refs.splitlines():
        _, ref = line.split('\t')
        if ref.startswith('refs/heads/build/'):
            name = ref[len('refs/heads/build/'):]
            if BUILD_RE.fullmatch(name):
                builds.add(name)
        elif ref.startswith('refs/tags/'):
            name = ref[len('refs/tags/'):].replace('^{}', '')
            if BUILD_RE.fullmatch(name):
                tags.add(name)
    for name in builds | tags:
        found_rev = BUILD_RE.fullmatch(name)
        if found_rev:
            top = max(top, int(found_rev.group(2)))
    found = {}
    if builds:
        git('fetch', '--no-tags', '--quiet', fork, '+refs/heads/build/*:refs/personal/builds/*', cwd=repo)
    for name in builds:
        run = git('show', f'refs/personal/builds/{name}:server/personal.json', cwd=repo, check=False)
        try:
            stamp = json.loads(run.stdout)
        except ValueError:
            stamp = {}
        found[name] = {'hash': stamp.get('inputs_hash'), 'published': name in tags}
    return found, top


def in_control_plane(path):
    return any(path == root or path.startswith(root + '/') for root in CONTROL_PLANE)


def merge_in_worktree(repo, work, tip, upstream_sha, tag):
    """Merge the official release into the tip in a detached worktree, leaving the
    result in its index, uncommitted. A conflict only in the control plane is
    settled by keeping the tip's files, as the pin would anyway; a conflict
    anywhere else, mixed with those or not, stops the run."""
    git('worktree', 'add', '--detach', '--quiet', work, tip, cwd=repo)
    merge = git('merge', '--no-ff', '--no-commit', '--quiet', upstream_sha, cwd=work, check=False)
    if merge.returncode != 0:
        conflicted = out('diff', '--name-only', '--diff-filter=U', cwd=work).splitlines()
        content = [path for path in conflicted if not in_control_plane(path)]
        if not conflicted or content:
            git('merge', '--abort', cwd=work, check=False)
            if not conflicted:
                raise Fail(f'merging {tag} failed without a conflict: {(merge.stderr or merge.stdout).strip()}')
            raise Fail(f"merging {tag} conflicts in: {', '.join(content)}. Nothing was pushed or built; "
                       'resolve it on a branch of the fork by hand.', EXIT_CONFLICT)
    for root in CONTROL_PLANE:
        git('rm', '-r', '-f', '-q', '--ignore-unmatch', '--', root, cwd=work)
        if git('cat-file', '-e', f'{tip}:{root}', cwd=repo, check=False).returncode == 0:
            git('checkout', tip, '--', root, cwd=work)


def stage_candidate(repo, work, tip, upstream_sha, tag):
    """The merge commit, in a detached worktree."""
    merge_in_worktree(repo, work, tip, upstream_sha, tag)
    git(*(STAMP_AUTHOR + ['commit', '--quiet', '-m', f'Merge official release {tag} into personal']), cwd=work)
    return out('rev-parse', 'HEAD', cwd=work)


def expected_merge_tree(repo, tip, upstream_sha):
    """The tree a genuine merge of the release into the tip has, made again from
    the commits alone, so a candidate cannot carry anything the merge would not."""
    work = tempfile.mkdtemp(prefix='personal-expected-')
    try:
        shutil.rmtree(work)
        merge_in_worktree(repo, work, tip, upstream_sha, 'the release')
        return out('write-tree', cwd=work)
    finally:
        git('worktree', 'remove', '--force', work, cwd=repo, check=False)
        shutil.rmtree(work, ignore_errors=True)


def finish(args, plan):
    os.makedirs(args.work, exist_ok=True)
    with open(os.path.join(args.work, 'plan.json'), 'w') as f:
        json.dump(plan, f, indent=2, sort_keys=True)
    print(json.dumps(plan, indent=2, sort_keys=True))
    gh_out = os.environ.get('GITHUB_OUTPUT')
    if gh_out:
        with open(gh_out, 'a') as f:
            f.write(f"action={plan['action']}\npublish={'true' if plan.get('publish') else 'false'}\n")
    return 0


def cmd_plan(args):
    repo = os.path.abspath(args.repo)
    tag = args.upstream_tag
    if not TAG_RE.fullmatch(tag):
        raise Fail(f'not a release tag: {tag!r}')
    # Before anything can end the run quietly: a build branch with no tag is a
    # publication that stopped part way, however long ago, and a person has to
    # settle it. The fork must be public, as the TV downloads from it anyway.
    history, top = fork_history(repo, args.fork)
    orphans = sorted(name for name, info in history.items() if not info['published'])
    if orphans:
        raise Fail(f"publication of {', '.join(orphans)} was interrupted: the build branch exists but no tag does. "
                   'Open the draft release for it. Either publish it by hand after checking its assets, or delete '
                   'the draft release and the branch build/<tag>, then run this again. A release that was '
                   'published is never touched.', EXIT_INTERRUPTED)
    git('fetch', '--no-tags', '--quiet', args.upstream_url, '+refs/heads/main:refs/personal/upstream-main',
        f'+refs/tags/{tag}:refs/personal/upstream-release', cwd=repo)
    upstream_sha = out('rev-parse', 'refs/personal/upstream-release^{commit}', cwd=repo)
    if git('merge-base', '--is-ancestor', upstream_sha, 'refs/personal/upstream-main', cwd=repo, check=False).returncode != 0:
        raise Fail(f'{tag} is not on the official main branch')
    base = tag[1:]
    if version_at(repo, upstream_sha) != base:
        raise Fail(f'{tag} declares another version in server/tvweb.js')

    tip = out('rev-parse', args.tip, cwd=repo)
    if git('cat-file', '-e', f'{tip}:server/personal.json', cwd=repo, check=False).returncode == 0:
        raise Fail('the personal branch holds a server/personal.json; only a stamped build branch may')
    tip_version = version_at(repo, tip)
    plan = {'upstream_tag': tag, 'upstream_sha': upstream_sha, 'personal_tip': tip, 'base': base}
    if version_tuple(base) < version_tuple(tip_version):
        return finish(args, dict(plan, action='noop', reason=f'{tag} is older than the {tip_version} already merged'))

    patch_only = git('merge-base', '--is-ancestor', upstream_sha, tip, cwd=repo, check=False).returncode == 0
    plan['mode'] = 'patch-only' if patch_only else 'merge'
    if args.event == 'schedule' and patch_only:
        return finish(args, dict(plan, action='noop', reason='no new official release; a patch-only build needs a manual run'))

    if patch_only:
        candidate = tip
    else:
        work = os.path.join(os.path.abspath(args.work), 'candidate')
        candidate = stage_candidate(repo, work, tip, upstream_sha, tag)
        plan['candidate_dir'] = work
    tree = out('rev-parse', f'{candidate}^{{tree}}', cwd=repo)
    digest = inputs_hash(upstream_sha, tree)
    plan.update(candidate=candidate, tree=tree, inputs_hash=digest)
    if version_at(repo, candidate) != base:
        raise Fail(f'the candidate declares another version than {tag}')

    for name, info in sorted(history.items()):
        if info['hash'] == digest:
            return finish(args, dict(plan, action='noop', reason=f'identical inputs are already released as {name}'))
    rev = top + 1
    plan.update(rev=rev, release_tag=f'v{base}-personal.{rev}')
    publish = ((args.event == 'schedule' and not patch_only) or
               (args.event == 'workflow_dispatch' and args.publish_requested == 'true'))
    return finish(args, dict(plan, action='build', publish=publish,
                             reason='patch-only rebuild, run by hand' if patch_only else f'new official release {tag}'))


# ---------------------------------------------------------------- bundle

def deploy_files(server):
    src = open(os.path.join(server, 'deploy.sh'), encoding='utf-8').read()
    m = re.search(r'^FILES="(.*?)"', src, re.M | re.S)
    if not m:
        raise Fail('no FILES list in server/deploy.sh')
    return m.group(1).replace('\\\n', ' ').split()


def bundle_members(server):
    names = deploy_files(server) + ['50-tvweb.sh', 'personal.json']
    if len(set(names)) != len(names):
        raise Fail('a file is listed twice')
    for rel in names:
        if not REL_RE.fullmatch(rel):
            raise Fail(f'unsafe file name {rel!r}')
        path = os.path.join(server, rel)
        if os.path.islink(path) or not os.path.isfile(path):
            raise Fail(f'{rel} is not a plain file')
    return sorted(names)


def make_tarball(server, names, epoch):
    """Reproducible: sorted, root-owned, one fixed time, no gzip timestamp."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w', format=tarfile.GNU_FORMAT) as tar:
        dirs = {BUNDLE_TOP}
        for rel in names:
            parts = rel.split('/')[:-1]
            for i in range(1, len(parts) + 1):
                dirs.add(BUNDLE_TOP + '/' + '/'.join(parts[:i]))
        for d in sorted(dirs):
            info = tarfile.TarInfo(d)
            info.type, info.mode, info.mtime = tarfile.DIRTYPE, 0o755, epoch
            tar.addfile(info)
        for rel in names:
            with open(os.path.join(server, rel), 'rb') as f:
                data = f.read()
            info = tarfile.TarInfo(f'{BUNDLE_TOP}/{rel}')
            info.size, info.mtime = len(data), epoch
            info.mode = 0o755 if EXECUTABLE.search(rel) else 0o644
            tar.addfile(info, io.BytesIO(data))
    zipped = io.BytesIO()
    with gzip.GzipFile(fileobj=zipped, mode='wb', mtime=0, compresslevel=9) as z:
        z.write(raw.getvalue())
    return zipped.getvalue()


def write_assets(server, identity, outdir, epoch):
    """The bundle, its manifest and the sums, written to outdir. server/ already
    holds the personal.json that `identity` is."""
    data = make_tarball(server, bundle_members(server), epoch)
    if len(data) > MAX_BUNDLE_BYTES:
        raise Fail('the bundle is larger than the updater accepts')
    name = bundle_name(identity['base'], identity['rev'])
    manifest = {'channel': 'personal', 'base': identity['base'], 'rev': identity['rev'],
                'commit': identity['commit'], 'file': name, 'sha256': sha256_of(data), 'size': len(data)}
    manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode()
    os.makedirs(outdir, exist_ok=True)
    for fname, blob in ((name, data), (MANIFEST_NAME, manifest_bytes)):
        with open(os.path.join(outdir, fname), 'wb') as f:
            f.write(blob)
    with open(os.path.join(outdir, 'SHA256SUMS'), 'w') as f:
        f.write(f"{manifest['sha256']}  {name}\n{sha256_of(manifest_bytes)}  {MANIFEST_NAME}\n")
    return manifest


def write_identity(server, identity):
    with open(os.path.join(server, 'personal.json'), 'w') as f:
        json.dump(identity, f, indent=2, sort_keys=True)
        f.write('\n')


def cmd_bundle(args):
    """A bundle straight from a server directory, for checking the packaging
    without making commits. Never publishes anything."""
    identity = json.loads(args.identity)
    server = os.path.abspath(args.server)
    if os.path.exists(os.path.join(server, 'personal.json')):
        raise Fail(f'{server} already has a personal.json')
    write_identity(server, identity)
    try:
        manifest = write_assets(server, identity, args.out, int(args.epoch))
    finally:
        os.unlink(os.path.join(server, 'personal.json'))
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


def cmd_build(args):
    with open(os.path.join(args.work, 'plan.json')) as f:
        plan = json.load(f)
    if plan.get('action') != 'build':
        raise Fail('the plan has nothing to build')
    repo = os.path.abspath(args.repo)
    cand = plan['candidate']
    work = os.path.join(os.path.abspath(args.work), 'stamp')
    git('worktree', 'add', '--detach', '--quiet', work, cand, cwd=repo)
    identity = {'channel': 'personal', 'base': plan['base'], 'rev': plan['rev'], 'commit': cand,
                'upstream_tag': plan['upstream_tag'], 'upstream_sha': plan['upstream_sha'],
                'inputs_hash': plan['inputs_hash']}
    # Only a run on GitHub vouches for a build; a build made anywhere else
    # carries no such claim.
    if os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_RUN_ID', '').isdigit():
        identity['built_by'] = 'github-actions:' + os.environ['GITHUB_RUN_ID']
    server = os.path.join(work, 'server')
    write_identity(server, identity)
    git('add', '-f', 'server/personal.json', cwd=work)
    git(*(STAMP_AUTHOR + ['commit', '--quiet', '-m', f"Stamp personal release {plan['release_tag']}"]), cwd=work)
    stamp = out('rev-parse', 'HEAD', cwd=work)
    epoch = int(out('show', '-s', '--format=%ct', cand, cwd=repo))
    manifest = write_assets(server, identity, args.out, epoch)
    git('update-ref', 'refs/personal/stamp', stamp, cwd=repo)
    git('bundle', 'create', '--quiet', os.path.join(args.out, 'candidate.bundle'), 'refs/personal/stamp',
        '^' + plan['personal_tip'], '^' + plan['upstream_sha'], cwd=repo)
    release = dict(plan, stamp=stamp, manifest=manifest)
    release.pop('candidate_dir', None)
    with open(os.path.join(args.out, 'release.json'), 'w') as f:
        json.dump(release, f, indent=2, sort_keys=True)
    print(json.dumps(release, indent=2, sort_keys=True))
    return 0


# ---------------------------------------------------------------- verify

def read_sums(directory):
    sums = {}
    with open(os.path.join(directory, 'SHA256SUMS')) as f:
        for line in f.read().splitlines():
            m = re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9._+-]+)', line)
            if not m:
                raise Fail(f'unreadable SHA256SUMS line: {line!r}')
            sums[m.group(2)] = m.group(1)
    return sums


def cmd_verify_assets(args):
    sums = read_sums(args.dir)
    for name, digest in sums.items():
        if file_sha256(os.path.join(args.dir, name)) != digest:
            raise Fail(f'{name} does not match SHA256SUMS')
    print(f'verified {len(sums)} assets')
    return 0


def check_bundle(directory):
    """Open the bundle as the TV would and hold it to its manifest. Returns
    {'manifest', 'identity', 'files': {relative name: bytes}}."""
    with open(os.path.join(directory, MANIFEST_NAME)) as f:
        manifest = json.load(f)
    base, rev = manifest.get('base'), manifest.get('rev')
    if manifest.get('channel') != 'personal' or not isinstance(rev, int) or rev < 1 or rev > 999999:
        raise Fail('the manifest is not a personal release')
    if not isinstance(base, str) or not BASE_RE.fullmatch(base) or not SHA_RE.fullmatch(str(manifest.get('commit'))):
        raise Fail('the manifest names a bad base or commit')
    if manifest.get('file') != bundle_name(base, rev) or not SHA256_RE.fullmatch(str(manifest.get('sha256'))):
        raise Fail('the manifest names an unexpected file or hash')
    path = os.path.join(directory, manifest['file'])
    size = manifest.get('size')
    if os.path.getsize(path) != size or size > MAX_BUNDLE_BYTES:
        raise Fail('the bundle is not the size the manifest names')
    if file_sha256(path) != manifest['sha256']:
        raise Fail('the bundle does not match the manifest hash')
    files = {}
    with tarfile.open(path, 'r:gz') as tar:
        for member in tar.getmembers():
            name = member.name
            if name != BUNDLE_TOP and not name.startswith(BUNDLE_TOP + '/'):
                raise Fail(f'{name} is outside the bundle directory')
            if member.isdir():
                continue
            rel = name[len(BUNDLE_TOP) + 1:]
            if not member.isreg() or not REL_RE.fullmatch(rel) or member.uid or member.gid:
                raise Fail(f'{name} is not an acceptable bundle member')
            handle = tar.extractfile(member)
            if handle is None:
                raise Fail(f'{name} cannot be read')
            files[rel] = handle.read()
    if 'personal.json' not in files or 'tvweb.js' not in files:
        raise Fail('the bundle lacks tvweb.js or its identity file')
    identity = json.loads(files['personal.json'])
    wanted = {k: manifest[k] for k in ('base', 'rev', 'commit')}
    if identity.get('channel') != 'personal' or {k: identity.get(k) for k in wanted} != wanted:
        raise Fail('personal.json in the bundle disagrees with the manifest')
    if declared_version(files['tvweb.js'].decode()) != base:
        raise Fail('tvweb.js in the bundle declares another version than the manifest')
    return {'manifest': manifest, 'identity': identity, 'files': files}


def cmd_verify(args):
    art = os.path.abspath(args.dir)
    repo = os.path.abspath(args.repo)
    with open(os.path.join(art, 'release.json')) as f:
        release = json.load(f)
    cmd_verify_assets(argparse.Namespace(dir=art))
    opened = check_bundle(art)
    identity = opened['identity']
    if set(read_sums(art)) != {release['manifest']['file'], MANIFEST_NAME}:
        raise Fail('SHA256SUMS lists unexpected files')
    if opened['manifest'] != release['manifest']:
        raise Fail('release.json and the manifest disagree')
    tag = release['release_tag']
    m = BUILD_RE.fullmatch(tag)
    if not m or m.group(1) != identity['base'] or int(m.group(2)) != identity['rev']:
        raise Fail('the tag does not match the bundle identity')
    if not TAG_RE.fullmatch(release['upstream_tag']) or not SHA_RE.fullmatch(release['upstream_sha']):
        raise Fail('bad upstream reference')

    # The official release is looked up again here, not taken from the artifact.
    git('fetch', '--no-tags', '--quiet', args.upstream_url, '+refs/heads/main:refs/personal/upstream-main',
        f"+refs/tags/{release['upstream_tag']}:refs/personal/verify-upstream-release", cwd=repo)
    if out('rev-parse', 'refs/personal/verify-upstream-release^{commit}', cwd=repo) != release['upstream_sha']:
        raise Fail('the official release tag does not name the commit the build was made from')
    if git('merge-base', '--is-ancestor', release['upstream_sha'], 'refs/personal/upstream-main', cwd=repo, check=False).returncode != 0:
        raise Fail('the official release is not on the official main branch')

    # The commits: the stamp arrives in a git bundle; check its shape.
    git('fetch', '--quiet', '--no-tags', os.path.join(art, 'candidate.bundle'),
        '+refs/personal/stamp:refs/personal/verify-stamp', cwd=repo)
    stamp = out('rev-parse', 'refs/personal/verify-stamp', cwd=repo)
    if stamp != release['stamp']:
        raise Fail('the bundle carries another commit than release.json names')
    cand = identity['commit']
    if out('rev-list', '--parents', '-n1', stamp, cwd=repo).split() != [stamp, cand]:
        raise Fail('the stamp commit is not a single child of the candidate')
    if out('diff', '--name-status', cand, stamp, cwd=repo) != 'A\tserver/personal.json':
        raise Fail('the stamp commit changes more than server/personal.json')
    tip = out('rev-parse', args.tip, cwd=repo)
    if tip != release['personal_tip']:
        raise Fail('the personal branch has moved since this build was planned')
    if cand != tip and out('rev-list', '--parents', '-n1', cand, cwd=repo).split()[1:] != [tip, release['upstream_sha']]:
        raise Fail('the candidate is not a merge of the planned tip and release')
    if out('diff', '--name-only', tip, cand, '--', *CONTROL_PLANE, cwd=repo):
        raise Fail('the candidate changes the control plane (' + ', '.join(CONTROL_PLANE) + ')')
    # Nothing but a genuine merge: the merge is made again from the two commits
    # (this job runs git only, never the candidate's code) and must give the
    # candidate's tree exactly.
    if cand != tip and expected_merge_tree(repo, tip, release['upstream_sha']) != out('rev-parse', cand + '^{tree}', cwd=repo):
        raise Fail('the candidate is not what merging the release into the planned tip gives')
    if inputs_hash(release['upstream_sha'], out('rev-parse', cand + '^{tree}', cwd=repo)) != identity['inputs_hash']:
        raise Fail('the inputs hash does not match the candidate content')
    # The assets are the files of that commit, byte for byte.
    for rel, data in sorted(opened['files'].items()):
        blob = git('show', f'{stamp}:server/{rel}', cwd=repo, check=False, binary=True)
        if blob.returncode != 0 or blob.stdout != data:
            raise Fail(f'{rel} in the bundle is not the file in commit {stamp[:7]}')
    print(f"verified {tag}: {len(opened['files'])} files, stamp {stamp[:7]}")
    return 0


def cmd_preflight(args):
    """Before the first ref or draft is made: the fork's personal branch is where the
    run planned it (not merely where this checkout is), and nothing is named
    for this release yet."""
    if not BUILD_RE.fullmatch(args.tag) or not SHA_RE.fullmatch(args.tip):
        raise Fail('bad tag or tip')
    repo = os.path.abspath(args.repo)
    remote_tip = out('ls-remote', args.remote, 'refs/heads/personal', cwd=repo).split('\t')[0]
    if remote_tip != args.tip:
        raise Fail(f"the personal branch is at {remote_tip[:7] or 'nothing'} in the fork, not {args.tip[:7]} where this run planned it; "
                   'run again so the build is made from the branch as it is')
    taken = out('ls-remote', args.remote, f'refs/heads/build/{args.tag}', f'refs/tags/{args.tag}', cwd=repo)
    if taken:
        raise Fail(f'{args.tag} already exists in the fork')
    print(f'ready to publish {args.tag}')
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    sub.add_parser('resolve').set_defaults(fn=cmd_resolve)

    s = sub.add_parser('plan')
    s.add_argument('--repo', default='.')
    s.add_argument('--work', required=True)
    s.add_argument('--tip', default='HEAD')
    s.add_argument('--upstream-tag', required=True)
    s.add_argument('--upstream-url', default=UPSTREAM_URL)
    s.add_argument('--fork', default='origin')
    s.add_argument('--event', choices=['schedule', 'workflow_dispatch'], required=True)
    s.add_argument('--publish-requested', choices=['true', 'false'], default='false')
    s.set_defaults(fn=cmd_plan)

    s = sub.add_parser('build')
    s.add_argument('--repo', default='.')
    s.add_argument('--work', required=True)
    s.add_argument('--out', required=True)
    s.set_defaults(fn=cmd_build)

    s = sub.add_parser('bundle')
    s.add_argument('--server', required=True)
    s.add_argument('--identity', required=True)
    s.add_argument('--epoch', default='0')
    s.add_argument('--out', required=True)
    s.set_defaults(fn=cmd_bundle)

    s = sub.add_parser('verify')
    s.add_argument('--repo', default='.')
    s.add_argument('--dir', required=True)
    s.add_argument('--tip', default='HEAD')
    s.add_argument('--upstream-url', default=UPSTREAM_URL)
    s.set_defaults(fn=cmd_verify)

    s = sub.add_parser('preflight')
    s.add_argument('--repo', default='.')
    s.add_argument('--remote', default='origin')
    s.add_argument('--tag', required=True)
    s.add_argument('--tip', required=True)
    s.set_defaults(fn=cmd_preflight)

    s = sub.add_parser('verify-assets')
    s.add_argument('--dir', required=True)
    s.set_defaults(fn=cmd_verify_assets)

    args = p.parse_args()
    try:
        return args.fn(args)
    except Fail as e:
        print(('::error::' if os.environ.get('GITHUB_ACTIONS') else 'error: ') + str(e), file=sys.stderr)
        return e.code


if __name__ == '__main__':
    sys.exit(main())
