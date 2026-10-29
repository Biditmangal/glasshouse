// The Audio tab: LG's sound settings and what the TV and its receiver report.
let audioState = null;
let audioTimer = null;
let audioRevision = 0;
// Paired Bluetooth audio devices: read on opening the tab and on Refresh, never polled.
let audioBt = null;
let audioBtRevision = 0;
let audioBtBusy = null;   // { address, action } while a connect or disconnect runs

function audioPolling(on) {
  clearTimeout(audioTimer);
  audioTimer = null;
  if (!on) return;
  audioTimer = setTimeout(() => loadAudio(true), 8000);
}

// As the page's other error banners (.err-note): what failed in bold, then why.
function audioError(message) {
  const el = q('audio-error');
  el.innerHTML = message ? `<b>${esc(t('audio.readFailed', 'The TV’s sound settings and audio readings could not be read.'))}</b>${esc(sentence(message))}` : '';
  el.hidden = !message;
}

async function audioRequest() {
  const res = await fetch(api('/api/audio?with=settings'), { cache: 'no-store' });
  const r = await res.json();
  if (!res.ok || !r || r.ok === false) throw new Error((r && r.error) || t('common.unknownError', 'unknown error'));
  return r;
}

// A poll (fromPoll true) leaves the Refresh button and any shown error alone.
async function loadAudio(fromPoll) {
  clearTimeout(audioTimer);
  audioTimer = null;
  const revision = ++audioRevision;
  const refresh = q('audio-refresh');
  if (fromPoll !== true) refresh.disabled = true;
  try {
    const st = await audioRequest();
    if (revision !== audioRevision) return;
    audioState = st;
    q('audio-readings').hidden = false;
    renderAudio();
    renderAudioSettings(st.lgSettings || []);
    if (fromPoll !== true) {
      audioError('');
      loadAudioBluetooth();
    }
  } catch (e) {
    if (revision === audioRevision) {
      audioState = null;
      q('audio-readings').hidden = true;
      q('audio-sound-head').hidden = true;
      q('audio-settings').innerHTML = '';
      audioError(e.message);
    }
  } finally {
    if (revision === audioRevision) {
      refresh.disabled = false;
      q('audio-readings').setAttribute('aria-busy', 'false');
      if (activeTab === 'audio') audioPolling(true);
    }
  }
}

function audioDeclaration(value) {
  return value === true ? t('audio.advertised', 'Advertised') :
    value === false ? t('audio.notAdvertised', 'Not advertised') : t('audio.unknown', 'Unknown');
}

function renderAudio() {
  const st = audioState;
  if (!st) return;
  const tv = st.tv;
  const receiver = st.receiver;
  const dts = tv.formats.find(f => f.id === 'dts');
  const summary = dts.advertised === true
    ? t('audio.dtsAdvertised', 'This TV advertises DTS')
    : dts.advertised === false ? t('audio.dtsNotAdvertised', 'This TV does not advertise DTS')
    : t('audio.dtsUnknown', 'DTS advertisement is unknown');
  if (q('audio-summary').textContent !== summary) q('audio-summary').textContent = summary;
  q('audio-identity').textContent = [st.identity.model, st.identity.firmware,
    tv.dtsDecoder === true ? t('audio.decoderPresent', 'LG DTS decoder present') :
      tv.dtsDecoder === false ? t('audio.decoderAbsent', 'LG DTS-core decoder not registered') : null].filter(Boolean).join(' · ');
  const noInput = t('audio.noInput', 'No audio reported');
  const source = st.live.input;
  const sourceText = source ? [source.codec, source.sampleRate ? (source.sampleRate / 1000) + ' kHz' : null].filter(Boolean).join(' · ') : noInput;
  const linkText = receiver.link === 'inactive' ? t('audio.linkInactive', 'No active ARC link') :
    receiver.link === 'unknown' ? t('audio.linkUnknown', 'Link unknown') : receiver.link;
  const item = (label, value, detail) => '<li><div class="audio-label">' + esc(label) + '</div><div class="audio-value">' + esc(value) + '</div>' +
    (detail ? '<div class="prot-desc">' + esc(detail) + '</div>' : '') + '</li>';
  const metadata = st.live.hdmi;
  const metadataText = metadata ? [t('audio.channels', '{count} channels', { count: metadata.channels }),
    metadata.sampleRate ? (metadata.sampleRate / 1000) + ' kHz' : null].filter(Boolean).join(' · ') : '';
  q('audio-path').innerHTML =
    item(t('audio.inputNow', 'Incoming audio'), sourceText, '') +
    (metadata ? item(t('audio.hdmiChannels', 'HDMI channel information'), metadataText,
      t('audio.hdmiMetadataHint', 'Channel metadata reported by the HDMI source. It can remain during a pause and does not confirm playback at the receiver.')) : '') +
    item(t('audio.outputNow', 'Sound output'), st.outputName || t('audio.unknown', 'Unknown'), st.live.output || '') +
    item(t('audio.receiverNow', 'Return channel'), linkText, receiver.name || '');
  q('audio-formats').innerHTML = tv.formats.map(f => '<tr><th scope="row">' + esc(f.name) + '</th>' +
    '<td class="' + (f.advertised === true ? 'audio-yes' : '') + '">' + esc(audioDeclaration(f.advertised)) + '</td>' +
    '<td class="' + (f.receiver === true ? 'audio-yes' : '') + '">' + esc(audioDeclaration(f.receiver)) + '</td></tr>').join('');
  q('audio-link-note').textContent = !receiver.formatsKnown
    ? t('audio.receiverUnknown', 'Receiver formats are unknown until an ARC/eARC receiver reports them. A connected HDMI device alone does not establish a working audio link.')
    : t('audio.receiverKnown', 'These are the receiver’s declarations. DTS-HD needs eARC; DTS:X is not established by a DTS-HD entry. Receiver lock still needs a playback check.');
  if (tv.input) q('audio-link-note').textContent += ' ' + t('audio.inputDeclaration', 'The TV column describes HDMI {port}.', { port: tv.input });
  const declarations = tv.playbackDeclarations;
  const playbackNames = { AC3: 'Dolby Digital', EAC3: 'Dolby Digital Plus', DTSH: 'DTS-HD', DTSE: 'DTS Express', WMAP: 'WMA Pro', WMAL: 'WMA Lossless', OPUS: 'Opus' };
  q('audio-playback').innerHTML = declarations === null
    ? '<p class="sub">' + esc(t('audio.playbackUnknown', 'The TV did not expose a playback declaration list.')) + '</p>'
    : declarations.map(f => '<div><span>' + esc(playbackNames[f.name] || f.name) + '</span><span>' + esc(f.channels
      ? t('audio.channels', '{count} channels', { count: f.channels }) : t('audio.unknown', 'Unknown')) + '</span></div>').join('');
}

// The sound rows, then each input's audio format, live from the same read.
function renderAudioSettings(rows) {
  const focused = document.activeElement && document.activeElement.closest('#audio-settings [data-lgs]');
  const focusedId = focused && focused.dataset.lgs;
  const selected = rows.filter(r => r.section === 'sound').concat(rows.filter(r => r.column === 'audioFormat'));
  q('audio-sound-head').hidden = !selected.length;
  q('audio-settings').innerHTML = selected.map(r =>
    lgsRow(r).replace(/<(select|button|input)\b/, '<$1 aria-label="' + esc(r.title) + '"')).join('');
  if (!audioState.writable) q('audio-settings').querySelectorAll('button,select,input').forEach(el => { el.disabled = true; });
  if (focusedId) {
    const next = q('audio-settings').querySelector('[data-lgs="' + focusedId + '"]');
    if (next && !next.disabled) next.focus({ preventScroll: true });
  }
}

function audioBtError(message) {
  const el = q('audio-bt-error');
  el.innerHTML = message ? `<b>${esc(t('audio.bt.failed', 'The Bluetooth request did not work.'))}</b>${esc(sentence(message))}` : '';
  el.hidden = !message;
}

async function loadAudioBluetooth() {
  if (audioBtBusy) return;
  const revision = ++audioBtRevision;
  const refresh = q('audio-bt-refresh');
  refresh.disabled = true;
  q('audio-bt-list').setAttribute('aria-busy', 'true');
  q('audio-bt-note').textContent = '';
  try {
    const res = await fetch(api('/api/audio/bluetooth'), { cache: 'no-store' });
    const r = await res.json();
    if (revision !== audioBtRevision) return;
    if (!res.ok || !r || r.ok === false) throw new Error((r && r.error) || t('common.unknownError', 'unknown error'));
    audioBt = r;
    audioBtError('');
  } catch (e) {
    if (revision !== audioBtRevision) return;
    audioBt = { available: true, writable: false, devices: [] };
    audioBtError(e.message);
  }
  refresh.disabled = false;
  q('audio-bt-list').setAttribute('aria-busy', 'false');
  renderAudioBluetooth();
}

function audioBtStateLabel(state) {
  return state === 'connected' ? t('audio.bt.connected', 'Connected')
    : state === 'disconnected' ? t('audio.bt.disconnected', 'Not connected')
    : t('audio.unknown', 'Unknown');
}

function renderAudioBluetooth() {
  if (!audioBt) return;
  // A TV without the service has nothing to show; one whose read failed keeps the section for its error.
  q('audio-bt').hidden = audioBt.available === false;
  const focused = document.activeElement && document.activeElement.closest('#audio-bt-list [data-bt-address]');
  const focusedAddress = focused && focused.dataset.btAddress;
  const writable = audioBt.writable === true;
  q('audio-bt-list').innerHTML = audioBt.devices.map(d => {
    const name = d.name || t('audio.bt.unnamed', 'Unnamed device');
    const doing = audioBtBusy && audioBtBusy.address === d.address ? audioBtBusy.action : null;
    const action = d.state === 'connected' ? 'disconnect' : d.state === 'disconnected' ? 'connect' : null;
    const label = doing === 'connect' ? t('audio.bt.connecting', 'Connecting…')
      : doing === 'disconnect' ? t('audio.bt.disconnecting', 'Disconnecting…')
      : action === 'connect' ? t('audio.bt.connect', 'Connect') : t('audio.bt.disconnect', 'Disconnect');
    const button = action
      ? `<button type="button" class="pill ${doing ? 'busy' : action === 'connect' ? 'good' : 'idle'}" data-bt-address="${esc(d.address)}" data-bt-action="${action}"` +
        ` aria-label="${esc(t('audio.bt.actionFor', '{action}: {name}', { action: label, name }))}"` +
        `${writable && !audioBtBusy ? '' : ' disabled'}>${esc(label)}</button>`
      : '';
    return '<div class="prot-row"><div class="prot-main"><div class="prot-title">' + esc(name) + '</div>' +
      '<div class="prot-desc">' + esc(audioBtStateLabel(d.state)) + '</div></div>' +
      '<div class="prot-status">' + button + '</div></div>';
  }).join('') || (audioBt.available === false || q('audio-bt-error').hidden === false ? '' :
    '<div class="prot-row"><div class="prot-main"><div class="prot-desc">' +
    esc(t('audio.bt.none', 'No paired Bluetooth audio devices.')) + '</div></div></div>');
  if (focusedAddress) {
    const next = q('audio-bt-list').querySelector('[data-bt-address="' + focusedAddress + '"]');
    if (next && !next.disabled) next.focus({ preventScroll: true });
  }
}

// The TV's reply is not taken as the result: the server reads the list again,
// and the state in it is what the row shows.
async function audioBluetoothAct(address, action) {
  if (audioBtBusy) return;
  const other = audioBt.devices.find(d => d.address !== address && d.state === 'connected');
  if (action === 'connect' && other && !confirm(t('audio.bt.switchConfirm',
    'Connecting another device may disconnect {name} and change the sound output. Continue?',
    { name: other.name || t('audio.bt.unnamed', 'Unnamed device') }))) return;
  audioBtBusy = { address, action };
  ++audioBtRevision;  // Ignore any list read that started before this action.
  q('audio-bt-refresh').disabled = true;
  q('audio-bt-list').setAttribute('aria-busy', 'true');
  audioBtError('');
  q('audio-bt-note').textContent = '';
  renderAudioBluetooth();
  let error = null;
  let note = '';
  try {
    const res = await fetch(api('/api/audio/bluetooth'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, address })
    });
    const r = await res.json();
    if (r && Array.isArray(r.devices)) audioBt.devices = r.devices;
    if (!r || !r.ok) error = (r && r.error) || t('common.unknownError', 'unknown error');
    else if (r.pending && !r.accepted) {
      note = t('audio.bt.unconfirmed', 'The TV has not confirmed the request. Refresh to check the connection before trying again.');
    } else if (!r.settled) {
      const d = audioBt.devices.find(x => x.address === address);
      note = t('audio.bt.notYet', 'The TV took the request but still reports {name} as {state}. Refresh to check again.',
        { name: (d && d.name) || t('audio.bt.unnamed', 'Unnamed device'), state: audioBtStateLabel(d && d.state).toLowerCase() });
    }
  } catch (e) {
    error = e.message;
  }
  audioBtBusy = null;
  q('audio-bt-refresh').disabled = false;
  q('audio-bt-list').setAttribute('aria-busy', 'false');
  if (error) audioBtError(error);
  q('audio-bt-note').textContent = note;
  renderAudioBluetooth();
  const next = q('audio-bt-list').querySelector('[data-bt-address="' + address + '"]');
  if (next && !next.disabled) next.focus({ preventScroll: true });
  // A connection can change the sound output shown above.
  loadAudio(true);
}

document.addEventListener('click', e => {
  const b = e.target.closest('#audio-bt-list button[data-bt-action]');
  if (b && !b.disabled) audioBluetoothAct(b.dataset.btAddress, b.dataset.btAction);
});
