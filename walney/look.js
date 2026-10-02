import * as THREE from 'three/webgpu';
import {Fn,uniform,float,vec2,vec3,vec4,color,texture,mix,smoothstep,max,min,abs,pow,dot,normalize,reflect,clamp,cos,exp,fract,
 positionWorld,normalWorld,cameraPosition,reflectVector,If,positionView,screenUV,viewportDepthTexture,perspectiveDepthToViewZ,cameraNear,cameraFar} from 'three/tsl';

// The look of the Walney scene, matched to a summer midday photo from the West
// Shore: deep blue sky with high cirrus and a low cloud bank on the horizon,
// light haze, wet sand with sky-mirror pools, a shingle bank, green fells, and
// a sea coloured by depth with breaker lines that follow the real waterline.
export function createLook({noiseTex,far,tide}){
 const U={
  sun:uniform(new THREE.Vector3(0,1,0)),time:uniform(0),tide:uniform(tide),tint:uniform(1),
  wind:uniform(new THREE.Vector2(.8,.6)),windSpeed:uniform(7),   // m/s, blowing toward +x/+z (onshore from the south-west)
  swell:uniform(1.2),haze:uniform(1)
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

 // ---------- sky ----------
 const sky=Fn(([dir])=>{
  const d=normalize(dir).toVar(),el=max(d.y,0);
  const zenith=color('#2f6cc6'),mid=color('#5d95d8'),horizon=color('#b2d0e8');
  const c=mix(horizon,mid,smoothstep(0,.22,el)).toVar();
  c.assign(mix(c,zenith,smoothstep(.22,.95,el)));
  const sd=max(dot(d,U.sun),0);
  c.addAssign(color('#fff1d6').mul(pow(sd,48).mul(.35).add(pow(sd,2400).mul(30))));
  // high cirrus: a cloud layer 9 km up, combed out along the wind
  const pc=d.xz.div(max(d.y,.03)).mul(9000);
  const wdir=normalize(U.wind),across=vec2(wdir.y.negate(),wdir.x);
  const ci=vec2(dot(pc,wdir).mul(.00003),dot(pc,across).mul(.00022)).add(vec2(U.time.mul(.0004),0));
  const cirrus=pow(smoothstep(.45,.85,F(ci,.3)),2).mul(smoothstep(.04,.25,el)).mul(.55);
  c.assign(mix(c,color('#f4f7fb'),cirrus));
  // low cloud bank: a broken layer 1.4 km up that piles toward the horizon
  const pl=d.xz.div(max(d.y,.012)).mul(1400).mul(.00011).add(vec2(U.time.mul(.0006),U.time.mul(.0002)));
  const dens=F(pl,1.1).mul(.7).add(F(pl.mul(2.7),2.3).mul(.3));
  const low=smoothstep(.56,.68,dens).mul(float(1).sub(smoothstep(.02,.11,el))).mul(smoothstep(0,.004,el));
  const lit=smoothstep(.5,.75,F(pl.add(U.sun.xz.mul(.02)),1.1));
  c.assign(mix(c,mix(color('#93a3b8'),color('#eef1f5'),lit),low.mul(.9)));
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

 // ---------- ground ----------
 const ground=new THREE.MeshStandardNodeMaterial({roughness:.95});
 const y=positionWorld.y,up=normalWorld.y,p=positionWorld.xz;
 const grain=F(p.mul(.9),.2),patch=F(p.mul(.012),1.3);
 const wetSandC=mix(color('#857064'),color('#a08876'),grain);         // warm brown-pink of the wet flats
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
 const ground0=Fn(()=>{
  const g=mix(wetSandC,drySandC,smoothstep(1.2,3.,aboveTide)).toVar();
  // shingle and cobbles along the top of the beach
  g.assign(mix(g,shingleC,smoothstep(2.6,3.4,y).mul(beach).mul(max(smoothstep(.55,.35,patch.add(grain.mul(.2))),.4))));
  // dunes: marram on the ridges, greener slacks in the hollows, the odd bare blowout
  const dune=float(1).sub(beach).mul(smoothstep(3.5,5,y));
  const hollow=smoothstep(.45,.6,F(p.mul(.02),.8));
  g.assign(mix(g,mix(marramC,slackC,hollow.mul(.6)),dune));
  g.assign(mix(g,drySandC.mul(.82),dune.mul(smoothstep(.82,.7,up)).mul(smoothstep(.68,.74,F(p.mul(.05),2.6))).mul(.8)));
  g.assign(mix(g,pastureC,smoothstep(500,1200,hwDist).mul(smoothstep(4,8,y))));
  g.assign(mix(g,fellC,smoothstep(60,140,y)));
  g.assign(mix(g,heatherC,smoothstep(200,380,y).mul(smoothstep(.3,.6,patch.add(.25)))));
  g.assign(mix(g,rockC,smoothstep(.8,.62,up)));
  return g;
 })();
 // pools left on the flats: low, flat, mirror the sky
 const runnel=F(p.mul(vec2(.05,.006)),.05).mul(.75).add(F(p.mul(vec2(.2,.05)),1.7).mul(.25));
 const pool=smoothstep(.635,.655,runnel).mul(wet).mul(smoothstep(.985,.995,up));
 const clay=color('#a7a59e');
 // beyond the grass blades the dunes keep moving: gusts sweep a silver sheen across them
 const duneMask=float(1).sub(beach).mul(smoothstep(4.5,6,y)).mul(float(1).sub(smoothstep(40,90,y)));
 const sheen=gust(p).mul(duneMask);
 ground.colorNode=mix(clay,mix(mix(ground0,color('#cfcdb8'),sheen.mul(.22)).mul(mix(1,.55,wet.mul(.5))),color('#6f86a3'),pool.mul(.85)),U.tint);
 ground.roughnessNode=mix(float(.95),mix(mix(.95,.35,wet),.04,pool),U.tint);
 ground.envNode=sky(reflectVector).mul(mix(.12,mix(.12,.75,max(wet.mul(.25),pool)),U.tint));

 // ---------- sea ----------
 const sea=new THREE.MeshBasicNodeMaterial({transparent:true,depthWrite:false});
 sea.colorNode=Fn(()=>{
  const p=positionWorld.xz,f=seaField(p),dist=f.y,open=f.z;
  const thick=max(positionView.z.sub(perspectiveDepthToViewZ(viewportDepthTexture(screenUV),cameraNear,cameraFar)),0);
  const depth=max(min(U.tide.sub(f.x),thick.mul(.35)),0).toVar();
  const eye=normalize(cameraPosition.sub(positionWorld)).toVar();
  const range=cameraPosition.sub(positionWorld).length();
  // ripples: two wind-aligned noise layers give the surface normal
  const wdir=normalize(U.wind);
  const rp=p.add(wdir.mul(U.time.mul(1.6)));
  const e=.5,a0=F(rp.mul(.12),.2),ax=F(rp.add(vec2(e,0)).mul(.12),.2),az=F(rp.add(vec2(0,e)).mul(.12),.2);
  const b0=V(rp.mul(.9),1.1),bx=V(rp.add(vec2(.12,0)).mul(.9),1.1),bz=V(rp.add(vec2(0,.12)).mul(.9),1.1);
  const chop=open.mul(.9).add(.15).mul(U.windSpeed.div(7));
  const fade=float(1).sub(smoothstep(300,4000,range));
  const g=vec2(ax.sub(a0).div(e).mul(.9).add(bx.sub(b0).div(.12).mul(.08)),az.sub(a0).div(e).mul(.9).add(bz.sub(b0).div(.12).mul(.08))).mul(chop).mul(fade.mul(.7).add(.3));
  const n=normalize(vec3(g.x.negate(),1,g.y.negate()));
  // swell running in to the shore along the distance field; it steepens,
  // slows and breaks as the water shallows, so a flat beach gets many lines
  const H=U.swell.mul(open.mul(.85).add(.15));
  const along=F(p.mul(.004),.9).mul(9).add(F(p.mul(.0011),2.2).mul(7));
  const shoal=float(1).add(float(1).sub(smoothstep(.3,6,depth)).mul(.8));
  const phase=dist.div(38).mul(shoal).mul(6.2832).add(U.time.mul(1.15)).add(along);
  const phase2=dist.div(29).mul(shoal).mul(6.2832).add(U.time.mul(1.32)).add(along.mul(.7)).add(2.1);
  const crest=pow(cos(phase).mul(.5).add(.5),14).add(pow(cos(phase2).mul(.5).add(.5),14).mul(.6));
  const behind=exp(fract(phase.div(6.2832).negate().add(.25)).mul(-4)).add(exp(fract(phase2.div(6.2832).negate().add(.25)).mul(-5)).mul(.5));
  const breaking=smoothstep(H.mul(1.8),H.mul(.7),depth).mul(smoothstep(.02,.15,depth));
  // only stretches of each crest are breaking at once, and the foam is lumpy
  const active=smoothstep(.35,.62,F(p.mul(.018).add(vec2(U.time.mul(.01),0)),1.3).add(crest.mul(.15)));
  const lump=F(p.mul(vec2(.3,.45)).add(U.time.mul(.08)),.6).mul(.6).add(V(p.mul(1.6),.4).mul(.4));
  const front=crest.mul(smoothstep(.3,.55,lump.add(crest.mul(.25))));
  const trail=behind.mul(smoothstep(.5,.72,lump)).mul(.7);
  const surf=breaking.mul(front.mul(1.4).add(trail)).mul(active.mul(.75).add(.25)).mul(open.mul(.6).add(.4));
  // wind whitecaps on open water
  const wc=smoothstep(.72,.8,F(rp.mul(.06),2.1).mul(.6).add(V(rp.mul(.5),.2).mul(.4))).mul(smoothstep(4,10,U.windSpeed)).mul(open).mul(smoothstep(2,6,depth));
  // a lumpy line of foam where the water meets the sand
  const edge=smoothstep(.9,.05,thick).mul(smoothstep(.0,.04,thick)).mul(smoothstep(.35,.6,lump));
  const foam=clamp(surf.add(wc).add(edge.mul(.9)),0,1).toVar();
  // water body by depth: sandy green over the flats, teal, then deep blue-grey
  const body=mix(color('#7f8d6a'),color('#2c6670'),smoothstep(.2,2.5,depth)).toVar();
  body.assign(mix(body,color('#1f4a5c'),smoothstep(4,14,depth)));
  body.mulAssign(float(.75).add(max(dot(U.sun,vec3(0,1,0)),0).mul(.35)));
  const ndv=max(dot(n,eye),0);
  const fres=float(.02).add(pow(float(1).sub(ndv),5).mul(.98));
  const refl=sky(reflect(eye.negate(),n)).mul(.85);
  const col=mix(body,refl,fres).toVar();
  col.addAssign(color('#fff3dc').mul(pow(max(dot(reflect(U.sun.negate(),n),eye),0),220).mul(4)));
  col.assign(mix(col,color('#f1f3f2').mul(float(.85).add(max(U.sun.y,0).mul(.2))),foam));
  return col;
 })();
 sea.opacityNode=Fn(()=>{
  const thick=max(positionView.z.sub(perspectiveDepthToViewZ(viewportDepthTexture(screenUV),cameraNear,cameraFar)),0);
  return smoothstep(0,.08,thick).mul(smoothstep(0,2.5,thick).mul(.7).add(.3));
 })();
 sea.fog=true;

 // CPU twins for placing things: zone at a point from the far grid
 const fieldAt=(arr,x,z)=>{const i=Math.min(Math.max(Math.round((x-far.west)/far.res-.5),0),far.w-1),j=Math.min(Math.max(Math.round((z-far.north)/far.res-.5),0),far.hgt-1);return arr[j*far.w+i];};
 const hwDistAt=(x,z)=>fieldAt(hw,x,z)*far.res;
 return {U,sky,skyMaterial,ground,sea,updateSea,gust,F,V,hwDistAt};
}
