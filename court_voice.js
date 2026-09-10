/* Opt-in, bounded 8 kHz radio voice. Godot routes every packet by authoritative proximity. */
(() => {
  'use strict';
  let mode="ptt", focused=true;
  let loaded=false, sent=0, received=0;
  let context, stream, node, source, pending = [], enabled = false, held = false;
  let active = false, heartbeat = 0, epoch = 0, status = 'Microphone off', muted = false;
  const speakers = new Map(), silenced = new Set();
  const processor = `class RadioCapture extends AudioWorkletProcessor {
    constructor(){super();this.on=false;this.phase=0;this.sum=0;this.n=0;this.bytes=[];
      this.port.onmessage=e=>{this.on=e.data;this.bytes=[];this.sum=0;this.n=0;};}
    process(inputs){const a=inputs[0]?.[0];if(!a||!this.on)return true;
      for(const x of a){this.sum+=x;this.n++;this.phase+=8000;
        if(this.phase>=sampleRate){this.phase-=sampleRate;
          this.bytes.push(Math.round(128+127*Math.max(-1,Math.min(1,this.sum/this.n))));this.sum=0;this.n=0;
          if(this.bytes.length===800){this.port.postMessage(new Uint8Array(this.bytes));this.bytes=[];}}}return true;}}
    registerProcessor('court-radio',RadioCapture);`;
  function transmitting(){return enabled && (mode==="open" || held) && focused && active && document.visibilityState==='visible' && performance.now()-heartbeat<400;}
  function gate(){const on=transmitting();if(node && node._on!==on){node._on=on;node.port.postMessage(on);}if(stream)for(const t of stream.getTracks())t.enabled=on;if(!on)pending=[];}
  async function audio(){if(!context)context=new AudioContext();await context.resume();return context;}
  function clearPlayback(){for(const s of speakers.values()){for(const n of s.nodes){try{n.stop();}catch(_){}}s.nodes.clear();s.next=0;}}
  async function enable(){const token=++epoch;status='Requesting microphone…';
    try{const ctx=await audio();const mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if(token!==epoch){mic.getTracks().forEach(t=>t.stop());return;}
      stream=mic;stream.getTracks().forEach(t=>t.enabled=false);
      const url=URL.createObjectURL(new Blob([processor],{type:'text/javascript'}));
      try{if(!loaded){await ctx.audioWorklet.addModule(url);loaded=true;}}finally{URL.revokeObjectURL(url);}
      if(token!==epoch)return;
      source=ctx.createMediaStreamSource(stream);node=new AudioWorkletNode(ctx,'court-radio');
      const high=ctx.createBiquadFilter();high.type='highpass';high.frequency.value=280;
      const low=ctx.createBiquadFilter();low.type='lowpass';low.frequency.value=3100;
      source.connect(high).connect(low).connect(node);const silence=ctx.createGain();silence.gain.value=0;node.connect(silence).connect(ctx.destination);
      node.port.onmessage=e=>{if(!transmitting())return;sent++;pending.push(btoa(String.fromCharCode(...e.data)));if(pending.length>3)pending.shift();};
      enabled=true;status='Microphone enabled · nearby players on BOTH teams hear you';gate();
    }catch(e){disable();status=e.name==='NotAllowedError'?'Microphone permission denied · enable it in browser settings':'Microphone unavailable: '+e.name;}}
  function disable(){epoch++;enabled=false;held=false;pending=[];if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;if(node)node.disconnect();if(source)source.disconnect();node=null;source=null;status='Microphone off';}
  function play(packet){if(!context || muted || !active || silenced.has(packet.slot) || !Number.isInteger(packet.slot) || packet.slot<0 || packet.slot>3)return;
    let bytes;try{bytes=atob(packet.audio);}catch(_){return;}if(bytes.length!==800)return;
    let s=speakers.get(packet.slot);if(!s){const gain=context.createGain(),filter=context.createBiquadFilter(),pan=context.createStereoPanner();
      filter.type='lowpass';filter.frequency.value=3000;gain.connect(filter).connect(pan).connect(context.destination);s={gain,filter,pan,next:0,nodes:new Set()};speakers.set(packet.slot,s);}
    if(s.next>context.currentTime+.3)return;
    s.gain.gain.value=Math.max(0,Math.min(.8,Number(packet.gain)||0));s.filter.frequency.value=packet.cover?1300:3000;s.pan.pan.value=Math.max(-.8,Math.min(.8,Number(packet.pan)||0));
    received++;const buffer=context.createBuffer(1,800,8000),out=buffer.getChannelData(0);
    for(let i=0;i<800;i++)out[i]=(bytes.charCodeAt(i)-128)/128;
    // Very short edge ramps suppress packet clicks without a fake radio hiss.
    for(let i=0;i<12;i++){out[i]*=i/12;out[799-i]*=i/12;}
    const n=context.createBufferSource();n.buffer=buffer;n.connect(s.gain);s.nodes.add(n);n.onended=()=>{n.disconnect();s.nodes.delete(n);};
    const start=Math.max(context.currentTime+.015,s.next);n.start(start);s.next=start+.1;
  }
  window.CourtVoice=Object.freeze({enable,disable,unlock:audio,
    setMode(value){mode=value==="open"?"open":"ptt";held=false;gate();},
    tick(value,pressed){held=!!pressed;active=!!value;heartbeat=performance.now();gate();if(!active)clearPlayback();},
    take(){const result=pending;pending=[];return JSON.stringify(result);},play(text){try{play(JSON.parse(text));}catch(_){}},
    mute(value){muted=!!value;if(muted)clearPlayback();},muteSeat(slot,value){if(value)silenced.add(slot);else silenced.delete(slot);clearPlayback();},
    status(){return JSON.stringify({mode,sent,received,enabled,transmitting:transmitting(),muted,message:status,queued:pending.length,playing:[...speakers.values()].reduce((a,s)=>a+s.nodes.size,0)});}});
  window.addEventListener('pointerdown',()=>{if(context)context.resume().catch(()=>{});});
  window.addEventListener('focus',()=>{focused=true;});
  window.addEventListener('blur',()=>{focused=false;held=false;gate();clearPlayback();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){held=false;gate();clearPlayback();}});
  window.addEventListener('pagehide',disable);setInterval(gate,150);
})();
