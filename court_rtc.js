/* King of the Court browser transport. Game rules and validation stay in Godot. */
(() => {
  'use strict';
  let peer, host = false, phase = 0, error = '', next = 1, roomKey = '';
  let pending = [], connections = new Map(), wakeLock;
  const MAX_PACKET = 1048576, MAX_QUEUE = 2097152;
  const options = {secure: true, debug: 0, config: {iceServers: [
    {urls: 'stun:stun.l.google.com:19302'}, {urls: 'stun:stun.cloudflare.com:3478'}
  ]}};
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
    const timer = setTimeout(() => close(id, 'Could not reach this browser. Try another network or the desktop host.'),25000);
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
    const previous = peer; peer = null;
    if (previous) previous.destroy();
    if (wakeLock) wakeLock.release().catch(() => {});
    connections.clear(); pending = []; phase = 0; error = '';
  }
  function create(isHost) {
    stop(); host = isHost;
    if (typeof Peer !== 'function' || !window.RTCPeerConnection || !crypto.randomUUID) {
      phase = 3; error = 'This browser cannot create online rooms. Use current desktop Chrome or Firefox.';
      return;
    }
    peer = new Peer('court-' + crypto.randomUUID(), options);
    const source = peer;
    peer.on('open', () => {if (peer !== source) return; phase = 1; error = ''; awake();});
    peer.on('connection', conn => {
      if (peer !== source || !host || [...connections.values()].filter(c => c.state !== 3).length >= 4) {conn.close(); return;}
      attach(conn);
    });
    peer.on('disconnected', () => {
      if (peer !== source) return;
      phase = 0;
      error = 'Room discovery disconnected. Existing play can continue; reconnect to accept a friend.';
    });
    peer.on('error', event => {
      if (peer !== source) return;
      const missing = event.type === 'peer-unavailable';
      error = missing ? 'This room is closed. Ask the host to create a new room and send its invite.' :
        'Room connection unavailable. Check your internet, then reconnect.';
      if (!host || peer.destroyed) phase = 3;
      if (!host) for (const id of connections.keys()) close(id,error);
    });
    peer.on('close', () => {if (peer === source) phase = 3;});
  }
  window.CourtRTC = Object.freeze({
    startHost() {
      create(true);
      roomKey = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2,'0')).join('');
      return roomKey;
    },
    startGuest(id) {
      create(false);
      if (!peer || phase === 3) return 0;
      const source = peer, connection = next++;
      connections.set(connection,{conn:null,state:0,reason:'',packets:[],bytes:0,input:'',snapshot:''});
      source.once('open', () => {
        if (peer === source && connections.get(connection)?.state === 0)
          attach(source.connect(id,{serialization:'raw',reliable:true,label:'court-v1'}),connection);
      });
      return connection;
    },
    status() {return JSON.stringify({state:phase,id:peer?.id || '',error,channels:[...connections.values()].map(c=>({state:c.state,ice:c.conn?.peerConnection?.iceConnectionState || 'pending',local:!!c.conn?.peerConnection?.localDescription,remote:!!c.conn?.peerConnection?.remoteDescription}))});},
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
