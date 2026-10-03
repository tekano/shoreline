import * as THREE from 'three/webgpu';
import {Fn,float,vec2,vec3,vec4,color,mix,smoothstep,max,min,abs,pow,dot,normalize,reflect,clamp,cos,sin,exp,fract,floor,sqrt,length,log,
 attribute,positionWorld,cameraPosition,fwidth,dFdx,dFdy,cross,sign,select} from 'three/tsl';

// The sea as real geometry. A camera-centred grid, dense at the camera and
// coarse at the horizon, is displaced in the vertex shader by two wave layers:
//  - open water: directional Gerstner waves. A long swell from the WSW and
//    shorter wind waves around the wind direction, each slowing with depth
//    (finite-depth dispersion) and fading out where the grid is too coarse to
//    carry it, so detail is layered by distance;
//  - the shoreline: waves that run in along the real distance-to-waterline
//    field, so they bend to follow the coast, peak up and break in the
//    shallows at whatever height the tide is.
// The fragment shader adds fine ripples, reality-js style sun glints, crest
// light and foam: breaking fronts, trailing foam, whitecaps and the swash edge.
const G=9.81;
// compass direction of travel: swell arrives from the WSW, heading ENE
const SWELL=[{l:64,a:.34,h:72,s:.55,p:0},{l:48,a:.22,h:58,s:.5,p:1.7},{l:36,a:.13,h:84,s:.45,p:4.1}];
// wind sea: offsets from the wind's heading, amplitude grows with wind speed
const WIND=[{l:17,a:.05,o:0,s:.6,p:.3},{l:11,a:.04,o:48,s:.6,p:2.2},{l:7.4,a:.03,o:-55,s:.55,p:5.1},{l:5.6,a:.022,o:25,s:.5,p:1.1},{l:4.1,a:.016,o:-70,s:.5,p:3.3},{l:3,a:.011,o:80,s:.45,p:.8},{l:2.1,a:.007,o:-35,s:.4,p:4.4},{l:1.5,a:.0045,o:60,s:.35,p:2.9}];

export function createSea({look}){
 const {U,F,V,Fq,Vq,worley,sky,skyRefl,cloudShade,seaField,bedAt,SWASH,exposureAt}=look;
 const tanh=x=>{const t=exp(x.mul(-2));return float(1).sub(t).div(float(1).add(t));};   // x >= 0 here
 const compass=h=>vec2(Math.sin(h*Math.PI/180),-Math.cos(h*Math.PI/180));   // x east, z south

 // ---------- the wave surface ----------
 // One function gives the displacement and the exact slope at any point. The
 // vertex stage uses the displacement to move the grid; the fragment stage uses
 // the slope for a smooth per-pixel normal (no triangle facets).
 const LS=40,LS2=27;
 // Every shoreline crest is numbered as it comes in, and carries its own life: a strength (sets:
 // some waves big, some small), its own bends along its length, and where along it the wave
 // breaks. After the Point Lookout surf model: whitewater in 5-60 m pieces, staggered from crest to
 // crest, in dense and sparse stretches; the broken centre runs ahead so pieces bow into crescents;
 // and as a crest travels in through the pattern its pieces grow, split and die. Unbroken stretches
 // stay as lower humps of swell. psi: phase in cycles (crest n passes where psi = n).
 const hash1=n=>fract(sin(n.mul(12.9898).add(4.1)).mul(43758.5453));
 const crestOf=(p,psi,seed)=>{
  const i0=floor(psi),f=psi.sub(i0);
  const warpOf=n=>F(p.mul(1/140).add(vec2(n.mul(3.7),n.mul(1.9))).add(seed),.8).sub(.5).mul(.3);   // bends 60-200 m long, +-0.15 cycle
  const psiB=psi.add(mix(warpOf(i0),warpOf(i0.add(1)),smoothstep(.3,.7,f)));                        // blended across the trough: no seam
  const n=floor(psiB.add(.5));                                                                        // this point's crest
  const q=p.add(vec2(n.mul(37.1),n.mul(-23.7))).add(seed*101);                                        // each crest its own pattern
  const piece=F(q.mul(1/26),1.1).mul(.65).add(F(q.mul(1/9),2.7).mul(.35));                            // 9-26 m features
  const dens=F(q.mul(1/140),.3);                                                                      // dense and sparse stretches
  const th=float(.5).add(hash1(n.add(seed)).sub(.5).mul(.16)).sub(dens.sub(.5).mul(.35));            // per-crest threshold: staggered
  const seg=smoothstep(th.sub(.05),th.add(.06),piece);                                                // tapered ends
  const strength=mix(.5,1.3,hash1(n.mul(1.37).add(seed+5)));
  const hump=F(q.mul(1/40),2.1).mul(.6).add(piece.mul(.4));                                           // swell crests ~40 m long, flat between
  return {psi:psiB.add(seg.mul(.15)),seg,height:strength.mul(smoothstep(.4,.7,hump).mul(1.25))};
 };
 // shoreline layer: runs in along the distance field, peaks up, breaks, dies on the sand
 const shoreAt=(p,depth,dist,open,windAmp)=>{
  const along=F(p.mul(.004),.9).mul(9).add(F(p.mul(.0011),2.2).mul(7));
  const shoal=float(1).add(float(1).sub(smoothstep(.3,6,depth)).mul(.8));
  const exposure=open.mul(.8).add(.2);
  const segMod=F(p.mul(.006),1.7).mul(.9).add(.55);                      // some stretches of beach get bigger sets
  const Hs=U.swell.mul(.55).add(windAmp.mul(.15)).mul(pow(exposureAt(p),2).mul(.92).add(.08)).mul(U.waveScale).mul(smoothstep(.02,.35,depth)).mul(segMod);
  const Hs2=Hs.mul(.3);   // a weaker second set: fewer lines
  const ph1=dist.div(U.waveScale.mul(LS)).mul(shoal).mul(6.2832).add(U.time.mul(1.1)).add(along);
  const ph2=dist.div(U.waveScale.mul(LS2)).mul(shoal).mul(6.2832).add(U.time.mul(1.37)).add(along.mul(.8)).add(2.6);
  const c1=crestOf(p,ph1.div(6.2832),0),c2=crestOf(p,ph2.div(6.2832),17);
  const H1=Hs.mul(c1.height),H2=Hs2.mul(c2.height);
  // a flat beach: waves start spilling well out and stay broken all the way in (bigger ones further out)
  const breaking=smoothstep(max(H1.mul(4.2),.7),H1.mul(1.4),depth);
  const breaking2=smoothstep(max(H2.mul(4.2),.5),H2.mul(1.4),depth);
  const wS=float(1).sub(smoothstep(3,10,depth));                  // takes over in the shallows
  return {shoal,Hs:H1,Hs2:H2,phS:c1.psi.mul(6.2832),phS2:c2.psi.mul(6.2832),breaking,breaking2,wS,seg:c1.seg,seg2:c2.seg};
 };
 const surfaceAt=p=>{
  const f=seaField(p),open=f.z,dist=f.y;
  const depth=max(U.tide.sub(bedAt(p)),0);
  const spacing=float(.3).add(length(p.sub(cameraPosition.xz)).mul(.013));   // roughly the grid spacing here
  const exposure=open.mul(.8).add(.2);
  const wdir=normalize(U.wind);
  const windAmp=pow(U.windSpeed.div(8),2);
  // more wind builds longer waves, and longer waves travel faster (c = sqrt(g L / 2pi)),
  // so the sea speeds up with the wind as well as getting rougher
  const windStretch=pow(max(U.windSpeed.div(8),.3),1.4);
  const ws=U.waveScale;   // overall size of the sea's waves: length and height together
  let dx=float(0),dz=float(0),dy=float(0),sx=float(0),sz=float(0);
  const addWave=(dir,L,a,steep,phase)=>{
   L=float(L).mul(ws);const k=float(2*Math.PI).div(L);a=a.mul(ws);
   const om=sqrt(tanh(depth.mul(k)).mul(k).mul(G));
   // short-crested: height wanders along each crest over a few wavelengths, so crests break into segments;
   // a component fades out where the grid cannot carry it, and in very shallow water
   const mod=smoothstep(.25,.75,V(vec2(dot(dir,p),dot(vec2(dir.y.negate(),dir.x),p).mul(2.6)).div(L.mul(2.2)),.37)).mul(1.7).add(.15);
   const amp=a.mul(mod).mul(smoothstep(spacing.mul(3.5),spacing.mul(7),L)).mul(smoothstep(.1,1.2,depth));
   const th=dot(dir,p).mul(k).sub(om.mul(U.time)).add(phase);
   const c=cos(th),s=sin(th);
   dx=dx.add(dir.x.mul(amp.mul(steep).mul(c)));dz=dz.add(dir.y.mul(amp.mul(steep).mul(c)));
   dy=dy.add(amp.mul(s));
   sx=sx.add(dir.x.mul(amp.mul(k).mul(c)));sz=sz.add(dir.y.mul(amp.mul(k).mul(c)));
  };
  const sea=exposureAt(p);
  for(const w of SWELL)addWave(compass(w.h),w.l,U.swell.mul(w.a).mul(pow(sea,2).mul(.95).add(.05)),w.s,w.p);   // the estuary is sheltered from the ocean swell
  for(const w of WIND){
   const c=Math.cos(w.o*Math.PI/180),s=Math.sin(w.o*Math.PI/180);
   addWave(vec2(wdir.x.mul(c).sub(wdir.y.mul(s)),wdir.x.mul(s).add(wdir.y.mul(c))),windStretch.mul(w.l),windAmp.mul(w.a).mul(sqrt(windStretch)).mul(open.mul(.85).add(.15)),w.s,w.p);
  }
  const sh=shoreAt(p,depth,dist,open,windAmp);
  const cs=cos(sh.phS).mul(.5).add(.5),shapeS=pow(cs,3).mul(1.7).sub(.45);   // peaked crests, long flat troughs
  const cs2=cos(sh.phS2).mul(.5).add(.5),shapeS2=pow(cs2,3).mul(1.7).sub(.45);
  const yS=sh.Hs.mul(shapeS).mul(float(1).sub(sh.breaking.mul(.6))).add(sh.Hs2.mul(shapeS2).mul(float(1).sub(sh.breaking2.mul(.6)))).mul(sh.wS);
  // slope of the shoreline layer, from the distance field's gradient
  const e=8,gd=vec2(seaField(p.add(vec2(e,0))).y.sub(dist),seaField(p.add(vec2(0,e))).y.sub(dist)).div(e);
  const dShape=pow(cs,2).mul(sin(sh.phS)).mul(-2.55).mul(float(6.2832/LS).div(U.waveScale)).mul(sh.shoal);
  const dShape2=pow(cs2,2).mul(sin(sh.phS2)).mul(-2.55).mul(float(6.2832/LS2).div(U.waveScale)).mul(sh.shoal);
  const sS=gd.mul(dShape.mul(sh.Hs).add(dShape2.mul(sh.Hs2))).mul(sh.wS);
  const wD=float(1).sub(sh.wS.mul(.75));
  // near the waterline the surface is lifted so the swash can run up the sand (see opacity)
  const lift=float(SWASH).mul(smoothstep(1.5,0,depth));
  return {offset:vec3(dx.mul(wD),dy.mul(wD).add(yS).add(lift),dz.mul(wD)),
          normal:normalize(vec3(sx.mul(wD).add(sS.x).negate(),1,sz.mul(wD).add(sS.y).negate()))};
 };
 const p0=attribute('position','vec3').xz;
 const s0=surfaceAt(p0);
 const posW=vec3(p0.x,U.tide,p0.y).add(s0.offset);
 // ---------- fragment ----------
 const hash32=p=>{const p3=fract(vec3(p.x,p.y,p.x).mul(vec3(.1031,.1030,.0973))).toVar();p3.addAssign(dot(p3,p3.yxz.add(33.33)));return fract(p3.xxy.add(p3.yzz).mul(p3.zyx));};
 // reality-js glints: tiny cells with normally distributed slopes; a cell flashes
 // when its slope mirrors the sun into the eye, then re-rolls a moment later
 const glints=Fn(([p,need,fw,sigma,rate])=>{
  const acc=float(0).toVar();
  for(const [l,size] of [[0,.22],[1,.5]]){   // fewer, bigger facets
   const cs=max(size,fw.mul(1.2));
   const q=p.div(cs).add(l*17.3),id=floor(q),f=fract(q),h0=hash32(id);
   const tt=U.time.mul(rate).add(h0.z.mul(7)),hr=hash32(id.add(floor(tt).mul(1.618)));
   const rad=sqrt(log(max(hr.x,1e-4)).mul(-2));
   const slope=vec2(cos(hr.y.mul(6.2831)),sin(hr.y.mul(6.2831))).mul(rad).mul(sigma);
   const d=slope.sub(need),hit=exp(dot(d,d).div(-.012));
   const c=h0.xy.mul(.6).add(.2),r2=max(.0006,pow(fw.mul(.5).div(cs),2));
   const spot=exp(dot(f.sub(c),f.sub(c)).negate().div(r2)).mul(.012).div(r2);
   acc.addAssign(hit.mul(spot).mul(pow(sin(fract(tt).mul(3.14159)),4).mul(2.67)).mul(float(.2).add(hr.z.mul(hr.z).mul(2.4))).mul(2.2));
  }
  return acc;
 });

 // Whitewater drawn the reality-js way: one number, coverage, decides the
 // pattern. Dense foam is a sheet with holes, thinner foam breaks into threads
 // along noise contours, the oldest foam into scattered lace. Far away the
 // pattern gives way to its average so it cannot shimmer.
 const laceFoam=(p,cov,fw)=>{
  // metres-scale features (threads ~1 m apart, holes 1-8 m) drifting gently: no fine uniform mottle
  const q=p.mul(.55).add(vec2(Fq(p.mul(.09),.4),Fq(p.mul(.09),1.3)).sub(.5).mul(2.4)).add(normalize(U.wind).mul(U.time.mul(.05)));
  const sheetN=Fq(q.mul(.7),.2).mul(.6).add(Fq(q.mul(1.9),1.6).mul(.4));
  const sheet=smoothstep(float(.76).sub(cov.mul(.42)),float(.79).sub(cov.mul(.42)),sheetN);
  const n2=Fq(q.mul(2.3),2.1),r=float(1).sub(abs(n2.mul(2).sub(1)));
  const w=float(.05).add(cov.mul(.2));
  const thread=smoothstep(float(1).sub(w),float(1).sub(w.mul(.6)),r.add(Vq(q.mul(6),.7).mul(.06)));
  const brk=smoothstep(float(.6).sub(cov.mul(.45)),float(.75).sub(cov.mul(.45)),Vq(q.mul(1.4),2.4));
  // aerated: cells of clear water open up in the foam (Worley), more as it thins, and 10 m blotches
  // vary how dense it is, so it is never a solid white sheet
  const blot=smoothstep(.25,.75,Fq(q.mul(.09),.8));
  // three cell sizes (~8, 3, 1 m) on a warped grid, weighted to the big ones: irregular holes
  const qw=q.add(vec2(Fq(q.mul(.05),.3),Fq(q.mul(.05),2.2)).sub(.5).mul(14));
  const cellD=worley(qw.mul(.2)).mul(.6).add(worley(qw.mul(.55).add(3.1)).mul(.3)).add(worley(qw.mul(1.6).add(7.7)).mul(.1));
  // even fresh foam at the breaking edge is torn (small holes); older, thinner foam opens right up
  const holes=smoothstep(mix(.5,.3,cov.mul(blot.mul(.5).add(.5))),mix(.6,.4,cov),cellD);
  const near=max(sheet,thread.mul(mix(.25,1,brk))).mul(smoothstep(.03,.14,cov)).mul(mix(.12,1,holes)).mul(blot.mul(.45).add(.55));
  return mix(near,smoothstep(.04,.6,cov).mul(.7),smoothstep(.04,.18,fw));   // far away: the foam's average (holes included)
 };
 const make=({far})=>{
  const m=new THREE.MeshBasicNodeMaterial({transparent:true,depthWrite:false});
  if(!far)m.positionNode=posW;
  const state=()=>{
   const p=positionWorld.xz,f=seaField(p),bed=bedAt(p);
   // the edge: a slow seep (surf beat, ~55 s), so the water creeps up the sand and drains back
   const runPhase=U.time.mul(.115).add(F(p.mul(.004),.9).mul(9).add(F(p.mul(.0011),2.2).mul(7)));
   const run=pow(cos(runPhase).mul(.5).add(.5),3).mul(float(.06).add(U.swell.mul(.1))).mul(f.z.mul(.6).add(.4));
   // the swash: the water's real edge runs up the beach and drains back
   const surface=far?U.tide:positionWorld.y.sub(float(SWASH).mul(smoothstep(1.5,0,max(U.tide.sub(bed),0)))).add(run);
   const signed=surface.sub(bed);
   return {p,f,bed,depth:max(signed,0),signed};
  };
  m.colorNode=Fn(()=>{
   const {p,f,depth,signed}=state();
   const open=f.z;
   const eye=normalize(cameraPosition.sub(positionWorld)).toVar();
   const range=cameraPosition.sub(positionWorld).length();
   const fw=max(length(fwidth(p)),1e-4);
   // fine ripples on top of the geometry: wind-aligned, glassy in thin water
   const wd=normalize(U.wind),rp=p.add(wd.mul(U.time.mul(1.6)));
   const ea=.5,a0=F(rp.mul(.12),.2),ax=F(rp.add(vec2(ea,0)).mul(.12),.2),az=F(rp.add(vec2(0,ea)).mul(.12),.2);
   const b0=V(rp.mul(.9),1.1),bx=V(rp.add(vec2(.12,0)).mul(.9),1.1),bz=V(rp.add(vec2(0,.12)).mul(.9),1.1);
   const rough=open.mul(.8).add(.2).mul(U.windSpeed.div(8)).mul(smoothstep(.02,.6,depth).mul(.85).add(.15));
   const fade=float(1).sub(smoothstep(300,5000,range));
   const g=vec2(ax.sub(a0).div(ea).mul(.7).add(bx.sub(b0).div(.12).mul(.06)),az.sub(a0).div(ea).mul(.7).add(bz.sub(b0).div(.12).mul(.06))).mul(rough).mul(fade.mul(.7).add(.3));
   // the exact slope of the wave surface at this pixel: smooth, no triangle facets
   const nG=far?vec3(0,1,0):surfaceAt(p).normal;
   const base=nG;
   const n=normalize(base.add(vec3(g.x.negate(),0,g.y.negate())));
   const ndv=max(dot(n,eye),0);
   const shadeS=cloudShade(positionWorld);
   // foam
   const lump=F(p.mul(vec2(.3,.45)).add(U.time.mul(.08)),.6).mul(.6).add(V(p.mul(1.6),.4).mul(.4));
   const sh=shoreAt(p,depth,f.y,open,pow(U.windSpeed.div(8),2));
   const breakF=far?float(0):sh.breaking.mul(sh.wS),breakF2=far?float(0):sh.breaking2.mul(sh.wS);
   // where each breaking wave is: u=0 at its crest, just below 1 on the face
   // ahead of it, small just behind it where it has passed and left foam
   // ragged foam: the band's place in the wave wobbles with the water (metres-scale), so its edges and
   // ends are torn, not ruled lines following the distance field's facets
   const wob=F(p.mul(.22),1.4).sub(.5).mul(.07).add(V(p.mul(.8),.6).sub(.5).mul(.03));
   const u1=far?float(.5):fract(sh.phS.div(6.2832).add(wob)),u2=far?float(.5):fract(sh.phS2.div(6.2832).sub(wob));
   const roller=u=>smoothstep(.8,.95,u).add(float(1).sub(smoothstep(0,.05,u)));   // one band over the crest (no dark seam at the top)
   const trail=u=>exp(u.mul(-5.5));
   const active=smoothstep(.3,.6,F(p.mul(.018).add(vec2(U.time.mul(.01),0)),1.3)).mul(.5).add(.5);
   const seg1=far?float(0):sh.seg,seg2=far?float(0):sh.seg2;   // only the breaking pieces foam
   const cov=clamp(breakF.mul(seg1).mul(roller(u1).mul(1.25).add(trail(u1).mul(.85))).add(breakF2.mul(seg2).mul(roller(u2).add(trail(u2).mul(.7)).mul(.7))).mul(active),0,1);
   const surfCov=cov;
   // how high this point stands in its wave: a crest proxy for whitecaps and crest light
   const crest=far?float(0):clamp(positionWorld.y.sub(U.tide).div(U.swell.mul(.45).add(pow(U.windSpeed.div(8),2).mul(.08)).add(.05)),-1,1);
   // whitecaps: crests torn by the wind; they join the surf in one coverage, one lace
   const capsCov=smoothstep(.45,.95,crest).mul(smoothstep(.45,.75,lump)).mul(smoothstep(5,14,U.windSpeed)).mul(open).mul(smoothstep(2,6,depth)).mul(.8);
   const surf=laceFoam(p,max(surfCov,capsCov),fw);
   const lace=smoothstep(.42,.62,F(p.mul(vec2(1.4,2.2)).add(U.time.mul(.12)),1.7).mul(.6).add(V(p.mul(6),.9).mul(.4)));
   const edge=smoothstep(0,.006,signed).mul(float(1).sub(smoothstep(.012,.05,signed))).mul(lace.mul(.8).add(.2));
   // scattered bubbles in the thin water: dots at Worley points (no repeating tile), only in
   // irregular patches ~15 m across that drift with the water
   const bq=p.add(normalize(U.wind).mul(U.time.mul(.12)));
   const bubbleDots=smoothstep(.2,.09,worley(bq.mul(2.6).add(vec2(F(bq.mul(.3),.4),F(bq.mul(.3),1.7)).mul(2))));
   const bubblePatch=smoothstep(.55,.75,F(bq.mul(.065),2.4).mul(.7).add(F(bq.mul(.21),.9).mul(.3)));
   const bubbles=smoothstep(.04,.12,depth).mul(float(1).sub(smoothstep(.25,.6,depth))).mul(bubbleDots).mul(bubblePatch).mul(smoothstep(.06,.02,fw)).mul(.35);
   const foam=clamp(max(max(surf,edge),bubbles),0,1).toVar();
   // body: silty sand-grey in the shallows, teal, deep blue-grey; lit by sun and sky
   const body=mix(color('#8c8770'),color('#6f7e72'),smoothstep(.15,1.2,depth)).toVar();
   body.assign(mix(body,color('#3c6470'),smoothstep(1.2,4,depth)));
   body.assign(mix(body,color('#264b5e'),smoothstep(5,14,depth)));
   // under an overcast deck the Irish Sea goes slate: grey-green, little blue left
   body.assign(mix(body,mix(color('#6b6f66'),color('#4b5655'),smoothstep(.5,5,depth)),U.overcast.mul(.75)));
   body.mulAssign(U.sunLight.mul(max(U.sun.y,0)).mul(shadeS).mul(.32).add(U.skyAmb.mul(.6)));
   // light through the thin upper part of a wave: the sea's colour glowing in the crests
   const back=pow(max(dot(eye.negate(),normalize(vec3(U.sun.x,0,U.sun.z))),0),2).mul(.6).add(.4);
   body.addAssign(color('#2f8c7c').mul(U.sunLight).mul(max(U.sun.y,.05)).mul(smoothstep(.2,.9,crest)).mul(back).mul(shadeS).mul(.35).mul(smoothstep(.5,3,depth)));
   // Fresnel, roughness-aware: edge-on, a wind-roughened sea is a mirror only in part, since its facets
   // tilt toward you and show the dark water (and far away they are below a pixel), so the sea line
   // reads darker than the sky; glassy calm water still mirrors fully
   const fMax=mix(float(1),float(.5),smoothstep(.1,.9,rough)).mul(mix(1,.75,smoothstep(400,6000,range)));
   const fres=float(.02).add(pow(float(1).sub(ndv),5).mul(fMax.sub(.02)));
   const col=mix(body,skyRefl(reflect(eye.negate(),n)).mul(.85),fres).toVar();
   // sun glitter: a statistical path that widens with roughness...
   const hS=normalize(U.sun.add(eye)),nh=max(dot(n,hS),.001),nh2=nh.mul(nh);
   const sig2=float(.0008).add(rough.mul(.006));   // a narrower glitter path
   const D=exp(float(1).sub(nh2).div(nh2).div(sig2).negate()).div(sig2.mul(3.1416).mul(nh2).mul(nh2));
   const Fh=float(.02).add(pow(float(1).sub(max(dot(hS,eye),0)),5).mul(.98));
   const clearSky=pow(float(1).sub(U.overcast),2);   // glitter needs a sun to glitter in
   col.addAssign(U.sunLight.mul(min(D.mul(Fh).div(max(ndv,.15).mul(4)),60)).mul(shadeS).mul(min(max(U.sun.y,0).mul(4),1)).mul(clearSky).mul(.2));   // a soft path; the glints carry the sparkle
   // ...and individual glints sparkling in it, as in reality-js
   const need=vec2(hS.x.div(hS.y),hS.z.div(hS.y)).sub(vec2(n.x.div(n.y),n.z.div(n.y))).negate();
   // facets barely tilted: the waves' own slope decides where they flash, so glints ride the wave faces
   const gl=glints(p,need,fw,sqrt(sig2).mul(.9).add(.03),float(.45));
   col.addAssign(U.sunLight.mul(gl.mul(27)).mul(float(1).sub(foam)).mul(shadeS).mul(clearSky).mul(smoothstep(0,.06,U.sun.y)).mul(mix(.5,1.2,smoothstep(6,80,range))));
   const foamLit=vec3(.93).mul(U.sunLight.mul(max(U.sun.y,0)).mul(shadeS).mul(.3).add(U.skyAmb.mul(1.3)));
   col.assign(mix(col,foamLit,foam));
   // debug view: red = foam coverage, green = breaking, blue = position in the wave cycle
   const dbg=vec3(cov,breakF,u1);
   const dbg2=vec3(fract(sh.phS.mul(.1)),crest.mul(.5).add(.5),nG.y);
   // select, not mix: a NaN in an unused debug value must not leak into the picture
   return far?col:select(U.debug.greaterThan(1.5),dbg2,select(U.debug.greaterThan(.5),dbg,col));
  })();
  m.opacityNode=Fn(()=>{
   const {depth,signed}=state();
   const eye=normalize(cameraPosition.sub(positionWorld));
   const fres=pow(float(1).sub(max(eye.y,0)),5);
   const there=smoothstep(0,.006,signed);
   // the far ring only shows beyond the wave grid
   const ring=far?smoothstep(14500,15500,cameraPosition.xz.sub(positionWorld.xz).length()):float(1);
   return there.mul(max(smoothstep(0,1.4,depth).mul(.72).add(.28),fres)).mul(ring);
  })();
  m.fog=true;
  return m;
 };

 // camera-centred grid: ~0.3 m apart at the camera, ~60 m at 5 km, out to 16 km
 const N=900,R=16000,A=.008;   // ~0.3 m apart at the camera
 const warp=u=>Math.sign(u)*R*(A*Math.abs(u)+(1-A)*Math.abs(u)**3);
 const offs=new Float32Array(N);for(let i=0;i<N;i++)offs[i]=warp(-1+2*i/(N-1));
 const geo=new THREE.BufferGeometry(),pos=new Float32Array(N*N*3);
 geo.setAttribute('position',new THREE.BufferAttribute(pos,3));
 const idx=new Uint32Array((N-1)*(N-1)*6);let n=0;
 for(let j=0;j<N-1;j++)for(let i=0;i<N-1;i++){const a=j*N+i,b=a+1,c=a+N,d=c+1;idx.set([a,c,b,b,c,d],n);n+=6;}
 geo.setIndex(new THREE.BufferAttribute(idx,1));
 const mesh=new THREE.Mesh(geo,make({far:false}));mesh.frustumCulled=false;mesh.renderOrder=2;
 const farMesh=new THREE.Mesh(new THREE.PlaneGeometry(240000,240000).rotateX(-Math.PI/2),make({far:true}));farMesh.frustumCulled=false;farMesh.renderOrder=1;
 let at=null;
 const update=(cx,cz,tide)=>{
  cx=Math.round(cx/8)*8;cz=Math.round(cz/8)*8;
  if(!at||at[0]!==cx||at[1]!==cz){
   for(let j=0;j<N;j++)for(let i=0;i<N;i++){const k=(j*N+i)*3;pos[k]=cx+offs[i];pos[k+1]=0;pos[k+2]=cz+offs[j];}
   geo.attributes.position.needsUpdate=true;geo.computeBoundingSphere();at=[cx,cz];
  }
  farMesh.position.set(cx,tide,cz);
 };
 return {mesh,farMesh,update};
}
