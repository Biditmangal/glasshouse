// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
//
// The personal release channel: what a personal build says about itself
// (server/personal.json) and what its release manifest may say. Pure
// functions; the updater does the downloading and the file work.
//
// TVWEB_VERSION stays the upstream base version. A personal build is that
// base plus a revision, shown as 0.132.0+personal.2.<commit>.
var fs = require('fs');
var path = require('path');
var readJson = require('./util').readJson;

// The one place a personal release is read from. Not configurable and not
// taken from a manifest, so nothing a page or a release says can point the
// updater at another repository.
var PERSONAL_REPO = 'Biditmangal/glasshouse';
var PERSONAL_MANIFEST_URL = 'https://github.com/' + PERSONAL_REPO +
  '/releases/latest/download/glasshouse-personal.manifest.json';
var PERSONAL_DOWNLOAD = 'https://github.com/' + PERSONAL_REPO + '/releases/download/';
var PERSONAL_RELEASES = 'https://github.com/' + PERSONAL_REPO + '/releases/tag/';
var PERSONAL_FILE = 'personal.json';
var IDENTITY_FILE = '.identity.json';
// Top directory of the server tarball, and its size limits.
var BUNDLE_TOP = 'glasshouse-personal';
var MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
var MAX_MANIFEST_BYTES = 8192;

var BASE_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
var COMMIT_RE = /^[0-9a-f]{40}$/;
var SHA256_RE = /^[0-9a-f]{64}$/;
var MAX_REV = 999999;

function isRev(n) {
  return typeof n === 'number' && n >= 1 && n <= MAX_REV && Math.floor(n) === n;
}

function baseParts(base) {
  var a = String(base).split('.');
  return [parseInt(a[0], 10), parseInt(a[1], 10), parseInt(a[2], 10)];
}

// 0.132.0+personal.2, what is compared and what the update check reports.
function idString(base, rev) {
  return base + '+personal.' + rev;
}

function tagOf(base, rev) {
  return 'v' + base + '-personal.' + rev;
}

function bundleName(base, rev) {
  return 'glasshouse-personal-' + base + '-p' + rev + '.tar.gz';
}

/*
 * The build identity {base, rev} of what is installed: rev 0 is an official
 * build. Whether (base, rev) of a is newer than b's: the base first, then the
 * revision. A personal build never offers to go back to a lower base.
 */
function newer(a, b) {
  var x = baseParts(a.base), y = baseParts(b.base);
  for (var i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return a.rev > b.rev;
}

/*
 * personal.json as an installed build or a bundle carries it, checked field by
 * field; null for anything else. `version` is the TVWEB_VERSION beside it: a
 * file for another base claims nothing (a deploy from source or an official
 * update leaves one behind only if something went wrong), and is not believed.
 */
function validIdentity(j) {
  if (!j || typeof j !== 'object' || j.channel !== 'personal') return null;
  if (typeof j.base !== 'string' || !BASE_RE.test(j.base)) return null;
  if (!isRev(j.rev)) return null;
  if (typeof j.commit !== 'string' || !COMMIT_RE.test(j.commit)) return null;
  return { base: j.base, rev: j.rev, commit: j.commit, built: typeof j.built_by === 'string' };
}

function readIdentity(dir, version) {
  var id = validIdentity(readJson(path.join(dir, PERSONAL_FILE), null));
  if (!id) return null;
  if (id.base !== version) {
    console.log('update: ignoring personal.json for v' + id.base + ' (running v' + version + ')');
    return null;
  }
  return id;
}

// The version to show: 0.132.0+personal.2.1a2b3c4
function displayOf(id) {
  return idString(id.base, id.rev) + '.' + id.commit.slice(0, 7);
}

/*
 * The release manifest, strictly: every field that names something is derived
 * or matched, never trusted as a path or an address. { manifest } or { error }.
 */
function parseManifest(body) {
  if (typeof body !== 'string' || body.length > MAX_MANIFEST_BYTES) return { error: 'no usable manifest' };
  var m = null;
  try { m = JSON.parse(body); } catch (e) {}
  var id = validIdentity(m);
  if (!id) return { error: 'the manifest is not a personal release' };
  if (m.file !== bundleName(id.base, id.rev)) return { error: 'the manifest names an unexpected file' };
  if (typeof m.sha256 !== 'string' || !SHA256_RE.test(m.sha256)) return { error: 'the manifest has no usable sha256' };
  if (typeof m.size !== 'number' || Math.floor(m.size) !== m.size || m.size < 1 || m.size > MAX_BUNDLE_BYTES) {
    return { error: 'the manifest has no usable size' };
  }
  return { manifest: { base: id.base, rev: id.rev, commit: id.commit, file: m.file, sha256: m.sha256, size: m.size } };
}

/*
 * A file name inside the server directory: plain characters in plain
 * segments, no leading dot (.update, .previous and the like are the updater's
 * own) and no way out of the directory.
 */
function safeRelPath(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 200) return false;
  return /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/.test(rel);
}

/* The names `tar -tf` lists for the bundle, each under BUNDLE_TOP. */
function checkListing(names) {
  var seen = 0;
  for (var i = 0; i < names.length; i++) {
    var n = names[i].replace(/^\.\//, '').replace(/\/+$/, '');
    if (!n) continue;
    if (n !== BUNDLE_TOP && n.indexOf(BUNDLE_TOP + '/') !== 0) return 'the bundle lists ' + n + ' outside its directory';
    if (n !== BUNDLE_TOP && !safeRelPath(n.slice(BUNDLE_TOP.length + 1))) return 'the bundle lists an unsafe name: ' + n;
    seen++;
  }
  return seen ? null : 'the bundle is empty';
}

/*
 * `tar -tvf` lines, one per entry: only plain files and directories ('-' and
 * 'd' in the first column). A link entry could redirect a later file outside
 * the directory, which the names alone would not show.
 */
function checkTypes(lines, expected) {
  if (lines.length !== expected) return 'the bundle listing is not consistent';
  for (var i = 0; i < lines.length; i++) {
    var c = lines[i].charAt(0);
    if (c !== '-' && c !== 'd') return 'the bundle holds something that is not a plain file';
  }
  return null;
}

/*
 * The files of an unpacked bundle, as relative paths. Only regular files and
 * directories are accepted, which keeps links out; `error` says what was not.
 */
function walkBundle(dir) {
  var files = [], error = null;
  (function walk(rel) {
    var names = fs.readdirSync(path.join(dir, rel));
    for (var i = 0; i < names.length && !error; i++) {
      var r = rel ? rel + '/' + names[i] : names[i];
      if (!safeRelPath(r)) { error = 'unsafe name in the bundle: ' + r; return; }
      var st = fs.lstatSync(path.join(dir, r));
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) files.push(r);
      else error = 'the bundle holds something that is not a plain file: ' + r;
    }
  })('');
  return error ? { error: error } : { files: files };
}

module.exports = {
  PERSONAL_REPO: PERSONAL_REPO,
  PERSONAL_MANIFEST_URL: PERSONAL_MANIFEST_URL,
  PERSONAL_DOWNLOAD: PERSONAL_DOWNLOAD,
  PERSONAL_RELEASES: PERSONAL_RELEASES,
  PERSONAL_FILE: PERSONAL_FILE,
  IDENTITY_FILE: IDENTITY_FILE,
  BUNDLE_TOP: BUNDLE_TOP,
  MAX_BUNDLE_BYTES: MAX_BUNDLE_BYTES,
  idString: idString,
  tagOf: tagOf,
  bundleName: bundleName,
  newer: newer,
  validIdentity: validIdentity,
  readIdentity: readIdentity,
  displayOf: displayOf,
  parseManifest: parseManifest,
  safeRelPath: safeRelPath,
  checkListing: checkListing,
  checkTypes: checkTypes,
  walkBundle: walkBundle
};
