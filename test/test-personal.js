/**
 * test/test-personal.js - The personal release channel, on real files.
 *
 * Builds the real bundle from server/ with scripts/personal/personal_release.py
 * (python3 and tar needed), opens it with the system tar the way the TV does,
 * and runs the updater's file work on temporary install directories: arriving,
 * rolling back, an official release taking over, and a failure part way.
 * Nothing here talks to the network or to a TV.
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var personal = require('../server/lib/personal');
var updater = require('../server/lib/updater');
var hashFile = require('../server/lib/installer').hashFile;

console.log('Running test-personal.js ...');

var ROOT = path.resolve(__dirname, '..');
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-test-'));

function run(cmd, args, opts) {
  return cp.execFileSync(cmd, args, opts || {}).toString();
}

var commit = run('git', ['-C', ROOT, 'rev-parse', 'HEAD']).trim();
var base = /^var TVWEB_VERSION = '([^']+)';/m.exec(fs.readFileSync(path.join(ROOT, 'server/tvweb.js'), 'utf8'))[1];

function buildBundle(rev, dir) {
  var identity = { channel: 'personal', base: base, rev: rev, commit: commit };
  run('python3', [path.join(ROOT, 'scripts/personal/personal_release.py'), 'bundle',
                  '--server', path.join(ROOT, 'server'), '--identity', JSON.stringify(identity), '--out', dir]);
  return identity;
}

function unpack(dir, file) {
  var dest = path.join(dir, 'x');
  fs.mkdirSync(dest);
  run('tar', ['-xf', path.join(dir, file), '-C', dest]);
  return dest;
}

// The bundle, as the TV is given it.
var out1 = path.join(tmp, 'out1');
buildBundle(1, out1);
var manifestText = fs.readFileSync(path.join(out1, 'glasshouse-personal.manifest.json'), 'utf8');
var parsed = personal.parseManifest(manifestText);

(function testManifestAndHash(done) {
  assert.ok(parsed.manifest, parsed.error);
  var man = parsed.manifest;
  assert.strictEqual(man.file, personal.bundleName(base, 1));
  assert.strictEqual(fs.statSync(path.join(out1, man.file)).size, man.size);
  hashFile(path.join(out1, man.file), function (err, digest) {
    assert.ifError(err);
    assert.strictEqual(digest, man.sha256);
    console.log('  \u2713 manifest names the bundle, its size and its sha256');
    done();
  });
})(function () {
  // Opened as the TV does: gunzip, then the system tar lists and unpacks.
  var gz = path.join(out1, parsed.manifest.file);
  var tarFile = path.join(tmp, 'bundle.tar');
  fs.writeFileSync(tarFile, require('zlib').gunzipSync(fs.readFileSync(gz)));
  var names = run('tar', ['-tf', tarFile]).split('\n').filter(Boolean);
  var detail = run('tar', ['-tvf', tarFile]).split('\n').filter(Boolean);
  assert.strictEqual(personal.checkListing(names), null);
  assert.strictEqual(personal.checkTypes(detail, names.length), null);
  var stage = path.join(tmp, 'stage1');
  fs.mkdirSync(stage);
  run('tar', ['-xf', tarFile, '-C', stage]);
  var walked = personal.walkBundle(path.join(stage, personal.BUNDLE_TOP));
  assert.ok(walked.files, walked.error);
  assert.ok(walked.files.indexOf('tvweb.js') !== -1 && walked.files.indexOf('personal.json') !== -1);
  assert.ok(walked.files.indexOf('lib/personal.js') !== -1, 'deploy.sh FILES carries the personal module');
  assert.ok(walked.files.indexOf('config.json') === -1, 'no config in the bundle');
  var identity = personal.validIdentity(JSON.parse(fs.readFileSync(path.join(stage, personal.BUNDLE_TOP, 'personal.json'), 'utf8')));
  assert.strictEqual(identity.rev, 1);
  console.log('  \u2713 the real bundle passes the listing, type and walk checks (' + walked.files.length + ' files)');

  // What the checks must refuse, made with the real tar.
  var evil = path.join(tmp, 'evil');
  fs.mkdirSync(path.join(evil, personal.BUNDLE_TOP), { recursive: true });
  fs.symlinkSync('/etc', path.join(evil, personal.BUNDLE_TOP, 'link'));
  fs.writeFileSync(path.join(evil, personal.BUNDLE_TOP, 'tvweb.js'), 'x');
  var evilTar = path.join(tmp, 'evil.tar');
  run('tar', ['-cf', evilTar, '-C', evil, personal.BUNDLE_TOP]);
  var evilNames = run('tar', ['-tf', evilTar]).split('\n').filter(Boolean);
  var evilDetail = run('tar', ['-tvf', evilTar]).split('\n').filter(Boolean);
  assert.strictEqual(personal.checkListing(evilNames), null, 'names alone look fine');
  assert.ok(personal.checkTypes(evilDetail, evilNames.length), 'a symlink entry is refused');
  var evilOut = path.join(tmp, 'evil-out');
  fs.mkdirSync(evilOut);
  run('tar', ['-xf', evilTar, '-C', evilOut]);
  assert.ok(personal.walkBundle(path.join(evilOut, personal.BUNDLE_TOP)).error, 'and so is the unpacked link');
  assert.ok(personal.checkListing(['glasshouse-personal/../etc/x']));
  assert.ok(personal.checkListing(['/etc/passwd']));
  assert.ok(personal.checkListing(['glasshouse-personal/.update/x']));
  assert.ok(personal.checkListing(['other/tvweb.js']));
  console.log('  \u2713 links, traversal, absolute and dotted names are refused');

  // The manifest is held to the strict shape.
  var good = JSON.parse(manifestText);
  function variant(change) { var m = JSON.parse(JSON.stringify(good)); change(m); return JSON.stringify(m); }
  [function (m) { m.file = '../x.tar.gz'; },
   function (m) { m.file = 'glasshouse-personal-' + base + '-p9.tar.gz'; },
   function (m) { m.sha256 = 'abc'; },
   function (m) { m.size = -1; },
   function (m) { m.size = 99999999; },
   function (m) { m.rev = 0; },
   function (m) { m.base = '0.132'; },
   function (m) { m.commit = 'HEAD'; },
   function (m) { m.channel = 'official'; }].forEach(function (change, i) {
    assert.ok(personal.parseManifest(variant(change)).error, 'manifest variant ' + i + ' is refused');
  });
  assert.ok(personal.parseManifest('not json').error);
  console.log('  \u2713 a manifest with a foreign name, hash, size, rev, base, commit or channel is refused');

  // Ordering of builds.
  assert.strictEqual(personal.newer({ base: '0.132.0', rev: 1 }, { base: '0.132.0', rev: 0 }), true);
  assert.strictEqual(personal.newer({ base: '0.132.0', rev: 1 }, { base: '0.132.0', rev: 1 }), false);
  assert.strictEqual(personal.newer({ base: '0.132.0', rev: 9 }, { base: '0.133.0', rev: 0 }), false);
  assert.strictEqual(personal.newer({ base: '0.133.0', rev: 1 }, { base: '0.132.0', rev: 7 }), true);
  console.log('  \u2713 newer compares the base, then the revision: no same-build loop, no going back a base');

  installTests(stage);
});

function copyTree(from, to) {
  run('cp', ['-R', from, to]);
}

function readIf(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function installTests(stage) {
  var bundleDir = path.join(stage, personal.BUNDLE_TOP);

  // An installed official build: the same files, one of them older, one missing.
  var inst = path.join(tmp, 'inst');
  copyTree(path.join(ROOT, 'server'), inst);
  fs.writeFileSync(path.join(inst, 'lib', 'util.js'), 'old util\n');
  fs.unlinkSync(path.join(inst, 'lib', 'personal.js'));
  fs.rmSync(path.join(inst, 'deploy.sh'));
  fs.writeFileSync(path.join(inst, 'config.json'), '{"secret":1}\n');
  var original = readIf(path.join(inst, 'tvweb.js'));

  updater.init({ config: { allowControl: true, update: { channel: 'personal' } }, version: base, installDir: inst });
  assert.strictEqual(updater.channel(), 'personal');
  assert.strictEqual(updater.installedId(), base, 'official until personal.json says otherwise');
  assert.strictEqual(updater.displayVersion(base, inst), base);

  var failed = null;
  var finished = null;
  updater.installFiles(bundleDir, true, function (why) { failed = why; }, function (n) { finished = n; });
  // installFiles finishes through a child process (rm of the old .previous).
  waitFor(function () { return failed || finished !== null; }, function () {
    assert.strictEqual(failed, null, failed);
    assert.ok(finished > 100);
    assert.strictEqual(readIf(path.join(inst, 'lib', 'util.js')), readIf(path.join(ROOT, 'server/lib/util.js')));
    assert.strictEqual(readIf(path.join(inst, 'config.json')), '{"secret":1}\n', 'config stays');
    assert.ok(fs.existsSync(path.join(inst, 'lib', 'personal.js')));
    assert.ok(!fs.existsSync(path.join(inst, 'deploy.sh')), 'deploy.sh is not installed over the TV');
    var identity = personal.readIdentity(inst, base);
    assert.strictEqual(identity.rev, 1);
    assert.strictEqual(updater.displayVersion(base, inst), base + '+personal.1.' + commit.slice(0, 7));
    var record = JSON.parse(fs.readFileSync(path.join(inst, '.previous', '.identity.json'), 'utf8'));
    assert.ok(record.added.indexOf('lib/personal.js') !== -1 && record.added.indexOf('personal.json') !== -1);
    assert.strictEqual(readIf(path.join(inst, '.previous', 'lib', 'util.js')), 'old util\n');
    console.log('  \u2713 a personal bundle lands over an official install: files, identity last, rollback copy and added list');

    // The installed name follows the files on disk, whichever channel is being
    // checked; Home Assistant is told the personal name only on the personal channel.
    updater.init({ config: { allowControl: true }, version: base, installDir: inst });
    assert.strictEqual(updater.channel(), 'official');
    assert.strictEqual(updater.installedId(), base + '+personal.1');
    assert.strictEqual(updater.updateSummary().installedId, base + '+personal.1');
    assert.strictEqual(updater.haInstalledId(), base);
    updater.init({ config: { allowControl: true, update: { channel: 'personal' } }, version: base, installDir: inst });
    assert.strictEqual(updater.installedId(), base + '+personal.1');
    assert.strictEqual(updater.haInstalledId(), base + '+personal.1');
    // A channel is not switched while a check is under way.
    updater.UPDATE.state = 'checking';
    updater.setChannel('official', function (r) {
      assert.strictEqual(r.ok, false);
      assert.ok(/check is running/.test(r.error), r.error);
    });
    updater.UPDATE.state = 'idle';
    console.log('  \u2713 installedId follows personal.json whatever the channel; Home Assistant has its own policy; no switch mid-check');

    // Roll back: old files return, what the update added goes, the identity with it.
    updater.init({ config: { allowControl: true }, version: base, installDir: inst });
    updater.rollbackUpdate(function (r) {
      assert.ok(r.ok, r.error);
      assert.strictEqual(r.restored, base, 'rolled back to the official build, not a personal one');
      assert.strictEqual(readIf(path.join(inst, 'lib', 'util.js')), 'old util\n');
      assert.ok(!fs.existsSync(path.join(inst, 'lib', 'personal.js')), 'an added file is removed');
      assert.ok(!fs.existsSync(path.join(inst, 'personal.json')), 'no personal identity left on official files');
      assert.strictEqual(readIf(path.join(inst, 'config.json')), '{"secret":1}\n');
      assert.strictEqual(updater.displayVersion(base, inst), base);
      console.log('  \u2713 rollback restores the files, removes added ones and the personal identity');
      officialTakesOver(stage, bundleDir, original);
    });
  });
}

function officialTakesOver(stage, bundleDir) {
  // personal.1 installed, then an official release (no personal.json) replaces it.
  var inst = path.join(tmp, 'inst2');
  copyTree(path.join(ROOT, 'server'), inst);
  fs.unlinkSync(path.join(inst, 'deploy.sh'));
  updater.init({ config: { allowControl: true }, version: base, installDir: inst });
  var step1 = null;
  updater.installFiles(bundleDir, true, function (why) { step1 = why; }, function () { step1 = 'ok'; });
  waitFor(function () { return step1; }, function () {
    assert.strictEqual(step1, 'ok');
    assert.ok(fs.existsSync(path.join(inst, 'personal.json')));
    var officialSrc = path.join(tmp, 'official-src');
    copyTree(path.join(ROOT, 'server'), officialSrc);
    var step2 = null;
    updater.installFiles(officialSrc, false, function (why) { step2 = why; }, function () { step2 = 'ok'; });
    waitFor(function () { return step2; }, function () {
      assert.strictEqual(step2, 'ok');
      assert.ok(!fs.existsSync(path.join(inst, 'personal.json')), 'an official install removes the personal identity');
      assert.ok(fs.existsSync(path.join(inst, '.previous', 'personal.json')), 'and keeps it for rollback');
      updater.rollbackUpdate(function (r) {
        assert.ok(r.ok, r.error);
        assert.strictEqual(r.restored, base + '+personal.1');
        assert.strictEqual(personal.readIdentity(inst, base).rev, 1, 'rolling back brings the personal identity back');
        console.log('  \u2713 an official install removes personal.json, and rollback brings the personal build back whole');
        failurePartWay(bundleDir);
      });
    });
  });
}

function failurePartWay(bundleDir) {
  // A path the bundle must write holds a directory: the install stops part way.
  var inst = path.join(tmp, 'inst3');
  copyTree(path.join(ROOT, 'server'), inst);
  fs.unlinkSync(path.join(inst, 'deploy.sh'));
  fs.writeFileSync(path.join(inst, 'lib', 'zzz-old.js'), 'kept\n');
  fs.writeFileSync(path.join(inst, 'lib', 'util.js'), 'old util\n');
  var blocked = path.join(inst, 'lib', 'telemetry.js');
  fs.unlinkSync(blocked);
  fs.mkdirSync(blocked);
  fs.writeFileSync(path.join(blocked, 'x'), 'x');
  updater.init({ config: { allowControl: true }, version: base, installDir: inst });
  var failed = null, finished = false;
  updater.installFiles(bundleDir, true, function (why) { failed = why; }, function () { finished = true; });
  waitFor(function () { return failed || finished; }, function () {
    assert.ok(failed, 'the install failed');
    assert.ok(!fs.existsSync(path.join(inst, 'personal.json')), 'no personal identity after a failed install');
    assert.strictEqual(readIf(path.join(inst, 'lib', 'util.js')), 'old util\n', 'files are as they were, whether or not they were replaced before the failure');
    assert.strictEqual(readIf(path.join(inst, 'lib', 'zzz-old.js')), 'kept\n');
    assert.ok(/was put back/.test(failed), failed);
    console.log('  \u2713 a failure part way puts the files back and leaves no personal identity');

    // A personal.json for another base claims nothing.
    var stale = path.join(tmp, 'inst4');
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, 'personal.json'), JSON.stringify({ channel: 'personal', base: '0.1.0', rev: 3, commit: commit }));
    assert.strictEqual(personal.readIdentity(stale, base), null);
    assert.strictEqual(updater.displayVersion(base, stale), base);
    console.log('  \u2713 a personal.json for another base is not believed');

    // The official channel is untouched without the setting.
    updater.init({ config: { update: { channel: 'bogus' } }, version: base, installDir: stale });
    assert.strictEqual(updater.channel(), 'official');
    assert.strictEqual(updater.updateSummary().channel, 'official');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('All personal channel tests passed.');
  });
}

function waitFor(cond, then) {
  var t = setInterval(function () {
    if (cond()) { clearInterval(t); then(); }
  }, 20);
}
