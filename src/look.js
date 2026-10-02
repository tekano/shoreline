import * as THREE from 'three/webgpu';
import {Fn,uniform,float,vec2,vec3,abs,max,mix,smoothstep,clamp,fract,floor,dot,exp,sqrt,log,cos,sin,pow} from 'three/tsl';

// Every value the look can be tuned by. Plain JSON, so a preset is just a copy
// of this object. Colours are sRGB hex strings, like a colour picker shows them.
export const LOOK_DEFAULTS={
 // foam amount: the simulation's fresh and lingering foam become one coverage value
 freshWeight:.88,oldWeight:.35,foamGain:1.25,patchiness:.9,
 // foam pattern (reality-js lace): coverage turns sheet → threads → snapped threads
 laceMix:1,laceScale:1,threadWidth:1,sheetBias:0,breakup:1,warp:1,swapPeriod:2.2,
 laceFadeNear:.012,laceFadeFar:.05,
 // whitewater: dense fresh foam becomes a solid, lumpy mass
 whiteStart:.45,whiteEnd:.95,whiteLumps:1,
 // foam relief: threads shade themselves and cast a short shadow away from the sun
 foamHeight:.015,laceShadow:.28,selfShade:.35,
 // water body: light absorbed per metre of path, red first
 absorbR:10.2,absorbG:6.1,absorbB:5.8,absorbScale:1,
 shallowColor:'#364e54',deepColor:'#364e54',
 turbidity:1,surfDepth:1.5,turbidShallow:'#605e54',turbidDeep:'#46543c',
 // light through the crests
 crestColor:'#3a4632',crestAmount:.6,glowColor:'#697d3e',glowAmount:.55,
 // surface
 reflectivity:.9,sunSpec:.42,glintStrength:.15,glintSigma:.16,glintRate:.9,foamSparkle:.3,
 // sim (sent to the solver, not the shader): foam lifetimes per second
 foamFresh:.65,foamOld:.145,
 // light
 sunAzimuth:-163,sunElevation:28,
 // 0 final · 1 foam amount · 2 foam pattern · 3 water depth · 4 flow
 debug:0
};

// The original Saltreach look, for A/B comparison.
export const LOOK_SALTREACH={...LOOK_DEFAULTS,
 laceMix:0,absorbR:.72,absorbG:.20,absorbB:.14,absorbScale:1,shallowColor:'#286b76',deepColor:'#103c54',
 turbidity:0,crestAmount:0,glowAmount:0,glintStrength:0,foamSparkle:0,laceShadow:0,selfShade:0,whiteStart:2,whiteEnd:3
};

const COLOURS=['shallowColor','deepColor','turbidShallow','turbidDeep','crestColor','glowColor'];
const SHADER_ONLY_SKIP=['foamFresh','foamOld','sunAzimuth','sunElevation'];

export function createLook(noise,U){
 const L={};
 for(const [key,value] of Object.entries(LOOK_DEFAULTS)){
  if(SHADER_ONLY_SKIP.includes(key))continue;
  L[key]=COLOURS.includes(key)?uniform(new THREE.Color(value)):uniform(value);
 }
 L.absorb=uniform(new THREE.Vector3(LOOK_DEFAULTS.absorbR,LOOK_DEFAULTS.absorbG,LOOK_DEFAULTS.absorbB));
 const apply=params=>{
  for(const [key,value] of Object.entries(params)){
   if(!L[key])continue;
   if(COLOURS.includes(key))L[key].value.set(value);else L[key].value=value;
  }
  L.absorb.value.set(params.absorbR,params.absorbG,params.absorbB);
 };

 // The noise texture tiles, so every lookup is rotated by its own angle: the
 // sum of differently oriented lattices does not visibly repeat.
 // r = four-octave fbm at 8 cells per tile, g = value noise at 48 cells per tile.
 const rot=(p,a)=>vec2(p.x.mul(Math.cos(a)).sub(p.y.mul(Math.sin(a))),p.x.mul(Math.sin(a)).add(p.y.mul(Math.cos(a))));
 const F=(p,a)=>noise(rot(p,a).mul(1/8)).r;
 const V=(p,a=0)=>noise(rot(p,a).mul(1/48)).g;

 // One lace layer (reality-js laceLayer). The less foam, the wider the holes,
 // until only threads remain, and the threads break as it thins further.
 const laceLayer=Fn(([q,cov,t])=>{
  const qs=q.mul(vec2(5.5,6.5).mul(L.laceScale));
  const qq=qs.add(vec2(F(qs.mul(.5).add(vec2(1.3,t.mul(.35))),.3),F(qs.mul(.5).add(vec2(t.mul(-.3).add(8.1),0)),1.1)).sub(.5).mul(L.warp.mul(.6))).toVar();
  qq.addAssign(vec2(F(qq.mul(3).add(vec2(0,t.mul(.8))),2.1),F(qq.mul(3).add(vec2(t.mul(.7).add(4.3),0)),.7)).sub(.47).mul(L.warp.mul(.15)));
  // threads are noise contours, 1-|2n-1|, as wide as the amount of foam allows
  const n1=F(qq.mul(1.6).add(5),.5).mul(.65).add(F(qq.mul(3.7).add(11),1.3).mul(.35));
  const r1=float(1).sub(abs(n1.mul(2).sub(1)));
  const r2=float(1).sub(abs(F(qq.mul(3.1).add(17),2.4).mul(2).sub(1)));
  const fz=V(qq.mul(18),.4).mul(.6).add(V(qq.mul(45),1.7).mul(.4)).sub(.5);
  const w1=float(.05).add(cov.mul(.16)).mul(L.threadWidth),w2=float(.04).add(cov.mul(.12)).mul(L.threadWidth);
  const thread=max(smoothstep(float(1).sub(w1),float(1).sub(w1.mul(.7)),r1.add(fz.mul(.06))),smoothstep(float(1).sub(w2),float(1).sub(w2.mul(.7)),r2.add(fz.mul(.06))).mul(.85));
  // only dense foam becomes a sheet with uneven holes
  const b=F(qq.mul(1.2).add(2),.9).mul(.6).add(F(qq.mul(2.9).add(7),1.9).mul(.4)).add(fz.mul(.05));
  const th=float(.6).add(float(.55).sub(cov).mul(.5)).add(L.sheetBias);
  const sheet=smoothstep(th.sub(.01),th.add(.02),b);
  const brk=smoothstep(float(.62).sub(cov.mul(.45)),float(.8).sub(cov.mul(.45)),V(qq.mul(2.2).add(7).add(t.mul(.2)),2.8));
  return max(sheet,thread.mul(mix(float(1).sub(L.breakup.mul(.85)),1,brk))).mul(smoothstep(.02,.12,cov));
 });

 // Two layers offset in time. Each thins out by losing coverage, not by
 // fading, while the next thickens in, so the threads stay crisp.
 const lace=Fn(([q,cov,t])=>{
  const f=float(0).toVar();
  for(const k of [0,1]){
   const ph=t.div(L.swapPeriod).add(k*.5);
   const wk=float(1).sub(abs(fract(ph).mul(2).sub(1)));
   const n=floor(ph).add(k*7.3);
   const off=vec2(fract(sin(n.mul(12.9898)).mul(43758.5453)),fract(sin(n.mul(78.233)).mul(43758.5453))).mul(40);
   f.assign(max(f,laceLayer(q.add(off),cov.mul(smoothstep(0,.5,wk)),t)));
  }
  // fine grain inside the foam, and pinholes where it is thin
  f.mulAssign(float(.88).add(V(q.mul(vec2(40,55)).add(t.mul(.5)),.9).mul(.16)));
  f.mulAssign(mix(1,smoothstep(.15,.4,V(q.mul(vec2(60,80)).add(t.mul(.7)),2.2)),float(.5).mul(float(1).sub(cov))));
  return clamp(f.mul(smoothstep(.03,.3,cov)),0,1);
 });

 const hash32=p=>{
  const p3=fract(vec3(p.x,p.y,p.x).mul(vec3(.1031,.1030,.0973))).toVar();
  p3.addAssign(dot(p3,p3.yxz.add(33.33)));
  return fract(p3.xxy.add(p3.yzz).mul(p3.zyx));
 };

 // Glints (reality-js): the surface is split into small cells, each with a
 // normally distributed slope. Only cells that tilt the sun into the eye light,
 // flashing in place before re-rolling their slope.
 const glints=Fn(([p,need,fw,sigma,rate,t])=>{
  const acc=float(0).toVar();
  for(const [l,size] of [[0,.03],[1,.07]]){
   const cs=max(size,fw.mul(1.2));
   const q=p.div(cs).add(l*17.3);
   const id=floor(q),f=fract(q);
   const h0=hash32(id);
   const tt=t.mul(rate).add(h0.z.mul(7));
   const hr=hash32(id.add(floor(tt).mul(1.618)));
   const radius=sqrt(log(max(hr.x,1e-4)).mul(-2));
   const slope=vec2(cos(hr.y.mul(6.2831)),sin(hr.y.mul(6.2831))).mul(radius).mul(sigma);
   const d=slope.sub(need);
   const hit=exp(dot(d,d).div(-.0064));
   const c=h0.xy.mul(.6).add(.2);
   const r2=max(.0006,pow(fw.mul(.5).div(cs),2));
   const spot=exp(dot(f.sub(c),f.sub(c)).negate().div(r2)).mul(.012).div(r2);
   const blink=pow(sin(fract(tt).mul(3.14159)),4).mul(2.67);
   const gain=float(.2).add(hr.z.mul(hr.z).mul(2.4));
   acc.addAssign(hit.mul(spot).mul(blink).mul(gain).mul(2.2));
  }
  return acc;
 });

 return {L,apply,lace,glints,F,V};
}
