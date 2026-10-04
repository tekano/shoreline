// The playback edition: a looping tour of the Sandscale dune top, no panel.
//  camera  low in the marram, a slow rise to ~25 m, a hold, a slow descent, panning all the while
//  clock   a whole summer day every 8 minutes, so dawn, noon, dusk and the night lights come round
//  tide    in and out every 3 minutes, on its own cycle, so no two passes look the same
// Sound (after a tap: browsers keep pages silent until then) is procedural, as everything else:
// wind hiss following the gusts, a surf roar breathing with the waves, a little high air.
const ease=x=>x<0?0:x>1?1:x*x*(3-2*x);

export function tour(t){
 // camera: 0-20 s low, 20-50 rise, 50-80 hold, 80-110 descend, 110-130 low   (130 s loop)
 const c=t%130,lift=c<20?0:c<50?ease((c-20)/30):c<80?1:c<110?1-ease((c-80)/30):0;
 const eye=1.6+lift*24;
 const heading=334.7+Math.sin(t*2*Math.PI/95)*75+Math.sin(t*2*Math.PI/41)*8;   // a slow sweep, with a drift
 const pitch=-1.5-lift*7+Math.sin(t*.13)*1.5;
 const time=(9+t/480*24)%24;                                                     // starts mid-morning
 const tide=.75+Math.sin(t*2*Math.PI/180)*3.4;
 return {eye,heading,pitch,time,tide};
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
