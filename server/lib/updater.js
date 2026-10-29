// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
var msg = require('./say').msg;
var fs = require('fs');
var toInt = require('./util').toInt;
var mkdirp = require('./util').mkdirp;
var readJson = require('./util').readJson;
var path = require('path');
var zlib = require('zlib');
var execFile = require('child_process').execFile;
var fetch = require('./fetch');
var hashFile = require('./installer').hashFile;
var personal = require('./personal');
var probeFetch = fetch.probeFetch;
var execErr = fetch.execErr;

var UPDATE_REPO = 'rorygallagher2024/glasshouse';
// The recent releases rather than only the latest, for what each one since
// the installed version brings.
var UPDATE_API = 'https://api.github.com/repos/' + UPDATE_REPO + '/releases?per_page=10';
var WHATS_NEW_MAX = 5;
var UPDATE_TARBALL = 'https://codeload.github.com/' + UPDATE_REPO + '/tar.gz/refs/tags/v';
// The Homebrew Channel package each release carries, and the manifest naming
// its file and sha256 (.github/workflows/homebrew-channel.yml).
var PACKAGE_ID = 'io.github.rorygallagher2024.lg-webos-dashboard';
var RELEASE_DOWNLOAD = 'https://github.com/' + UPDATE_REPO + '/releases/download/v';
var BOOT_HOOK = '/var/lib/webosbrew/init.d/50-tvweb';

var installDir = path.resolve(__dirname, '..');
var stageDir = path.join(installDir, '.update');
var prevDir = path.join(installDir, '.previous');

var UPDATE = {
  state: 'idle',   // idle | checking | available | current | downloading | installing | installed | offline | error
  latest: null,
  url: null,
  notes: null,
  whatsNew: [],
  whatsNewMore: 0,
  checked: 0,       // last check that got an answer
  attempted: 0,     // last check, answered or not
  error: null,
  busy: false,
  channel: 'official',   // the channel `latest` was read from
  manifest: null         // the personal release behind `latest`, on that channel
};

var config = {};
// Compared against releases. shownVersion is what a person reads, the same
// version with build metadata when deploy.sh left a build.json.
var currentVersion = '';
var shownVersion = '';
// What personal.json says of the installed build, or null for an official one.
var installedPersonal = null;
var writeSettingsFn = null;
var publishUpdateFn = null;
var publishDiscoveryFn = null;
// True when the Homebrew Channel installed the server. A release's server
// files installed here would be taken back to the app's own copy, so the
// release's package is installed instead and the app brings the server along.
var viaHomebrewChannel = function () { return false; };
var installerBusy = function () { return false; };
// installPackage(file, version, cb(err)) puts an .ipk in place with the TV's
// app installer; afterPackage(version) runs the app's own installer, which
// moves the server over and restarts it.
var installPackageFn = null;
/** @type {(version: string) => void} */
var afterPackageFn = function () {};
var packageStageDir = '/media/developer/temp/glasshouse-update';
var updateFirstTimer = null;
var updateEveryTimer = null;

function setUpdateState(state, err) {
  UPDATE.state = state;
  UPDATE.error = err || null;
  if (publishUpdateFn) publishUpdateFn();
}

function verParts(v) {
  var a = String(v || '').replace(/^v/i, '').split('.');
  return [toInt(a[0], 0), toInt(a[1], 0), toInt(a[2], 0), toInt(a[3], 0)];
}

function verNewer(a, b) {
  var x = verParts(a), y = verParts(b);
  for (var i = 0; i < 4; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

/*
 * The version to show: `version` with semver build metadata from the
 * build.json deploy.sh writes when it deploys from a git clone, as in
 * 0.80.1+55e51e5 or 0.80.1+55e51e5.dirty. A file recording another version
 * claims nothing: a release installed over a git build leaves it behind.
 * Build metadata does not count towards precedence, so comparisons keep using
 * the bare version.
 */
function displayVersion(version, dir) {
  var id = personal.readIdentity(dir, version);
  if (id) return personal.displayOf(id);
  var file = path.join(dir, 'build.json');
  var build = readJson(file, null);
  if (!build || !/^[0-9a-f]{4,40}$/.test(build.commit)) return version;
  if (build.version !== version) {
    console.log('update: ignoring stale build metadata from v' + build.version + ' (running v' + version + ')');
    return version;
  }
  return version + '+' + build.commit + (build.dirty ? '.dirty' : '');
}

function declaredVersion(file) {
  try {
    // The whole file: up to 0.82.2 this read only the first 4096 bytes, which
    // missed the line once it moved further down (#586).
    var m = /^var TVWEB_VERSION = '([^']+)';/m.exec(fs.readFileSync(file, 'utf8'));
    return m ? m[1] : null;
  } catch (e) { return null; }
}

function rollbackVersion() {
  try {
    var v = declaredVersion(path.join(prevDir, 'tvweb.js'));
    if (!v) return null;
    var id = personal.readIdentity(prevDir, v);
    return id ? personal.idString(id.base, id.rev) : v;
  } catch (e) { return null; }
}

// Official until the person switches it, and only the two names count.
function channel() {
  return config.update && config.update.channel === 'personal' ? 'personal' : 'official';
}

// What the installed build is called: the version, with the personal revision
// when personal.json on disk says this is a personal build. It describes the
// files, whichever channel is being checked, because the page waits for it
// after an install or a rollback.
function installedId() {
  return installedPersonal
    ? personal.idString(installedPersonal.base, installedPersonal.rev) : currentVersion;
}

// What Home Assistant's update entity is told is installed. It compares this
// with the latest version of the channel being checked, so a personal build
// is named as one only while the personal channel is selected; the official
// channel never offers a "newer" version for it to disagree with.
function haInstalledId() {
  return channel() === 'personal' ? installedId() : currentVersion;
}

// Whether what the last check found is newer than what is installed.
function latestIsNewer() {
  if (!UPDATE.latest) return false;
  if (UPDATE.channel === 'personal') {
    return !!UPDATE.manifest && personal.newer(UPDATE.manifest,
      { base: currentVersion, rev: installedPersonal ? installedPersonal.rev : 0 });
  }
  return verNewer(UPDATE.latest, currentVersion);
}

function updateSummary() {
  return {
    ok: true,
    state: UPDATE.state,
    installed: shownVersion,
    // What the installed files are called, whichever channel is selected.
    installedId: installedId(),
    channel: channel(),
    channelChoice: !viaHomebrewChannel(),
    latest: UPDATE.latest,
    available: latestIsNewer(),
    url: UPDATE.url,
    notes: UPDATE.notes,
    whatsNew: UPDATE.whatsNew,
    whatsNewMore: UPDATE.whatsNewMore,
    error: UPDATE.error,
    client: fetch.client(),
    autoCheck: !!(config.update && config.update.check),
    rollbackTo: viaHomebrewChannel() ? null : rollbackVersion(),
    writable: config.allowControl,
    viaHomebrewChannel: viaHomebrewChannel(),
    checkedMs: UPDATE.checked ? Date.now() - UPDATE.checked : null,
    attemptedMs: UPDATE.attempted ? Date.now() - UPDATE.attempted : null
  };
}

function findBin(name) {
  var dirs = fetch.clientDirs();
  for (var i = 0; i < dirs.length; i++) {
    var full = dirs[i] + '/' + name;
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function clearFound() {
  UPDATE.latest = null;
  UPDATE.url = null;
  UPDATE.notes = null;
  UPDATE.whatsNew = [];
  UPDATE.whatsNewMore = 0;
  UPDATE.manifest = null;
  UPDATE.checked = 0;
  UPDATE.attempted = 0;
  UPDATE.channel = channel();
}

/*
 * The personal channel's check: one manifest, at a fixed address, that names
 * the latest personal release. Its fields are matched strictly (personal.js).
 */
function checkPersonal(cb) {
  probeFetch(personal.PERSONAL_MANIFEST_URL, null, function (err, body) {
    if (err) {
      setUpdateState(err.offline ? 'offline' : 'error', err.message);
      return cb(err, updateSummary());
    }
    var parsed = personal.parseManifest(body);
    if (!parsed.manifest) {
      var bad = new Error(msg('srv.update.badPersonalManifest', 'the personal release has no usable manifest ({why})', { why: parsed.error }));
      setUpdateState('error', bad.message);
      return cb(bad, updateSummary());
    }
    var man = parsed.manifest;
    UPDATE.manifest = man;
    UPDATE.latest = personal.idString(man.base, man.rev);
    UPDATE.url = personal.PERSONAL_RELEASES + personal.tagOf(man.base, man.rev);
    UPDATE.notes = null;
    UPDATE.whatsNew = [];
    UPDATE.whatsNewMore = 0;
    UPDATE.channel = 'personal';
    UPDATE.checked = Date.now();
    setUpdateState(latestIsNewer() ? 'available' : 'current');
    console.log('update: installed v' + shownVersion + ', latest personal v' + UPDATE.latest +
                ' (' + UPDATE.state + ', via ' + fetch.client() + ')');
    cb(null, updateSummary());
  });
}

function setChannel(name, cb) {
  if (name !== 'official' && name !== 'personal') return cb({ ok: false, error: 'unknown update channel' });
  if (name === 'personal' && viaHomebrewChannel()) {
    return cb({ ok: false, error: msg('srv.update.personalViaHbc', 'the personal channel updates the server in place, which a Homebrew Channel install does not allow') });
  }
  if (UPDATE.busy) return cb({ ok: false, error: msg('srv.update.busy', 'an update is already running') });
  // A check under way would report the old channel's answer on the new one.
  if (UPDATE.state === 'checking') return cb({ ok: false, error: msg('srv.update.checkRunning', 'a check is running; try again when it has finished') });
  if (!writeSettingsFn) return cb({ ok: false, error: 'no writeSettings handler configured' });
  writeSettingsFn({ update: { channel: name } }, function (err) {
    if (err) return cb({ ok: false, error: msg('srv.saveSettingFailed', 'could not save the setting: {error}', { error: err.message }) });
    config.update = config.update || {};
    config.update.channel = name;
    clearFound();
    console.log('update: channel set to ' + name);
    setUpdateState('idle');
    checkForUpdate(false, function () { cb(updateSummary()); });
  });
}

/*
 * Ask GitHub for the latest release, unless a recent enough answer is already
 * held: unauthenticated calls are limited to 60 an hour from one address, so
 * `force` shortens that cache rather than removing it, and a number sets it.
 */
function checkForUpdate(force, cb) {
  cb = cb || function () {};
  if (UPDATE.state === 'checking') return cb(null, updateSummary());
  // What was found on the other channel says nothing about this one.
  if (UPDATE.channel !== channel()) clearFound();
  var minAge = typeof force === 'number' ? force : force ? 10000 : 3600000;
  if (UPDATE.latest && (Date.now() - UPDATE.checked) < minAge) return cb(null, updateSummary());
  // A tab being opened also lets a failed attempt stand, so an offline TV is not
  // tried again every time someone switches back to it.
  if (typeof force === 'number' && (Date.now() - UPDATE.attempted) < minAge) return cb(null, updateSummary());

  UPDATE.attempted = Date.now();
  setUpdateState('checking');
  if (channel() === 'personal') return checkPersonal(cb);
  probeFetch(UPDATE_API, null, function (err, body) {
    if (err) {
      setUpdateState(err.offline ? 'offline' : 'error', err.message);
      return cb(err, updateSummary());
    }
    var parsed = null;
    try { parsed = JSON.parse(body); } catch (e) {}
    var found = readReleases(parsed, currentVersion);
    if (!found) {
      var why = (parsed && parsed.message) ? parsed.message : 'GitHub did not return a release';
      setUpdateState('error', why);
      return cb(new Error(why), updateSummary());
    }
    UPDATE.latest = found.latest;
    UPDATE.url = found.url;
    UPDATE.notes = found.notes;
    UPDATE.whatsNew = found.whatsNew;
    UPDATE.whatsNewMore = found.more;
    UPDATE.checked = Date.now();
    UPDATE.channel = 'official';
    setUpdateState(verNewer(UPDATE.latest, currentVersion) ? 'available' : 'current');
    console.log('update: installed v' + shownVersion + ', latest v' + UPDATE.latest +
                ' (' + UPDATE.state + ', via ' + fetch.client() + ')');
    cb(null, updateSummary());
  });
}

/*
 * A release's notes open with a short summary for people using Glasshouse,
 * above a "## Details" heading with the full notes. The summary, as plain
 * text, or null for a release without one (those before 0.91).
 */
function releaseSummary(body) {
  var text = String(body || '').replace(/\r/g, '');
  var m = /^##[ \t]+Details[ \t]*$/m.exec(text);
  if (!m) return null;
  var s = text.slice(0, m.index)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/\x60([^\x60]*)\x60/g, '$1')
    .trim();
  return s ? s.slice(0, 600) : null;
}

/*
 * From GitHub's release list (newest first): the latest release, and the
 * summaries of those newer than `installed`, newest first, as { latest, url,
 * notes, whatsNew: [{ version, summary, url }], more }. more counts the newer
 * ones beyond WHATS_NEW_MAX or without a summary. null for no release.
 */
function linkOf(r) {
  return typeof r.html_url === 'string' && /^https:\/\//.test(r.html_url) ? r.html_url : null;
}

function readReleases(list, installed) {
  if (list && !Array.isArray(list) && list.tag_name) list = [list];
  if (!Array.isArray(list)) return null;
  // Only tags that are versions, so a stray tag cannot pose as the latest.
  var stable = list.filter(function (r) {
    return r && /^v?\d+\.\d+/.test(String(r.tag_name || '')) && !r.draft && !r.prerelease;
  });
  if (!stable.length) return null;
  var newer = [];
  stable.forEach(function (r) {
    var v = String(r.tag_name).replace(/^v/i, '');
    if (verNewer(v, installed)) newer.push({ version: v, summary: releaseSummary(r.body), url: linkOf(r) });
  });
  var shown = newer.filter(function (r) { return r.summary; }).slice(0, WHATS_NEW_MAX);
  return {
    latest: String(stable[0].tag_name).replace(/^v/i, ''),
    url: linkOf(stable[0]),
    notes: releaseSummary(stable[0].body),
    whatsNew: shown,
    more: newer.length - shown.length
  };
}

function scheduleUpdateChecks(firstMs) {
  if (updateFirstTimer) { clearTimeout(updateFirstTimer); updateFirstTimer = null; }
  if (updateEveryTimer) { clearInterval(updateEveryTimer); updateEveryTimer = null; }
  if (!(config.update && config.update.check)) return;
  var everyH = toInt(config.update.intervalHours, 24);
  if (!(everyH >= 1 && everyH <= 168)) everyH = 24;
  if (firstMs) {
    updateFirstTimer = setTimeout(function () {
      updateFirstTimer = null;
      checkForUpdate(false);
    }, firstMs);
  }
  updateEveryTimer = setInterval(function () { checkForUpdate(false); }, everyH * 3600000);
  console.log('update: checking for new releases every ' + everyH + 'h');
}

function setAutoCheck(on, cb) {
  if (!writeSettingsFn) return cb({ ok: false, error: 'no writeSettings handler configured' });
  writeSettingsFn({ update: { check: on } }, function (err) {
    if (err) return cb({ ok: false, error: msg('srv.saveSettingFailed', 'could not save the setting: {error}', { error: err.message }) });
    config.update = config.update || {};
    config.update.check = on;
    scheduleUpdateChecks(0);
    if (publishDiscoveryFn) publishDiscoveryFn();
    console.log('update: daily check switched ' + (on ? 'on' : 'off'));
    if (!on) return cb(updateSummary());
    checkForUpdate(false, function () { cb(updateSummary()); });
  });
}

function copyFile(src, dst) {
  fs.writeFileSync(dst, fs.readFileSync(src));
}

function listFiles(dir, base, out) {
  base = base || dir;
  out = out || [];
  var names = fs.readdirSync(dir);
  for (var i = 0; i < names.length; i++) {
    var full = path.join(dir, names[i]);
    var st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (st.isDirectory()) listFiles(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

function rmrf(dir, cb) {
  if (!fs.existsSync(dir)) return cb();
  execFile('/bin/rm', ['-rf', dir], { timeout: 20000 }, function () { cb(); });
}

function tarballTop(dir) {
  var names = fs.readdirSync(dir);
  for (var i = 0; i < names.length; i++) {
    var full = path.join(dir, names[i]);
    try {
      if (fs.statSync(full).isDirectory()) return full;
    } catch (e) {}
  }
  return null;
}

// zlib's sync calls arrived in node 0.11.12; webOS 2 runs 0.10, which has
// only the async one.
function inflate(buf, cb) {
  if (typeof zlib.gunzipSync !== 'function') return zlib.gunzip(buf, cb);
  var out;
  try { out = zlib.gunzipSync(buf); } catch (e) { return cb(e); }
  cb(null, out);
}

function installFile(src, dst, exec) {
  mkdirp(path.dirname(dst));
  var tmp = dst + '.new';
  copyFile(src, tmp);
  fs.chmodSync(tmp, exec ? parseInt('755', 8) : parseInt('644', 8));
  fs.renameSync(tmp, dst);
}

function isExecutable(rel) {
  return rel === 'tvwebctl' || /\.sh$/.test(rel);
}

function isBusy() { return !!UPDATE.busy; }

function installBusy(cb) {
  if (!installerBusy()) return false;
  cb({ ok: false, error: msg('srv.install.busy.update', 'an app install is in progress; update when it has finished') });
  return true;
}

/*
 * A Homebrew Channel install updates by the release's package, as the Homebrew
 * Channel itself would: the TV's app installer puts it in place, then the
 * app's installer moves the server over and restarts it. Glasshouse is not in
 * the Homebrew Channel's catalog, so nothing else would offer the update.
 */
function installReleasePackage(ver, done) {
  var fail = function (reason) {
    setUpdateState('error', reason);
    console.error('update: ' + reason);
    rmrf(packageStageDir, function () { done({ ok: false, error: reason }); });
  };
  probeFetch(RELEASE_DOWNLOAD + ver + '/' + PACKAGE_ID + '.manifest.json', null, function (err, body) {
    if (err) return fail(err.message);
    var man = null;
    try { man = JSON.parse(body); } catch (e) {}
    var file = man && String(man.ipkUrl || '');
    var sha = man && man.ipkHash && String(man.ipkHash.sha256 || '').toLowerCase();
    if (!man || man.id !== PACKAGE_ID || man.version !== ver ||
        !/^[A-Za-z0-9._+-]+\.ipk$/.test(file) || !/^[0-9a-f]{64}$/.test(sha)) {
      return fail(msg('srv.update.badManifest', 'the release v{version} has no usable package manifest', { version: ver }));
    }
    rmrf(packageStageDir, function () {
      try { mkdirp(packageStageDir); } catch (e) { return fail('could not create ' + packageStageDir + ': ' + e.message); }
      var ipk = path.join(packageStageDir, file);
      console.log('update: downloading the v' + ver + ' package');
      fetch.download(RELEASE_DOWNLOAD + ver + '/' + file, ipk, {}, function (e2) {
        if (e2) return fail(e2.message);
        hashFile(ipk, function (e3, got) {
          if (e3) return fail('could not read the download: ' + e3.message);
          if (got !== sha) return fail(msg('srv.update.badHash', 'the downloaded package does not match the release\'s checksum'));
          setUpdateState('installing');
          installPackageFn(ipk, ver, function (e4) {
            if (e4) return fail(String(e4.message || e4));
            rmrf(packageStageDir, function () {
              setUpdateState('installed');
              console.log('update: installed the v' + ver + ' package over v' + shownVersion);
              afterPackageFn(ver);
              done({ ok: true, updated: true, installed: currentVersion, latest: ver, restarting: true });
            });
          });
        });
      });
    });
  });
}

/*
 * Puts the files of an unpacked release in place, the one step both channels
 * share. The originals go to .previous first. When a personal build is
 * involved (arriving, or leaving because an official release replaces it),
 * .previous also records which files the update adds, so a rollback can remove
 * them, and personal.json goes last: the identity of what is installed is
 * never ahead of its files. If a file fails then, what was saved is put back.
 */
function installFiles(src, isPersonalBundle, fail, ok) {
  var files = listFiles(src), installed = [], bad = null;
  var identityFile = path.join(installDir, personal.PERSONAL_FILE);
  var involved = isPersonalBundle || fs.existsSync(identityFile);
  var skipped = { 'deploy.sh': 1, '50-tvweb.sh': 1 };
  skipped[personal.PERSONAL_FILE] = 1;
  rmrf(prevDir, function () {
    if (involved) {
      var added = [];
      for (var j = 0; j < files.length; j++) {
        if (skipped[files[j]]) continue;
        if (!fs.existsSync(path.join(installDir, files[j]))) added.push(files[j]);
      }
      if (isPersonalBundle && !fs.existsSync(identityFile)) added.push(personal.PERSONAL_FILE);
      try {
        mkdirp(prevDir);
        fs.writeFileSync(path.join(prevDir, personal.IDENTITY_FILE), JSON.stringify({ added: added }));
      } catch (e) { return fail('could not record the rollback copy: ' + e.message); }
    }
    for (var i = 0; i < files.length; i++) {
      var rel = files[i];
      if (skipped[rel]) continue;
      var dst = path.join(installDir, rel);
      try {
        if (fs.existsSync(dst)) {
          var keep = path.join(prevDir, rel);
          mkdirp(path.dirname(keep));
          copyFile(dst, keep);
        }
        installFile(path.join(src, rel), dst, isExecutable(rel));
        installed.push(rel);
      } catch (e) { bad = rel + ': ' + e.message; break; }
    }
    if (!bad && involved) {
      try {
        if (fs.existsSync(identityFile)) {
          mkdirp(prevDir);
          copyFile(identityFile, path.join(prevDir, personal.PERSONAL_FILE));
        }
        if (isPersonalBundle) installFile(path.join(src, personal.PERSONAL_FILE), identityFile, false);
        else fs.unlinkSync(identityFile);
      } catch (e) { bad = personal.PERSONAL_FILE + ': ' + e.message; }
    }
    if (bad) {
      if (involved) {
        var undone = restorePrevious();
        return fail('could not install ' + bad + (undone.error ? ' (and could not restore ' + undone.error.file + ')'
                                                                : ' (v' + currentVersion + ' was put back)'));
      }
      return fail('could not install ' + bad + ' (v' + currentVersion + ' is in .previous)');
    }

    if (fs.existsSync(BOOT_HOOK) && fs.existsSync(path.join(src, '50-tvweb.sh'))) {
      try {
        installFile(path.join(src, '50-tvweb.sh'), BOOT_HOOK, true);
      } catch (e) {
        console.error('update: could not refresh the boot hook: ' + e.message);
      }
    }

    var devAppIdx = '/media/developer/apps/usr/palm/applications/com.tvweb.dashboard/index.html';
    if (fs.existsSync(devAppIdx) && fs.existsSync(path.join(src, 'assets/dashboard-app/index.html'))) {
      try {
        installFile(path.join(src, 'assets/dashboard-app/index.html'), devAppIdx, false);
      } catch (e) {
        console.error('update: could not refresh the installed app wrapper: ' + e.message);
      }
    }
    ok(installed.length);
  });
}

/*
 * The personal channel's install: the bundle the manifest names, checked
 * against the manifest's size and sha256 before it is opened, and its contents
 * checked against the manifest after: only plain files, names that stay inside
 * the server directory, and a tvweb.js and personal.json that agree with it.
 */
function installPersonalBundle(man, fail, done) {
  var ver = personal.idString(man.base, man.rev);
  rmrf(stageDir, function () {
    try { mkdirp(stageDir); } catch (e) { return fail('could not create ' + stageDir + ': ' + e.message); }
    var gz = path.join(stageDir, man.file);
    console.log('update: downloading personal v' + ver);
    fetch.download(personal.PERSONAL_DOWNLOAD + personal.tagOf(man.base, man.rev) + '/' + man.file, gz, {}, function (e2) {
      if (e2) return fail(e2.message);
      var size;
      try { size = fs.statSync(gz).size; } catch (e) { return fail('could not read the download: ' + e.message); }
      if (size !== man.size) return fail(msg('srv.update.badPersonalSize', 'the downloaded bundle is not the size the release names'));
      hashFile(gz, function (e3, got) {
        if (e3) return fail('could not read the download: ' + e3.message);
        if (got !== man.sha256) return fail(msg('srv.update.badHash', 'the downloaded package does not match the release\'s checksum'));
        var gzBuf;
        try { gzBuf = fs.readFileSync(gz); } catch (e) { return fail('could not read the download: ' + e.message); }
        inflate(gzBuf, function (e4, tarBuf) {
          if (e4) return fail('the download did not arrive complete (' + e4.message + ')');
          var tarBin = findBin('tar');
          if (!tarBin) return fail('no tar on this TV to unpack the release with');
          var tarFile = path.join(stageDir, 'bundle.tar');
          try { fs.writeFileSync(tarFile, tarBuf); } catch (e) { return fail('could not stage the release: ' + e.message); }
          var listOpts = { timeout: 60000, maxBuffer: 4 * 1024 * 1024 };
          execFile(tarBin, ['-tf', tarFile], listOpts, function (e5, names, se5) {
            if (e5) return fail('could not read the bundle: ' + execErr(e5, se5));
            var nameList = String(names).split('\n').filter(Boolean);
            var listErr = personal.checkListing(nameList);
            if (listErr) return fail(listErr);
            execFile(tarBin, ['-tvf', tarFile], listOpts, function (e6, detail, se6) {
              if (e6) return fail('could not read the bundle: ' + execErr(e6, se6));
              var typeErr = personal.checkTypes(String(detail).split('\n').filter(Boolean), nameList.length);
              if (typeErr) return fail(typeErr);
              setUpdateState('installing');
              execFile(tarBin, ['-xf', tarFile, '-C', stageDir], { timeout: 120000 }, function (e7, _out7, se7) {
                if (e7) return fail('could not unpack the release: ' + execErr(e7, se7));
                var top = path.join(stageDir, personal.BUNDLE_TOP);
                var walked;
                try { walked = personal.walkBundle(top); } catch (e) { walked = { error: 'the bundle did not unpack: ' + e.message }; }
                if (walked.error) return fail(walked.error);
                if (walked.files.indexOf('tvweb.js') === -1 || walked.files.indexOf(personal.PERSONAL_FILE) === -1) {
                  return fail('the personal bundle lacks its server or its identity file');
                }
                var decl = declaredVersion(path.join(top, 'tvweb.js'));
                var id = personal.validIdentity(readJson(path.join(top, personal.PERSONAL_FILE), null));
                if (decl !== man.base || !id || id.base !== man.base || id.rev !== man.rev || id.commit !== man.commit) {
                  return fail('the downloaded bundle does not match its manifest');
                }
                installFiles(top, true, fail, function (count) {
                  rmrf(stageDir, function () {
                    setUpdateState('installed');
                    console.log('update: installed personal v' + ver + ' over v' + shownVersion + ' (' + count + ' files)');
                    done({ ok: true, updated: true, installed: installedId(), latest: ver, files: count });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

function installUpdate(opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  opts = opts || {};
  if (installBusy(cb)) return;
  if (UPDATE.busy) return cb({ ok: false, error: msg('srv.update.busy', 'an update is already running') });
  var onPersonal = channel() === 'personal';
  if (onPersonal && viaHomebrewChannel()) {
    return cb({ ok: false, error: msg('srv.update.personalViaHbc', 'the personal channel updates the server in place, which a Homebrew Channel install does not allow') });
  }
  var asPackage = viaHomebrewChannel() && !opts.force;
  if (asPackage && !installPackageFn) {
    return cb({ ok: false, error: msg('srv.update.viaHbc', 'updates for this install come from the Homebrew Channel (or sideload the latest .ipk from GitHub releases)') });
  }

  if (!asPackage && fs.existsSync(path.join(installDir, '..', '.git'))) {
    return cb({ ok: false, error: msg('srv.update.gitCheckout', 'this is a git checkout - update it with git, not from here') });
  }

  UPDATE.busy = true;
  var done = function (r) {
    UPDATE.busy = false;
    if (publishUpdateFn) publishUpdateFn();
    cb(r);
  };
  var fail = function (reason) {
    setUpdateState('error', reason);
    console.error('update: ' + reason);
    rmrf(stageDir, function () { done({ ok: false, error: reason }); });
  };

  checkForUpdate(true, function (err) {
    if (err) return done({ ok: false, error: err.message });
    var ver = UPDATE.latest;
    if (!ver) return done({ ok: false, error: msg('srv.update.noInfo', 'no release information yet - check first') });
    if (!latestIsNewer() && !opts.force) {
      return done({ ok: true, updated: false, installed: onPersonal ? installedId() : currentVersion, latest: ver,
                    note: msg('srv.update.latest', 'already on the latest release') });
    }

    setUpdateState('downloading');
    if (asPackage) return installReleasePackage(ver, done);
    if (onPersonal) {
      if (UPDATE.channel !== 'personal' || !UPDATE.manifest) {
        return fail(msg('srv.update.noInfo', 'no release information yet - check first'));
      }
      return installPersonalBundle(UPDATE.manifest, fail, done);
    }
    rmrf(stageDir, function () {
      try { mkdirp(stageDir); } catch (e) { return fail('could not create ' + stageDir + ': ' + e.message); }
      var gz = path.join(stageDir, 'release.tar.gz');
      console.log('update: downloading v' + ver);
      probeFetch(UPDATE_TARBALL + ver, gz, function (e2) {
        if (e2) return fail(e2.message);

        var gzBuf;
        try { gzBuf = fs.readFileSync(gz); } catch (e) { return fail('could not read the download: ' + e.message); }
        inflate(gzBuf, function (e3, tarBuf) {
          if (e3) return fail('the download did not arrive complete (' + e3.message + ')');
          var tarBin = findBin('tar');
          if (!tarBin) return fail('no tar on this TV to unpack the release with');
          var tarFile = path.join(stageDir, 'release.tar');
          try { fs.writeFileSync(tarFile, tarBuf); } catch (e) { return fail('could not stage the release: ' + e.message); }

          setUpdateState('installing');
          execFile(tarBin, ['-xf', tarFile, '-C', stageDir], { timeout: 120000 }, function (e4, _out4, se) {
            if (e4) return fail('could not unpack the release: ' + execErr(e4, se));
            var top = tarballTop(stageDir);
            var src = top ? path.join(top, 'server') : null;
            if (!src || !fs.existsSync(path.join(src, 'tvweb.js'))) {
              return fail('the release tarball has no server directory in it');
            }

            var decl;
            try { decl = declaredVersion(path.join(src, 'tvweb.js')); } catch (e) { decl = null; }
            if (decl !== ver) {
              return fail('the downloaded release declares v' + decl + ', not v' + ver);
            }

            installFiles(src, false, fail, function (count) {
              rmrf(stageDir, function () {
                setUpdateState('installed');
                console.log('update: installed v' + ver + ' over v' + shownVersion +
                            ' (' + count + ' files)');
                done({ ok: true, updated: true, installed: currentVersion, latest: ver,
                       files: count });
              });
            });
          });
        });
      });
    });
  });
}

/*
 * Puts back what .previous holds, and removes what the update added (named in
 * .previous/.identity.json, which only an update involving a personal build
 * writes). { files } or { error: { file, message } }.
 */
function restorePrevious() {
  var files = listFiles(prevDir), restored = 0, i, rel;
  for (i = 0; i < files.length; i++) {
    rel = files[i];
    if (rel === personal.IDENTITY_FILE) continue;
    try {
      installFile(path.join(prevDir, rel), path.join(installDir, rel), isExecutable(rel));
      restored++;
    } catch (e) { return { error: { file: rel, message: e.message } }; }
  }
  var record = readJson(path.join(prevDir, personal.IDENTITY_FILE), null);
  var added = record && Array.isArray(record.added) ? record.added : [];
  for (i = 0; i < added.length; i++) {
    rel = added[i];
    if (!personal.safeRelPath(rel)) continue;
    try { fs.unlinkSync(path.join(installDir, rel)); } catch (e) {
      if (e.code !== 'ENOENT') return { error: { file: rel, message: e.message } };
    }
  }
  return { files: restored };
}

function rollbackUpdate(opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  opts = opts || {};
  if (installBusy(cb)) return;
  if (viaHomebrewChannel() && !opts.force) {
    return cb({ ok: false, error: msg('srv.update.viaHbc', 'updates for this install come from the Homebrew Channel (or sideload the latest .ipk from GitHub releases)') });
  }
  var was = rollbackVersion();
  if (!was) return cb({ ok: false, error: msg('srv.update.noRollback', 'nothing to roll back to') });
  var r = restorePrevious();
  if (r.error) {
    return cb({ ok: false, error: msg('srv.update.restoreFailed', 'could not restore {file}: {error}', { file: r.error.file, error: r.error.message }) });
  }
  console.log('update: rolled back to v' + was + ' (' + r.files + ' files)');
  cb({ ok: true, restored: was, files: r.files });
}

function init(opts) {
  opts = opts || {};
  if (opts.config) config = opts.config;
  if (opts.version) currentVersion = shownVersion = opts.version;
  if (opts.displayVersion) shownVersion = opts.displayVersion;
  fetch.init({ config: opts.config, version: opts.version });
  if (opts.installDir) {
    installDir = opts.installDir;
    stageDir = path.join(installDir, '.update');
    prevDir = path.join(installDir, '.previous');
  }
  installedPersonal = currentVersion ? personal.readIdentity(installDir, currentVersion) : null;
  UPDATE.channel = channel();
  if (opts.writeSettings) writeSettingsFn = opts.writeSettings;
  if (opts.onUpdateChange) publishUpdateFn = opts.onUpdateChange;
  if (opts.onDiscoveryChange) publishDiscoveryFn = opts.onDiscoveryChange;
  if (opts.viaHomebrewChannel) viaHomebrewChannel = opts.viaHomebrewChannel;
  if (opts.installerBusy) installerBusy = opts.installerBusy;
  if (opts.installPackage) installPackageFn = opts.installPackage;
  if (opts.afterPackage) afterPackageFn = opts.afterPackage;
  if (opts.packageStageDir) packageStageDir = opts.packageStageDir;
}

function setPublishHandler(pubUpdate, pubDiscovery) {
  publishUpdateFn = pubUpdate;
  publishDiscoveryFn = pubDiscovery;
}

module.exports = {
  init: init,
  UPDATE: UPDATE,
  setPublishHandler: setPublishHandler,
  updateSummary: updateSummary,
  checkForUpdate: checkForUpdate,
  installUpdate: installUpdate,
  isBusy: isBusy,
  rollbackUpdate: rollbackUpdate,
  // The file work of an install, exported so test/test-personal.js can run it on a real directory.
  installFiles: installFiles,
  restorePrevious: restorePrevious,
  scheduleUpdateChecks: scheduleUpdateChecks,
  setAutoCheck: setAutoCheck,
  setChannel: setChannel,
  channel: channel,
  installedId: installedId,
  haInstalledId: haInstalledId,
  verNewer: verNewer,
  readReleases: readReleases,
  releaseSummary: releaseSummary,
  declaredVersion: declaredVersion,
  displayVersion: displayVersion
};
