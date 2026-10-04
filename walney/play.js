// The playback edition: a looping tour of the Sandscale dune top, no panel.
//  camera  low in the marram for a while, a slow rise to ~25 m, a hold, a slow descent, turning a full circle
//  clock   a whole summer day every 8 minutes, so dawn, noon, dusk and the night lights come round
//  tide    twice a day, as on this coast; cumulus and overcast drift up and down at random
// Sound (after a tap: browsers keep pages silent until then) is procedural, as everything else:
// wind hiss following the gusts, a surf roar breathing with the waves, a little high air.
const ease=x=>x<0?0:x>1?1:x*x*(3-2*x);

export function tour(t){
 // camera: low 0-35 s, rise 35-65, high 65-110, descend 110-140, low 140-160   (160 s loop)
 const c=t%160,lift=c<35?0:c<65?ease((c-35)/30):c<110?1:c<140?1-ease((c-110)/30):0;
 const eye=1.6+lift*24;
 // a full slow turn every 4 minutes (Black Combe, the estuary, the shore and the sea), with a sway
 const heading=(334.7+t*360/240+Math.sin(t*2*Math.PI/37)*12+360)%360;
 const pitch=-1.5-lift*7+Math.sin(t*.13)*1.5;
 // a day every 8 minutes, starting mid-morning; the tide twice a day (12 h 25 min), as here
 const DAY=480,time=(9+t/DAY*24)%24;
 const tide=.75+Math.sin(t*2*Math.PI/(DAY*12.42/24))*3.4;
 // weather drifting at random: slow, overlapping cycles that never quite repeat
 const w=(a,b,c)=>Math.sin(t*2*Math.PI/a)*.5+Math.sin(t*2*Math.PI/b+1.7)*.3+Math.sin(t*2*Math.PI/c+4.1)*.2;
 const clouds=Math.min(1,Math.max(0,.4+.45*w(173,97,61)));
 const overcast=Math.min(.75,Math.max(0,(w(311,203,127)-.25)*1.3));   // mostly fair, sometimes clouding over
 return {eye,heading,pitch,time,tide,clouds,overcast};
}

export function createSound(look){
 const ctx=new AudioContext(),out=ctx.createGain();out.gain.value=0;out.connect(ctx.destination);
 const noise=(sec,color)=>{                                   // a looping noise bed: white, pink or brown
  const n=ctx.sampleRate*sec,buf=ctx.createBuffer(2,n,ctx.sampleRate);
  for(let ch=0;ch<2;ch++){const d=buf.getChannelData(ch);let b0=0,b1=0,b2=0,last=0;
   for(let i=0;i<n;i++){const w=Math.random()*2-1;
    if(color==='brown'){last=(last+.02*w)/1.02;d[i]=last*3.5;}
    else if(color==='pink'){b0=.997*b0+w*.029591;b1=.985*b1+w*.032534;b2=.95*b2+w*.048056;d[i]=(b0+b1+b2+w*.1848)*.5;}
    else d[i]=w*.4;}}
  const s=ctx.createBufferSource();s.buffer=buf;s.loop=true;return s;
 };
 const bed=(color,type,freq,q,gain)=>{const s=noise(6,color),f=ctx.createBiquadFilter(),g=ctx.createGain();f.type=type;f.frequency.value=freq;f.Q.value=q;g.gain.value=gain;s.connect(f).connect(g).connect(out);s.start();return {f,g};};
 const surf=bed('brown','lowpass',420,.4,.0);        // the far surf roar
 const wash=bed('pink','bandpass',1400,.6,.0);       // foam and swash hiss
 const wind=bed('pink','bandpass',600,.8,.0);        // wind through the marram
 const air=bed('white','highpass',5200,.5,.0);       // high air
 out.gain.linearRampToValueAtTime(.9,ctx.currentTime+3);
 const update=(t,state)=>{
  const now=ctx.currentTime,k=.25;
  const U=look.U,ws=state.wind/8;
  // gusts: the same slow field the grass bends in, sampled at the listener
  const gust=.5+.5*Math.sin(t*.37)*Math.sin(t*.113+1.3);
  // waves arrive every ~9 s; louder when the tide is high and the water near
  const swell=.55+.45*Math.pow(.5+.5*Math.sin(t*2*Math.PI/9),3);
  const near=Math.min(1,Math.max(0,(state.tide+3)/7));
  const high=Math.max(0,1-state.eye/60);                       // up in the air, the grass falls quiet
  surf.g.gain.setTargetAtTime((.35+.4*near)*swell*U.swell.value,now,k);
  wash.g.gain.setTargetAtTime(.05*near*swell,now,k);
  wind.g.gain.setTargetAtTime((.06+.12*gust*ws)*(.4+.6*high),now,k);
  wind.f.frequency.setTargetAtTime(420+380*gust*ws,now,k);
  air.g.gain.setTargetAtTime(.012*ws*(.5+gust),now,k);
 };
 return {ctx,update};
}
