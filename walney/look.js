import * as THREE from 'three/webgpu';
import {Fn,uniform,float,vec2,vec3,color,texture,mix,smoothstep,max,min,abs,pow,dot,normalize,reflect,clamp,cos,sin,exp,fract,floor,step,
 positionWorld,normalWorld,cameraPosition,reflectVector,bumpMap} from 'three/tsl';

// The look of the Walney scene, matched to photos of the place: summer sky
// with cumulus and their moving shadows, light haze, wet sand that mirrors the
// clouds, a shingle bank, marram dunes, grey-olive saltmarsh, and a sea whose
// breakers and swash follow the real waterline at whatever the tide is.
export function createLook({noiseTex,far,near,tide,landcover}){
 const U={
  sun:uniform(new THREE.Vector3(0,1,0)),time:uniform(0),tide:uniform(tide),tint:uniform(1),
  wind:uniform(new THREE.Vector2(.8,.6)),windSpeed:uniform(7),   // m/s, blowing toward +x/+z (onshore from the south-west)
  swell:uniform(.8),clouds:uniform(.5),haze:uniform(1)
 };
 const noise=uv=>texture(noiseTex,uv);
 const rot=(p,a)=>vec2(p.x.mul(Math.cos(a)).sub(p.y.mul(Math.sin(a))),p.x.mul(Math.sin(a)).add(p.y.mul(Math.cos(a))));
 const F=(p,a=0)=>noise(rot(p,a).mul(1/8)).r;   // ~1 cycle per unit, four octaves
 const V=(p,a=0)=>noise(rot(p,a).mul(1/48)).g;

 // ---------- wind ----------
 // One gust field for everything that moves in the wind: ~80 m wide gusts
 // rolling downwind a little slower than the wind, over finer flurries.
 // Returns 0 (lull) .. 1 (gust). Grass, ground sheen, whitecaps and (later)
 // the wind sound all read this same field, so they agree with each other.
 const gust=Fn(([p])=>{
  const wdir=normalize(U.wind);
  const drift=wdir.mul(U.time.mul(U.windSpeed).mul(.85));
  const q=p.sub(drift);
  const big=F(vec2(dot(q,wdir),dot(q,vec2(wdir.y.negate(),wdir.x)).mul(.6)).mul(.011),.4);
  const small=V(q.mul(.05).sub(wdir.mul(U.time.mul(.15))),1.3);
  return smoothstep(.32,.78,big.mul(.75).add(small.mul(.25)));
 });

 // ---------- cumulus ----------
 // One cloud field on a layer 1.6 km up, drifting with the wind. The sky draws
 // it, and the ground, grass and sea darken where it shades the sun, so the
 // cloud shadows sweeping the land belong to the clouds you can see.
 const CLOUD_H=1600;
 const cloudDensity=Fn(([xz])=>{
  const q=xz.sub(normalize(U.wind).mul(U.time.mul(U.windSpeed).mul(1.4)));
  const base=F(q.mul(1/4200),.7).mul(.58).add(F(q.mul(1/1300),1.9).mul(.28)).add(V(q.mul(1/330),.3).mul(.14));
  const th=mix(float(.78),float(.38),U.clouds);
  return smoothstep(th,th.add(.07),base);
 });
 const cloudShade=Fn(([pw])=>{                       // 1 in sun, ~.45 in cloud shadow
  const s=normalize(U.sun);
  const onLayer=pw.xz.add(s.xz.div(max(s.y,.15)).mul(float(CLOUD_H).sub(pw.y)));
  return float(1).sub(cloudDensity(onLayer).mul(.55).mul(smoothstep(0,.08,s.y)));
 });

 // ---------- sky ----------
 const sky=Fn(([dir])=>{
  const d=normalize(dir).toVar(),el=max(d.y,0);
  const zenith=color('#2f6cc6'),mid=color('#5d95d8'),horizon=color('#b2d0e8');
  const c=mix(horizon,mid,smoothstep(0,.22,el)).toVar();
  c.assign(mix(c,zenith,smoothstep(.22,.95,el)));
  const sd=max(dot(d,U.sun),0);
  c.addAssign(color('#fff1d6').mul(pow(sd,48).mul(.35).add(pow(sd,2400).mul(30))));
  // high cirrus: a cloud layer 9 km up, combed out along the wind (thins as cumulus builds)
  const pc=d.xz.div(max(d.y,.03)).mul(9000);
  const wdir=normalize(U.wind),across=vec2(wdir.y.negate(),wdir.x);
  const ci=vec2(dot(pc,wdir).mul(.00003),dot(pc,across).mul(.00022)).add(vec2(U.time.mul(.0004),0));
  const cirrus=pow(smoothstep(.45,.85,F(ci,.3)),2).mul(smoothstep(.04,.25,el)).mul(float(.55).sub(U.clouds.mul(.35)));
  c.assign(mix(c,color('#f4f7fb'),cirrus));
  // cumulus: where this ray meets the cloud layer, world-anchored so the
  // clouds overhead are the ones casting shadows on the ground below
  const t=float(CLOUD_H).sub(cameraPosition.y).div(max(d.y,.012));
  const xz=cameraPosition.xz.add(d.xz.mul(t));
  const dens=cloudDensity(xz);
  const sunward=cloudDensity(xz.add(normalize(U.sun.xz.add(vec2(1e-4,0))).mul(220)));
  const puff=F(xz.mul(1/420),2.7);                                              // billows catching the light
  const lit=float(1).sub(sunward.mul(.7)).mul(mix(.75,1.12,puff));
  const silver=clamp(pow(sd,8).mul(float(1).sub(dens).mul(2.5)),0,1);       // bright rims toward the sun
  const cloudC=mix(color('#75849b'),color('#f7f8fa'),clamp(lit,0,1)).add(color('#ffffff').mul(silver.mul(.35)));
  const fadeH=smoothstep(.012,.07,el);                                           // far clouds melt into the haze
  c.assign(mix(c,mix(horizon,cloudC,fadeH.mul(.85).add(.15)),dens.mul(.95)));
  return mix(color('#b9c9d8'),c,smoothstep(-.02,.0,d.y));
 });
 const skyMaterial=new THREE.MeshBasicNodeMaterial({side:THREE.BackSide,depthWrite:false,fog:false});
 skyMaterial.colorNode=sky(positionWorld.sub(cameraPosition));

 // ---------- sea field: bed height, distance from the waterline, openness ----------
 // Recomputed whenever the tide moves, so breaker lines follow the real waterline.
 const fieldTex=new THREE.DataTexture(new Uint16Array(far.w*far.hgt*4),far.w,far.hgt,THREE.RGBAFormat,THREE.HalfFloatType);
 fieldTex.magFilter=fieldTex.minFilter=THREE.LinearFilter;fieldTex.needsUpdate=true;
 // landward distance from the high-water line (+4.5 m ODN): beach vs dunes vs fields
 const hw=new Float32Array(far.w*far.hgt);
 {const W=far.w,H=far.hgt;for(let k=0;k<W*H;k++)hw[k]=far.h[k]<4.5?0:1e9;
  for(let j=0;j<H;j++)for(let i=0;i<W;i++){const k=j*W+i;if(!hw[k])continue;let d=hw[k];if(i>0)d=Math.min(d,hw[k-1]+1);if(j>0){d=Math.min(d,hw[k-W]+1);if(i>0)d=Math.min(d,hw[k-W-1]+1.414);if(i<W-1)d=Math.min(d,hw[k-W+1]+1.414);}hw[k]=d;}
  for(let j=H-1;j>=0;j--)for(let i=W-1;i>=0;i--){const k=j*W+i;if(!hw[k])continue;let d=hw[k];if(i<W-1)d=Math.min(d,hw[k+1]+1);if(j<H-1){d=Math.min(d,hw[k+W]+1);if(i<W-1)d=Math.min(d,hw[k+W+1]+1.414);if(i>0)d=Math.min(d,hw[k+W-1]+1.414);}hw[k]=d;}}
 // exposure: share of deep water (below -2 m) within ~2.5 km. The open-coast
 // beach on the West Shore is exposed; the inner Duddon flats are sheltered.
 // OpenStreetMap tags both as tidal flat, so this decides sand versus mud.
 const exposure=new Float32Array(far.w*far.hgt);
 {const W=far.w,H=far.hgt,I=new Float64Array((W+1)*(H+1)),r=150;
  for(let j=0;j<H;j++){let row=0;for(let i=0;i<W;i++){row+=far.h[j*W+i]<-2?1:0;I[(j+1)*(W+1)+i+1]=I[j*(W+1)+i+1]+row;}}
  for(let j=0;j<H;j++)for(let i=0;i<W;i++){const i0=Math.max(0,i-r),i1=Math.min(W,i+r+1),j0=Math.max(0,j-r),j1=Math.min(H,j+r+1);
   const share=(I[j1*(W+1)+i1]-I[j0*(W+1)+i1]-I[j1*(W+1)+i0]+I[j0*(W+1)+i0])/((i1-i0)*(j1-j0));exposure[j*W+i]=Math.min(Math.max((share-.12)/.3,0),1);}}
 const expTex=new THREE.DataTexture(new Uint16Array(far.w*far.hgt),far.w,far.hgt,THREE.RedFormat,THREE.HalfFloatType);
 {const h=THREE.DataUtils.toHalfFloat;for(let k=0;k<exposure.length;k++)expTex.image.data[k]=h(exposure[k]);}
 expTex.magFilter=expTex.minFilter=THREE.LinearFilter;expTex.needsUpdate=true;
 const updateSea=level=>{
  const W=far.w,H=far.hgt,n=W*H,wet=new Uint8Array(n),dist=new Float32Array(n);
  for(let k=0;k<n;k++){wet[k]=far.h[k]<level?1:0;dist[k]=wet[k]?1e9:0;}
  // chamfer distance (3-4) from the nearest dry cell, in cells
  for(let j=0;j<H;j++)for(let i=0;i<W;i++){const k=j*W+i;if(!wet[k])continue;let d=dist[k];
   if(i>0)d=Math.min(d,dist[k-1]+1);if(j>0){d=Math.min(d,dist[k-W]+1);if(i>0)d=Math.min(d,dist[k-W-1]+1.414);if(i<W-1)d=Math.min(d,dist[k-W+1]+1.414);}dist[k]=d;}
  for(let j=H-1;j>=0;j--)for(let i=W-1;i>=0;i--){const k=j*W+i;if(!wet[k])continue;let d=dist[k];
   if(i<W-1)d=Math.min(d,dist[k+1]+1);if(j<H-1){d=Math.min(d,dist[k+W]+1);if(i<W-1)d=Math.min(d,dist[k+W+1]+1.414);if(i>0)d=Math.min(d,dist[k+W-1]+1.414);}dist[k]=d;}
  // openness: share of water within ~1.3 km; the estuary channels are sheltered
  const I=new Float64Array((W+1)*(H+1));
  for(let j=0;j<H;j++){let row=0;for(let i=0;i<W;i++){row+=wet[j*W+i];I[(j+1)*(W+1)+i+1]=I[j*(W+1)+i+1]+row;}}
  const r=80,out=fieldTex.image.data,h=THREE.DataUtils.toHalfFloat;
  for(let j=0;j<H;j++)for(let i=0;i<W;i++){
   const i0=Math.max(0,i-r),i1=Math.min(W,i+r+1),j0=Math.max(0,j-r),j1=Math.min(H,j+r+1);
   const open=(I[j1*(W+1)+i1]-I[j0*(W+1)+i1]-I[j1*(W+1)+i0]+I[j0*(W+1)+i0])/((i1-i0)*(j1-j0));
   const k=j*W+i,q=k*4;
   out[q]=h(far.h[k]);out[q+1]=h(Math.min(dist[k]*far.res,60000));out[q+2]=h(open);out[q+3]=h(Math.min(hw[k]*far.res,60000));
  }
  fieldTex.needsUpdate=true;
 };
 updateSea(tide);
 const seaField=p=>texture(fieldTex,p.sub(vec2(far.west,far.north)).div(vec2(far.w*far.res,far.hgt*far.res)));

 // Bed height for the water shader, from the 4 m layer where it exists. Water
 // depth is computed from this, never read back from the depth buffer, so the
 // waterline is smooth and cannot flicker where sea and sand nearly coincide.
 const nearTex=new THREE.DataTexture(new Uint16Array(near.w*near.hgt),near.w,near.hgt,THREE.RedFormat,THREE.HalfFloatType);
 {const h=THREE.DataUtils.toHalfFloat,d=nearTex.image.data;for(let k=0;k<d.length;k++)d[k]=h(near.h[k]);}
 nearTex.magFilter=nearTex.minFilter=THREE.LinearFilter;nearTex.needsUpdate=true;
 const inLayer=(L,p,margin)=>{const a=p.sub(vec2(L.west,L.north)),b=vec2(L.west+L.w*L.res,L.north+L.hgt*L.res).sub(p);
  return smoothstep(0,margin,a.x).mul(smoothstep(0,margin,a.y)).mul(smoothstep(0,margin,b.x)).mul(smoothstep(0,margin,b.y));};
 const bedAt=p=>mix(seaField(p).x,texture(nearTex,p.sub(vec2(near.west,near.north)).div(vec2(near.w*near.res,near.hgt*near.res))).r,inLayer(near,p,200));

 // ---------- ground ----------
 const ground=new THREE.MeshStandardNodeMaterial({roughness:.95});
 const y=positionWorld.y,up=normalWorld.y,p=positionWorld.xz;
 const range=cameraPosition.sub(positionWorld).length();
 const grain=F(p.mul(.9),.2),patch=F(p.mul(.012),1.3);
 const wetSandC=mix(color('#86705c'),color('#a3896c'),grain);         // warm ochre-tan of the wet beach (West Shore photo)
 const drySandC=mix(color('#c9b493'),color('#d8c6a3'),grain);
 const shingleC=mix(color('#8d877e'),color('#b9b5ad'),V(p.mul(3.1),.7)); // cobbles: grey with pale stones
 const marramC=mix(color('#9a9752'),color('#bcb072'),patch.mul(.6).add(grain.mul(.4)));  // olive-straw marram
 const slackC=mix(color('#7d8a45'),color('#8f9a50'),grain);                            // greener grass in the hollows
 const pastureC=mix(color('#62783c'),color('#76884a'),patch);
 const fellC=mix(color('#5c6a45'),color('#6b704e'),patch);
 const heatherC=mix(color('#5d5249'),color('#6b5d55'),patch);                          // bracken and heather on the tops
 const rockC=mix(color('#8e8a82'),color('#aaa69e'),grain);
 const aboveTide=y.sub(U.tide);
 const wet=float(1).sub(smoothstep(.25,1.8,aboveTide));               // flats still wet from the last tide
 const hwDist=seaField(p).w;                                           // metres inland of high water
 const beach=float(1).sub(smoothstep(12,40,hwDist));
 const hollow=smoothstep(.45,.6,F(p.mul(.02),.8));
 // colours sampled from the Sandscale pano: grey-olive marsh, straw-olive rush bands
 const marshC=mix(mix(color('#4a5139'),color('#5f6547'),patch),color('#666340'),smoothstep(.55,.7,F(p.mul(.06),2.2)).mul(.6));
 const exposed=texture(expTex,p.sub(vec2(far.west,far.north)).div(vec2(far.w*far.res,far.hgt*far.res))).r;
 const estuaryC=mix(color('#5d605a'),color('#8a8676'),smoothstep(2.5,4.5,aboveTide));    // sheltered estuary flats: wet silver-grey
 const sandLike0=mix(wetSandC,drySandC,smoothstep(1.2,3.,aboveTide));
 const flatC=mix(estuaryC,sandLike0,exposed);                                             // exposed tidal flats are beach sand
 const sandLike=mix(wetSandC,drySandC,smoothstep(1.2,3.,aboveTide));
 const duneC=mix(mix(marramC,slackC,hollow.mul(.6)),drySandC.mul(.82),smoothstep(.82,.7,up).mul(smoothstep(.68,.74,F(p.mul(.05),2.6))).mul(.8));
 const PALETTE={1:sandLike,2:shingleC,3:duneC,4:marshC,5:color('#6d6455'),6:mix(color('#3f4f26'),color('#56602f'),grain),7:heatherC,8:pastureC,
  9:mix(color('#2f4326'),color('#3f5530'),patch),10:color('#4c6774'),11:mix(color('#8a8781'),color('#6e7a52'),smoothstep(.45,.6,F(p.mul(.05),.7)).mul(.6)),
  12:rockC,13:slackC,14:flatC,20:color('#58595b'),21:mix(color('#cbc5b7'),color('#ddd8cb'),grain),22:color('#b4a586'),24:mix(color('#6e625e'),color('#8a7f78'),patch)};

 // OpenStreetMap land cover, blended between the four nearest cells (so edges
 // are smooth, not 4 m stair-steps) and nudged by a metre or two of noise so
 // boundaries wander like real vegetation edges.
 const lcMask=landcover&&(()=>{
  const q=p.add(vec2(F(p.mul(.13),.3),F(p.mul(.13),1.9)).sub(.5).mul(3));
  const taps=L=>{
   const f=q.sub(vec2(L.west,L.north)).div(L.res).sub(.5),i0=floor(f),fr=f.sub(i0);
   const at=(ox,oy)=>texture(L.tex,i0.add(vec2(ox+.5,oy+.5)).div(vec2(L.w,L.hgt))).r.mul(255);
   return [[at(0,0),float(1).sub(fr.x).mul(float(1).sub(fr.y))],[at(1,0),fr.x.mul(float(1).sub(fr.y))],[at(0,1),float(1).sub(fr.x).mul(fr.y)],[at(1,1),fr.x.mul(fr.y)]];
  };
  const tn=taps(landcover.near),tf=taps(landcover.far),wNear=inLayer(landcover.near,q,120);
  const eq=(c,k)=>float(1).sub(step(.5,abs(c.sub(k))));
  const sum=(t,k)=>t.reduce((a,[c,w])=>a.add(eq(c,k).mul(w)),float(0));
  return k=>mix(sum(tf,k),sum(tn,k),wNear);
 })();
 const is=k=>lcMask?lcMask(k):float(0);
 const ground0=Fn(()=>{
  // height rules: what the ground is where the map has nothing to say
  const g=mix(wetSandC,drySandC,smoothstep(1.2,3.,aboveTide)).toVar();
  g.assign(mix(g,shingleC,smoothstep(2.6,3.4,y).mul(beach).mul(max(smoothstep(.55,.35,patch.add(grain.mul(.2))),.4))));
  const dune=float(1).sub(beach).mul(smoothstep(3.5,5,y));
  g.assign(mix(g,duneC,dune));
  g.assign(mix(g,pastureC,smoothstep(500,1200,hwDist).mul(smoothstep(4,8,y))));
  g.assign(mix(g,fellC,smoothstep(60,140,y)));
  g.assign(mix(g,heatherC,smoothstep(200,380,y).mul(smoothstep(.3,.6,patch.add(.25)))));
  g.assign(mix(g,rockC,smoothstep(.8,.62,up)));
  if(lcMask){
   const acc=vec3(0).toVar(),wsum=float(0).toVar();
   for(const [k,c] of Object.entries(PALETTE)){const m=is(+k);acc.addAssign(c.mul(m));wsum.addAssign(m);}
   g.assign(acc.add(g.mul(max(float(1).sub(wsum),0))));
  }
  return g;
 })();
 // sand detail: pools in the runnels, a mirror band just above the water,
 // and ripple marks that fade out before they could shimmer at distance
 const sandish=lcMask?is(1).add(is(14)).add(max(float(1).sub([1,2,3,4,5,6,7,8,9,10,11,12,13,14,20,21,22,24].reduce((a,k)=>a.add(is(k)),float(0))),0)):float(1);
 const runnel=F(p.mul(vec2(.05,.006)),.05).mul(.75).add(F(p.mul(vec2(.2,.05)),1.7).mul(.25));
 const pool=smoothstep(.635,.655,runnel).mul(wet).mul(smoothstep(.985,.995,up)).mul(sandish);
 const mirror=float(1).sub(smoothstep(.04,.7,aboveTide)).mul(sandish);                 // freshly uncovered sand
 const ripDir=normalize(vec2(1,.35));
 // ripple marks: sinuous crests that wander and fork (heavy domain warp), in patches
 const ripWarp=F(p.mul(.6),1.1).mul(14).add(F(p.mul(2.2),2.9).mul(3));
 const rip=pow(sin(dot(p,ripDir).mul(20).add(ripWarp)).mul(.5).add(.5),1.6).mul(smoothstep(.3,.6,F(p.mul(.08),.5)).mul(.8).add(.2));
 const ripAmp=sandish.mul(wet.mul(.6).add(.4)).mul(float(1).sub(pool)).mul(float(1).sub(smoothstep(10,40,range)));
 ground.normalNode=bumpMap(rip.mul(ripAmp).mul(.012).add(runnel.mul(.06).mul(sandish)),1);
 const ripTone=mix(1,mix(.9,1.08,rip),ripAmp);   // drier pale crests, wetter dark troughs
 const clay=color('#a7a59e');
 // beyond the grass blades the dunes keep moving: gusts sweep a silver sheen across them
 const duneMask=lcMask?is(3).add(is(4).mul(.6)).add(is(8).mul(.45)).add(is(13).mul(.5)):float(1).sub(beach).mul(smoothstep(4.5,6,y)).mul(float(1).sub(smoothstep(40,90,y)));
 const sheen=gust(p).mul(duneMask);
 const shade=cloudShade(positionWorld);
 ground.colorNode=mix(clay,mix(mix(ground0.mul(ripTone),color('#cfcdb8'),sheen.mul(.22)).mul(mix(1,.62,wet.mul(.5))),color('#55657a'),pool.mul(.6)),U.tint).mul(shade);
 const wetFlat=max(max(wet,is(14).mul(float(1).sub(exposed)).mul(.55)),mirror);    // estuary flats stay glossy long after the tide drops
 ground.roughnessNode=mix(float(.95),mix(mix(mix(.95,.35,wetFlat),.12,mirror),.04,pool),U.tint);
 ground.envNode=sky(vec3(0,1,0)).mul(.18);                                     // soft skylight, no tint from reflections
 const eyeG=normalize(cameraPosition.sub(positionWorld));
 const fresG=float(.02).add(pow(float(1).sub(max(dot(normalWorld,eyeG),0)),5).mul(.98));
 const gloss=max(max(wetFlat.mul(.35),pool),mirror.mul(.85));
 ground.emissiveNode=sky(reflect(eyeG.negate(),normalWorld)).mul(fresG).mul(gloss).mul(U.tint).mul(shade.mul(.5).add(.5));

 // ---------- sea ----------
 // The water plane sits SWASH metres above the tide so the swash can run up
 // the beach; where the water is not really there it is fully transparent.
 const SWASH=.18;
 const sea=new THREE.MeshBasicNodeMaterial({transparent:true,depthWrite:false});
 const seaState=()=>{
  const p=positionWorld.xz,f=seaField(p),dist=f.y,open=f.z;
  const bed=bedAt(p);
  const along=F(p.mul(.004),.9).mul(9).add(F(p.mul(.0011),2.2).mul(7));
  // swash: each wave that reaches the beach runs up and drains back
  const runPhase=U.time.mul(1.15).add(along);
  const run=pow(cos(runPhase).mul(.5).add(.5),3).mul(float(.07).add(U.swell.mul(.11))).mul(open.mul(.6).add(.4));
  const level=U.tide.sub(.02).add(run);
  const depth=max(level.sub(bed),0);
  return [p,dist,open,depth,level.sub(bed),along,run];
 };
 sea.colorNode=Fn(()=>{
  const [p,dist,open,depth,signedDepth,along]=seaState();
  const eye=normalize(cameraPosition.sub(positionWorld)).toVar();
  const range=cameraPosition.sub(positionWorld).length();
  // ripples: two wind-aligned noise layers give the surface normal
  const wdir=normalize(U.wind);
  const rp=p.add(wdir.mul(U.time.mul(1.6)));
  const e=.5,a0=F(rp.mul(.12),.2),ax=F(rp.add(vec2(e,0)).mul(.12),.2),az=F(rp.add(vec2(0,e)).mul(.12),.2);
  const b0=V(rp.mul(.9),1.1),bx=V(rp.add(vec2(.12,0)).mul(.9),1.1),bz=V(rp.add(vec2(0,.12)).mul(.9),1.1);
  const chop=open.mul(.9).add(.15).mul(U.windSpeed.div(7)).mul(smoothstep(.02,.6,depth).mul(.85).add(.15));   // thin sheets are glassy
  const fade=float(1).sub(smoothstep(300,4000,range));
  const g=vec2(ax.sub(a0).div(e).mul(.9).add(bx.sub(b0).div(.12).mul(.08)),az.sub(a0).div(e).mul(.9).add(bz.sub(b0).div(.12).mul(.08))).mul(chop).mul(fade.mul(.7).add(.3));
  const n=normalize(vec3(g.x.negate(),1,g.y.negate()));
  // swell running in along the distance field: steepens, slows and breaks in the shallows
  const H=U.swell.mul(open.mul(.85).add(.15));
  const shoal=float(1).add(float(1).sub(smoothstep(.3,6,depth)).mul(.8));
  const phase=dist.div(38).mul(shoal).mul(6.2832).add(U.time.mul(1.15)).add(along);
  const phase2=dist.div(29).mul(shoal).mul(6.2832).add(U.time.mul(1.32)).add(along.mul(.7)).add(2.1);
  const crest=pow(cos(phase).mul(.5).add(.5),14).add(pow(cos(phase2).mul(.5).add(.5),14).mul(.6));
  const behind=exp(fract(phase.div(6.2832).negate().add(.25)).mul(-4)).add(exp(fract(phase2.div(6.2832).negate().add(.25)).mul(-5)).mul(.5));
  const breaking=smoothstep(H.mul(1.8),H.mul(.7),depth).mul(smoothstep(.1,.35,depth));
  const active=smoothstep(.35,.62,F(p.mul(.018).add(vec2(U.time.mul(.01),0)),1.3).add(crest.mul(.15)));
  const lump=F(p.mul(vec2(.3,.45)).add(U.time.mul(.08)),.6).mul(.6).add(V(p.mul(1.6),.4).mul(.4));
  const front=crest.mul(smoothstep(.3,.55,lump.add(crest.mul(.25))));
  const trail=behind.mul(smoothstep(.5,.72,lump)).mul(.7);
  const surf=breaking.mul(front.mul(1.4).add(trail)).mul(active.mul(.75).add(.25)).mul(open.mul(.6).add(.4));
  // wind whitecaps on open water
  const wc=smoothstep(.72,.8,F(rp.mul(.06),2.1).mul(.6).add(V(rp.mul(.5),.2).mul(.4))).mul(smoothstep(4,10,U.windSpeed)).mul(open).mul(smoothstep(2,6,depth));
  // the swash edge: a lacy line of foam at the leading edge, bubbles left behind it
  const lace=smoothstep(.42,.62,F(p.mul(vec2(1.4,2.2)).add(U.time.mul(.12)),1.7).mul(.6).add(V(p.mul(6),.9).mul(.4)));
  const edge=smoothstep(.0,.006,signedDepth).mul(float(1).sub(smoothstep(.012,.045,signedDepth))).mul(lace.mul(.8).add(.2));
  const bubbles=smoothstep(.04,.12,depth).mul(float(1).sub(smoothstep(.25,.6,depth))).mul(smoothstep(.62,.75,lace.add(V(p.mul(14),.3).mul(.3)))).mul(.5);
  const foam=clamp(surf.add(wc).add(edge).add(bubbles),0,1).toVar();
  // water body by depth: silty sand-grey in the shallows (as in the West Shore photo), teal, deep blue-grey
  const body=mix(color('#8c8770'),color('#6f7e72'),smoothstep(.15,1.2,depth)).toVar();
  body.assign(mix(body,color('#3c6470'),smoothstep(1.2,4,depth)));
  body.assign(mix(body,color('#264b5e'),smoothstep(5,14,depth)));
  body.mulAssign(float(.75).add(max(U.sun.y,0).mul(.35)).mul(cloudShade(positionWorld)));
  const ndv=max(dot(n,eye),0);
  const fres=float(.02).add(pow(float(1).sub(ndv),5).mul(.98));
  const refl=sky(reflect(eye.negate(),n)).mul(.85);
  const col=mix(body,refl,fres).toVar();
  col.addAssign(color('#fff3dc').mul(pow(max(dot(reflect(U.sun.negate(),n),eye),0),220).mul(4)).mul(cloudShade(positionWorld)));
  col.assign(mix(col,color('#f1f3f2').mul(float(.85).add(max(U.sun.y,0).mul(.2))).mul(cloudShade(positionWorld).mul(.4).add(.6)),foam));
  return col;
 })();
 sea.opacityNode=Fn(()=>{
  const [p,,,depth,signedDepth]=seaState();
  const eye=normalize(cameraPosition.sub(positionWorld));
  const fres=pow(float(1).sub(max(eye.y,0)),5);
  // a thin swash sheet is mostly see-through, except where it mirrors the sky
  const there=smoothstep(0,.006,signedDepth);
  return there.mul(max(smoothstep(0,1.4,depth).mul(.72).add(.28),fres));
 })();
 sea.fog=true;

 // CPU twins for placing things: zone at a point from the far grid
 const fieldAt=(arr,x,z)=>{const i=Math.min(Math.max(Math.round((x-far.west)/far.res-.5),0),far.w-1),j=Math.min(Math.max(Math.round((z-far.north)/far.res-.5),0),far.hgt-1);return arr[j*far.w+i];};
 const hwDistAt=(x,z)=>fieldAt(hw,x,z)*far.res;
 return {U,sky,skyMaterial,ground,sea,updateSea,gust,cloudShade,F,V,hwDistAt,SWASH};
}
