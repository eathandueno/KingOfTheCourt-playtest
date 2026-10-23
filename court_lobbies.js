/* Ephemeral public room directory. Uses the game's PeerServer and WebRTC;
   no game source, account credentials, or saved maps enter the directory. */
(() => {
  'use strict';
  const TTL=20000, PERIOD=4000, MAX_ROOMS=64;
  let client, broker, link, timer, options, directoryId='', running=false;
  let rooms=[], listing=null, status='Closed', attempt=0, lastMessage=0;
  const members=new Map();
  const send=(connection,data)=>{
    if(!connection?.open || (connection.dataChannel?.bufferedAmount||0)>32768) return;
    try {connection.send(JSON.stringify(data));} catch (_) {connection.close();}
  };
  const clean=value=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,64):'';
  function validate(value) {
    if(!value || typeof value!=='object' || !/^court-[a-zA-Z0-9_-]{1,90}$/.test(value.peer) ||
       !/^[a-f0-9]{48}$/.test(value.key) || !Number.isInteger(value.capacity) || value.capacity<2 || value.capacity>10 ||
       !Number.isInteger(value.humans) || value.humans<1 || value.humans>value.capacity) return null;
    return {peer:value.peer,key:value.key,name:clean(value.name)||'King of the Court',map:clean(value.map),
      mode:clean(value.mode),humans:value.humans,capacity:value.capacity,bots:Math.max(0,Math.min(value.capacity-value.humans,Number(value.bots)||0))};
  }
  function connect() {
    if(!running || !client?.open || link?.open) return;
    link?.close(); const connection=client.connect(directoryId,{serialization:'raw',reliable:true,label:'court-directory'});
    link=connection;
    connection.on('open',()=>{if(link!==connection)return;status='Connected';lastMessage=Date.now();send(connection,{room:listing});});
    connection.on('data',text=>{
      if(link!==connection || typeof text!=='string' || text.length>32768) return;
      try {const data=JSON.parse(text);if(!Array.isArray(data.rooms))return;
        rooms=data.rooms.slice(0,MAX_ROOMS).map(validate).filter(Boolean);lastMessage=Date.now();status='Connected';
      } catch (_) {}
    });
    connection.on('error',()=>{if(link===connection){link=null;rooms=[];status='Reconnecting…';}});
    connection.on('close',()=>{if(link===connection){link=null;rooms=[];status='Reconnecting…';}});
  }
  function elect() {
    if(!running || broker || !options) return;
    const candidate=new Peer(directoryId,options);broker=candidate;
    candidate.on('open',()=>{if(!running || broker!==candidate)return;connect();});
    candidate.on('connection',connection=>{
      if(members.size>=MAX_ROOMS){connection.close();return;}
      const entry={connection,room:null,seen:Date.now(),received:Date.now(),budget:16};members.set(connection,entry);
      connection.on('data',text=>{
        const now=Date.now();
        entry.budget=Math.min(16,entry.budget+(now-entry.received)/250)-1;
        if(typeof text!=='string' || text.length>2048 || entry.budget<0){connection.close();return;}
        entry.received=now;entry.seen=now;
        try {entry.room=validate(JSON.parse(text).room);} catch (_) {connection.close();}
      });
      connection.on('close',()=>members.delete(connection));
      connection.on('error',()=>members.delete(connection));
    });
    const lost=()=>{if(broker!==candidate)return;broker=null;candidate.destroy();members.clear();};
    candidate.on('error',lost);candidate.on('disconnected',lost);candidate.on('close',lost);
  }
  function tick() {
    if(!running)return;
    const now=Date.now();
    if(broker?.open){
      for(const [connection,entry] of members)if(now-entry.seen>TTL){members.delete(connection);connection.close();}
      const found=new Map();
      for(const entry of members.values())if(entry.room)found.set(entry.room.peer,entry.room);
      const packet={rooms:[...found.values()].slice(0,MAX_ROOMS)};
      for(const connection of members.keys())send(connection,packet);
    }
    if(link?.open && now-lastMessage<TTL)send(link,{room:listing});
    else {rooms=[];status='Looking for lobbies…';connect();elect();}
  }
  function stop() {
    running=false;attempt++;clearInterval(timer);timer=null;listing=null;rooms=[];
    const oldLink=link;link=null;oldLink?.close();
    const oldClient=client;client=null;oldClient?.destroy();
    const oldBroker=broker;broker=null;oldBroker?.destroy();members.clear();status='Closed';
  }
  window.CourtLobbies=Object.freeze({
    async start(protocol) {
      if(running)return;running=true;const current=++attempt;status='Looking for lobbies…';
      options=await CourtRTC.directoryOptions();if(!running||attempt!==current)return;
      // Tests use isolated namespaces so they never announce into public rooms.
      const suffix=clean(window.COURT_DIRECTORY_NAMESPACE||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,24);
      directoryId='kotc-public-v'+Number(protocol)+(suffix?'-'+suffix:'');
      client=new Peer('court-directory-'+crypto.randomUUID(),options);
      client.on('open',()=>{connect();elect();});
      client.on('error',()=>{status='Directory unavailable; friend invites still work.';rooms=[];});
      client.on('disconnected',()=>{rooms=[];status='Reconnecting…';if(running&&!client.destroyed)client.reconnect();});
      timer=setInterval(tick,PERIOD);
    },
    advertise(text) {try {listing=validate(JSON.parse(text));}catch(_){listing=null;}},
    withdraw() {listing=null;send(link,{room:null});},
    snapshot() {return JSON.stringify({status,rooms});},
    stop
  });
  window.addEventListener('pagehide',stop);
})();
