/* King of the Court browser transport. Game rules and validation stay in Godot. */
(() => {
  'use strict';
  const MAX_PACKET = 1048576, MAX_QUEUE = 2097152;
  const DEFAULT_ICE_SERVERS = [
    {urls: 'stun:stun.l.google.com:19302'}, {urls: 'stun:stun.cloudflare.com:3478'}
  ];
  let peer, host = false, phase = 0, error = '', next = 1, roomKey = '';
  let pending = [], connections = new Map(), wakeLock, generation = 0, openCallbacks = [];
  let activeOptions = {secure: true, debug: 0, config: {iceServers: DEFAULT_ICE_SERVERS.map(server => ({...server}))}};
  let configSource = 'default STUN', configWarning = '', configLoading = false, relayEnabled = false;
  const configReady = loadConfig();

  function objectLike(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
  }
  function cleanString(value, limit = 256) {
    return typeof value === 'string' ? value.trim().slice(0, limit) : '';
  }
  function cleanUrl(value) {
    const url = cleanString(value, 512);
    return /^(stun|stuns|turn|turns):/i.test(url) ? url : '';
  }
  function sanitizeIceServer(server) {
    if (!objectLike(server)) return null;
    const rawUrls = Array.isArray(server.urls) ? server.urls : [server.urls];
    const urls = rawUrls.map(cleanUrl).filter(Boolean).slice(0, 6);
    if (!urls.length) return null;
    const cleaned = {urls: urls.length === 1 ? urls[0] : urls};
    for (const key of ['username', 'credential', 'credentialType']) {
      const value = cleanString(server[key]);
      if (value) cleaned[key] = value;
    }
    return cleaned;
  }
  function hasTurn(server) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some(url => /^turns?:/i.test(String(url)));
  }
  function buildOptions(raw) {
    const config = objectLike(raw) ? raw : {};
    const custom = (Array.isArray(config.iceServers) ? config.iceServers : []).map(sanitizeIceServer).filter(Boolean);
    const iceServers = config.replaceDefaultIceServers ? custom : DEFAULT_ICE_SERVERS.map(server => ({...server})).concat(custom);
    const options = {secure: true, debug: 0, config: {iceServers}};
    const peerConfig = objectLike(config.peer) ? config.peer : {};
    for (const key of ['host', 'path', 'key']) {
      const value = cleanString(peerConfig[key]);
      if (value) options[key] = value;
    }
    const port = Number(peerConfig.port);
    if (Number.isInteger(port) && port > 0 && port <= 65535) options.port = port;
    if (typeof peerConfig.secure === 'boolean') options.secure = peerConfig.secure;
    if (Number.isFinite(Number(peerConfig.debug))) options.debug = Math.max(0, Math.min(3, Math.floor(Number(peerConfig.debug))));
    const policy = cleanString(config.iceTransportPolicy || (objectLike(config.rtc) ? config.rtc.iceTransportPolicy : ''));
    if (['all', 'relay'].includes(policy)) options.config.iceTransportPolicy = policy;
    const pool = Number(objectLike(config.rtc) ? config.rtc.iceCandidatePoolSize : NaN);
    if (Number.isInteger(pool) && pool >= 0 && pool <= 8) options.config.iceCandidatePoolSize = pool;
    return options;
  }
  function applyConfig(raw, source) {
    try {
      activeOptions = buildOptions(raw);
      relayEnabled = activeOptions.config.iceServers.some(hasTurn);
      configSource = source;
      configWarning = '';
    } catch (event) {
      configWarning = 'RTC relay config was ignored; using default STUN.';
      console.warn(configWarning, event);
    }
  }
  function readInlineConfig() {
    let inline = window.COURT_RTC_CONFIG;
    if (typeof inline === 'string' && inline.trim()) inline = JSON.parse(inline);
    if (!inline && document.getElementById) {
      const element = document.getElementById('court-rtc-config');
      if (element?.textContent?.trim()) inline = JSON.parse(element.textContent);
    }
    if (!inline) return false;
    applyConfig(inline, 'inline config');
    return true;
  }
  function loadConfig() {
    let inlineReady = false;
    try { inlineReady = readInlineConfig(); } catch (event) {
      configWarning = 'RTC relay config was ignored; using default STUN.';
      console.warn(configWarning, event);
    }
    if (inlineReady || typeof fetch !== 'function' || typeof location === 'undefined') return null;
    const configuredUrl = cleanString(window.COURT_RTC_CONFIG_URL, 512);
    const url = configuredUrl || new URL('court_rtc_config.json', location.href).href;
    configLoading = true;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 1500) : null;
    return fetch(url, {cache: 'no-store', signal: controller?.signal}).then(response => {
      if (response.ok) return response.json().then(json => applyConfig(json, configuredUrl ? configuredUrl : 'court_rtc_config.json'));
    }).catch(event => {
      if (event?.name !== 'AbortError') {
        configWarning = 'RTC relay config could not be loaded; using default STUN.';
        console.warn(configWarning, event);
      }
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
      configLoading = false;
    });
  }
  function reachabilityMessage() {
    return relayEnabled ?
      'Could not reach this browser through WebRTC. Reconnect or ask the host for a fresh room.' :
      'Could not reach this browser. This deployment has no TURN relay, so some networks need the desktop host.';
  }
  function failStartup(message) {
    phase = 3; error = message;
    for (const id of connections.keys()) close(id, message);
  }
  function close(id, reason = '') {
    const entry = connections.get(id);
    if (!entry || entry.state === 3) return;
    entry.state = 3; entry.reason = String(reason).slice(0,180);
    if (entry.conn?.open && reason) {
      try { entry.conn.send(JSON.stringify({courtTransportClose: entry.reason})); } catch (_) {}
    }
    if (entry.conn) setTimeout(() => entry.conn.close(), 80);
  }
  function attach(conn, assigned = 0) {
    for (const [oldId, old] of connections) if (old.state === 3) connections.delete(oldId);
    const id = assigned || next++;
    const entry = {conn, state: 0, reason: '', packets: [], bytes: 0, input: '', snapshot: '', budget:480, seen:performance.now()};
    connections.set(id, entry);
    const timer = setTimeout(() => close(id, reachabilityMessage()),25000);
    conn.on('open', () => {
      clearTimeout(timer);
      if (entry.state === 3) {conn.close(); return;}
      entry.state = 1;
      if (host) pending.push(id);
    });
    conn.on('data', text => {
      if (entry.state !== 1) return;
      const now = performance.now();
      entry.budget = Math.min(480,entry.budget+(now-entry.seen)*.12)-1; entry.seen = now;
      if (typeof text !== 'string' || text.length > (host ? 4096 : MAX_PACKET)) {
        close(id,'Message limit exceeded'); return;
      }
      if (entry.budget < 0) {close(id,'Message limit exceeded'); return;}
      if (text.length < 300 && text.startsWith('{"courtTransportClose":')) {
        try {close(id, JSON.parse(text).courtTransportClose);} catch (_) {close(id,'Connection closed');}
        return;
      }
      // A stalled render must not queue seconds of stale motion. Keep reliable
      // control messages (especially welcome) separate from replaceable state.
      if (host) {
        let packet;
        try {packet = JSON.parse(text);} catch (_) {return;}
        if (packet?.type === 'input') {entry.input = text; return;}
      }
      if (!host && text.startsWith('{') && text.includes('"type":"state"')) {
        entry.snapshot = text; return;
      }
      entry.bytes += text.length;
      if (entry.bytes > MAX_QUEUE || entry.packets.length >= 64) {close(id,'Message limit exceeded'); return;}
      entry.packets.push(text);
    });
    conn.on('close', () => {clearTimeout(timer); entry.state = 3; entry.packets = []; entry.bytes = 0; entry.input = ''; entry.snapshot = '';});
    conn.on('error', () => close(id,'Connection interrupted. Reconnect to the room.'));
    return id;
  }
  async function awake() {
    if (!host || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
    const source = peer;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (host && peer === source) wakeLock = lock;
      else await lock.release();
    } catch (_) {}
  }
  function stop() {
    generation++;
    const previous = peer; peer = null;
    if (previous) previous.destroy();
    if (wakeLock) wakeLock.release().catch(() => {});
    connections.clear(); pending = []; openCallbacks = []; phase = 0; error = '';
  }
  function launchPeer(sourceSession) {
    if (sourceSession !== generation) return;
    if (typeof Peer !== 'function' || !window.RTCPeerConnection || !crypto.randomUUID) {
      failStartup('This browser cannot create online rooms. Use current desktop Chrome or Firefox.');
      return;
    }
    peer = new Peer('court-' + crypto.randomUUID(), activeOptions);
    const source = peer;
    peer.on('open', () => {
      if (peer !== source || sourceSession !== generation) return;
      phase = 1; error = ''; awake();
      const callbacks = openCallbacks; openCallbacks = [];
      for (const callback of callbacks) callback(source);
    });
    peer.on('connection', conn => {
      if (peer !== source || sourceSession !== generation || !host || [...connections.values()].filter(c => c.state !== 3).length >= 10) {conn.close(); return;}
      attach(conn);
    });
    peer.on('disconnected', () => {
      if (peer !== source || sourceSession !== generation) return;
      phase = 0;
      error = 'Room discovery disconnected. Existing play can continue; reconnect to accept a friend.';
    });
    peer.on('error', event => {
      if (peer !== source || sourceSession !== generation) return;
      const missing = event.type === 'peer-unavailable';
      error = missing ? 'This room is closed. Ask the host to create a new room and send its invite.' :
        'Room connection unavailable. Check your internet, then reconnect.';
      if (!host || peer.destroyed) phase = 3;
      if (!host) for (const id of connections.keys()) close(id,error);
    });
    peer.on('close', () => {if (peer === source && sourceSession === generation) phase = 3;});
  }
  function create(isHost) {
    stop(); host = isHost; error = configLoading ? 'Preparing online relay config...' : '';
    const sourceSession = generation;
    if (configReady && configLoading) configReady.then(() => launchPeer(sourceSession), () => launchPeer(sourceSession));
    else launchPeer(sourceSession);
  }
  window.CourtRTC = Object.freeze({
    startHost() {
      roomKey = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2,'0')).join('');
      create(true);
      return roomKey;
    },
    startGuest(id) {
      create(false);
      if (phase === 3) return 0;
      const sourceSession = generation, connection = next++;
      connections.set(connection,{conn:null,state:0,reason:'',packets:[],bytes:0,input:'',snapshot:''});
      openCallbacks.push(source => {
        if (sourceSession === generation && connections.get(connection)?.state === 0)
          attach(source.connect(cleanString(id, 96),{serialization:'raw',reliable:true,label:'court-v1'}),connection);
      });
      return connection;
    },
    status() {return JSON.stringify({state:phase,id:peer?.id || '',error,relay:relayEnabled,config:configSource,warning:configWarning,channels:[...connections.values()].map(c=>({state:c.state,ice:c.conn?.peerConnection?.iceConnectionState || 'pending',local:!!c.conn?.peerConnection?.localDescription,remote:!!c.conn?.peerConnection?.remoteDescription}))});},
    accept() {const ids = pending; pending = []; return JSON.stringify(ids);},
    poll(id) {
      const c = connections.get(id);
      if (!c) return JSON.stringify({state:3,reason:'Room disconnected',buffered:0,packets:[]});
      const packets = c.packets; c.packets = []; c.bytes = 0;
      if (c.input) {packets.push(c.input); c.input = '';}
      if (c.snapshot) {packets.push(c.snapshot); c.snapshot = '';}
      return JSON.stringify({state:c.state,reason:c.reason,buffered:c.conn?.dataChannel?.bufferedAmount || 0,packets});
    },
    send(id,text) {
      const c = connections.get(id);
      if (!c || c.state !== 1 || text.length > MAX_PACKET) return false;
      if ((c.conn.dataChannel?.bufferedAmount || 0) > 100000) return false;
      try {c.conn.send(text); return true;} catch (_) {close(id,'Connection interrupted'); return false;}
    },
    close,
    reconnect() {if (peer?.disconnected && !peer.destroyed) peer.reconnect();},
    stop
  });
  document.addEventListener('visibilitychange', awake);
  window.addEventListener('pagehide', stop);
})();
