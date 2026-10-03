import * as THREE from 'three/webgpu';
import {STARS} from './sky-clock.js';
import {createAtmosphere} from './atmo.js';
import {Fn,uniform,float,vec2,vec3,vec4,color,texture,mix,smoothstep,max,min,abs,pow,dot,normalize,reflect,clamp,cos,sin,acos,exp,fract,floor,step,length,fog,asin,sign,sqrt,dFdx,dFdy,select,screenUV,screenCoordinate,uniformArray,output,log,
 positionWorld,normalWorld,cameraPosition,reflectVector,bumpMap} from 'three/tsl';

// The look of the Walney scene, matched to photos of the place: summer sky
// with cumulus and their moving shadows, light haze, wet sand that mirrors the
// clouds, a shingle bank, marram dunes, grey-olive saltmarsh, and a sea whose
// breakers and swash follow the real waterline at whatever the tide is.
export function createLook({noiseTex,detailTex,far,near,tide,landcover,armourTex,surfaceTex}){
 const U={
  sun:uniform(new THREE.Vector3(0,1,0)),time:uniform(0),tide:uniform(tide),tint:uniform(1),
  wind:uniform(new THREE.Vector2(.87,-.5)),windSpeed:uniform(7),   // m/s; blowing toward the ENE (a south-westerly, onshore here)
  swell:uniform(.8),clouds:uniform(.5),haze:uniform(1),
  debug:uniform(0),overcast:uniform(0),waveScale:uniform(.55),
  // physical light, all pre-exposed (cd/m2 x expo): set each frame from the atmosphere model
  expo:uniform(2.5e-5),sunE:uniform(3.2),sunT:uniform(new THREE.Vector3(.9,.8,.7)),msG:uniform(new THREE.Vector3()),
  bR:uniform(new THREE.Vector3(5.802e-6,13.558e-6,33.1e-6)),bMs:uniform(1.5e-5),bMe:uniform(1.6e-5),zenTau:uniform(new THREE.Vector3(.05,.11,.27)),
  deckL:uniform(new THREE.Vector3()),deckCover:uniform(0),sunDirect:uniform(1),
  starGain:uniform(2**2.5),   // the dark-adapted eye sees more stars than a camera at the same exposure
  stars:uniformArray(STARS.map(()=>new THREE.Vector4(0,-1,0,0)),'vec4'),   // scene direction + brightness, set by the sky clock
  toCel:uniform(new THREE.Matrix3()),                                          // scene direction -> celestial frame, set by the sky clock
  sunLight:uniform(new THREE.Vector3(3,3,3)),skyAmb:uniform(new THREE.Vector3(.2,.3,.5))   // scene-unit sun and skylight, set from the sun's height
 };
 const noise=uv=>texture(noiseTex,uv);
 const rot=(p,a)=>vec2(p.x.mul(Math.cos(a)).sub(p.y.mul(Math.sin(a))),p.x.mul(Math.sin(a)).add(p.y.mul(Math.cos(a))));
 const F=(p,a=0)=>noise(rot(p,a).mul(1/8)).r;   // ~1 cycle per unit, four octaves
 const V=(p,a=0)=>noise(rot(p,a).mul(1/48)).g;
 // for textures seen over wide areas (sand grain, foam): gradient noise, which has no lattice
 // lines (src/noise.js makeDetailNoiseTexture), hex-tiled so it never repeats. Same mean and
 // spread as F and V.
 // Hex tiling (Mikkelsen 2022, "texture bombing"): the surface is cut into hexagons, each reading
 // the tile with its own random turn and shift, blended at the seams with a contrast-keeping mix,
 // so the grain never repeats and stays crisp. Gradients are turned with each read (no seam lines
 // from the mipmaps). Fragment stage only.
 const hh2=v=>fract(sin(vec2(dot(v,vec2(127.1,311.7)),dot(v,vec2(269.5,183.3)))).mul(43758.5453));
 const hexTex=uv=>{
  const dx=dFdx(uv),dy=dFdy(uv);
  const g=uv.mul(3.4641016*1.6);                                   // hexes ~0.6 of a tile across
  const sk=vec2(g.x.sub(g.y.mul(.57735027)),g.y.mul(1.15470054));
  const b=floor(sk),f=fract(sk),z=float(1).sub(f.x).sub(f.y);
  const s=step(z,0),s2=s.mul(2).sub(1);
  const w=vec3(z.negate().mul(s2),s.sub(f.y.mul(s2)),s.sub(f.x.mul(s2)));
  const read=v=>{
   const h=hh2(v),a=h.x.mul(6.2832),c=cos(a),sn=sin(a);
   const R=q=>vec2(q.x.mul(c).sub(q.y.mul(sn)),q.x.mul(sn).add(q.y.mul(c)));
   return texture(detailTex,R(uv).add(h.mul(17))).grad(R(dx),R(dy)).rg;
  };
  const wp=pow(max(w,0),vec3(4)),wn=wp.div(wp.x.add(wp.y).add(wp.z));
  const m=vec2(.462,.5);                                           // the texture's means: keep its spread
  return read(b.add(vec2(s,s))).sub(m).mul(wn.x).add(read(b.add(vec2(s,float(1).sub(s)))).sub(m).mul(wn.y))
   .add(read(b.add(vec2(float(1).sub(s),s))).sub(m).mul(wn.z)).div(sqrt(dot(wn,wn))).add(m);
 };
 const Fq=(p,a=0)=>hexTex(rot(p,a).mul(1/8)).x;
 const Vq=(p,a=0)=>hexTex(rot(p,a).mul(1/48)).y;

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

 // ---------- atmosphere ----------
 // The sky comes from a physically based model (atmo.js): a small table of sky
 // radiance around the sun, rebuilt on the CPU when the sun or haze moves. Here it
 // is looked up, scaled by the exposed sun, and the sun's disc, the faint airglow of
 // the night sky and the overcast deck are added. Values are pre-exposed HDR.
 const atmo=createAtmosphere();
 const skyData=new Uint16Array(atmo.SW*atmo.SH*4);
 const skyTex=new THREE.DataTexture(skyData,atmo.SW,atmo.SH,THREE.RGBAFormat,THREE.HalfFloatType);
 skyTex.magFilter=skyTex.minFilter=THREE.LinearFilter;skyTex.wrapS=skyTex.wrapT=THREE.ClampToEdgeWrapping;
 const updateSkyTex=()=>{
  const h=THREE.DataUtils.toHalfFloat;
  for(let i=0;i<atmo.SW*atmo.SH;i++){for(let c=0;c<3;c++)skyData[i*4+c]=h(atmo.sky[i*3+c]*1e3);skyData[i*4+3]=h(1);}
  skyTex.needsUpdate=true;
 };
 const hg=(c,g)=>float(1-g*g).div(pow(float(1+g*g).sub(c.mul(2*g)),1.5).mul(12.566));
 const clearSky=Fn(([d])=>{
  const s=normalize(U.sun);
  const el=asin(clamp(d.y,-1,1));
  const az=acos(clamp(dot(normalize(d.xz.add(vec2(1e-6,0))),normalize(s.xz.add(vec2(1e-6,0)))),-1,1)).div(Math.PI);
  const v=sign(el).mul(sqrt(abs(el).div(Math.PI/2))).mul(.5).add(.5);
  const uv=vec2(az.mul(atmo.SW-1).add(.5).div(atmo.SW),v.mul(atmo.SH-1).add(.5).div(atmo.SH));
  return texture(skyTex,uv).rgb.mul(U.sunE.mul(1e-3));
 });
 // the overcast deck, as the CIE overcast sky: three times brighter overhead than at the
 // horizon, L = Lz (1 + 2 sin el) / 3, scaled so it gives the ground the same light. Thicker
 // patches of the deck let less through.
 const deck=d=>{
  const pc=d.xz.div(max(d.y,.04)).mul(1400).add(normalize(U.wind).mul(U.time.mul(U.windSpeed)));
  const thick=F(pc.mul(1/3000),.9).mul(.6).add(F(pc.mul(1/900),2.3).mul(.4));
  const patchy=mix(1.25,.6,smoothstep(.35,.75,thick)).mul(smoothstep(.03,.2,d.y)).add(smoothstep(.2,.03,d.y).mul(.95));   // smooth toward the horizon
  return U.deckL.mul(max(d.y,0).mul(2).add(1).mul(9/21)).mul(patchy);
 };
 const atmosphere=Fn(([dir])=>{
  const d=normalize(dir).toVar(),c=dot(d,normalize(U.sun));
  const col=clearSky(d).toVar();
  // the sun's disc (radius ~0.5 deg, solid angle 2.5e-4 sr), dimmed by any deck
  col.addAssign(U.sunT.mul(U.sunE.div(.00025)).mul(U.sunDirect).mul(smoothstep(.99994,.99998,c)).mul(step(0,d.y)).min(6e4));
  col.addAssign(vec3(.75,.9,1.2).mul(1.6e-4).mul(U.expo));                       // airglow: the moonless night sky, ~22 mag/arcsec2
  return mix(col,deck(d),U.deckCover);
 });

 // ---------- clouds ----------
 // Cumulus live in a slab 1.4-2.7 km up, drifting with the wind. Their large
 // shapes come from smooth noise; Worley (cellular) noise eats the edges into
 // cauliflower billows. The sky ray-marches the slab; reflections, cloud
 // shadows and the ground use a cheap flat version of the same field.
 const CB=1400,CT=2700;
 const hash22=p=>{const p3=fract(vec3(p.x,p.y,p.x).mul(vec3(.1031,.1030,.0973))).toVar();p3.addAssign(dot(p3,p3.yzx.add(33.33)));return fract(p3.xx.add(p3.yz).mul(p3.zy));};
 const worley=Fn(([p])=>{
  const i=floor(p),f=fract(p),md=float(8).toVar();
  for(let y=-1;y<=1;y++)for(let x=-1;x<=1;x++){const o=vec2(x,y);md.assign(min(md,length(o.add(hash22(i.add(o))).sub(f))));}
  return md;
 });
 const drift=()=>normalize(U.wind).mul(U.time.mul(U.windSpeed).mul(1.4));
 const coverage=xz=>{const q=xz.sub(drift());return F(q.mul(1/5200),.7).mul(.62).add(F(q.mul(1/1700),1.9).mul(.38));};
 const threshold=()=>mix(float(.74),float(.38),U.clouds);
 const cloudDensity=Fn(([xz])=>smoothstep(threshold(),threshold().add(.05),coverage(xz)));    // flat version
 const density3=pos=>{
  const h=clamp(pos.y.sub(CB).div(CT-CB),0,1);
  const q=pos.xz.sub(drift());
  const shape=coverage(pos.xz).sub(threshold().add(pow(h,1.4).mul(.55)));        // tops need much more cover: rounded domes, never a flat lid
  const w=worley(q.mul(1/560).add(vec2(pos.y.mul(.0011),0))).mul(.65).add(worley(q.mul(1/170).add(vec2(0,pos.y.mul(.003)))).mul(.35));
  return clamp(shape.sub(w.mul(.16).mul(float(1).sub(h.mul(.4)))).mul(7),0,1).mul(smoothstep(0,.05,h));
 };
 const cloudShade=Fn(([pw])=>{                       // 1 in sun, ~.4 in cloud shadow
  const s=normalize(U.sun);
  const onLayer=pw.xz.add(s.xz.div(max(s.y,.15)).mul(float(CB+400).sub(pw.y)));
  return float(1).sub(cloudDensity(onLayer).mul(.6).mul(smoothstep(0,.08,s.y)).mul(float(1).sub(U.overcast)));
 });
 const cloudMarch=Fn(([dir])=>{
  const d=normalize(dir),s=normalize(U.sun),c=dot(d,s);
  const dy=max(d.y,.02);
  const t0=float(CB).sub(cameraPosition.y).div(dy),t1=float(CT).sub(cameraPosition.y).div(dy);
  const STEPS=16,ds=t1.sub(t0).div(STEPS);
  const jit=fract(fract(dot(screenCoordinate.xy,vec2(.06711056,.00583715))).mul(52.9829189));   // interleaved gradient noise: even, low-grain jitter
  const T=float(1).toVar(),L=vec3(0).toVar();
  const phase=mix(hg(c,.6),hg(c,-.25),.35).mul(9);                     // forward-scattering silver toward the sun
  for(let k=0;k<STEPS;k++){
   const t=t0.add(ds.mul(float(k).add(jit)));
   const pos=cameraPosition.add(d.mul(t));
   const den=density3(pos);
   const h=clamp(pos.y.sub(CB).div(CT-CB),0,1);
   const toward=cloudDensity(pos.xz.add(s.xz.mul(260)));                 // how much cloud lies toward the sun
   const sunT=exp(toward.mul(float(1).sub(h.mul(.6))).mul(-2.6));
   const powder=float(1).sub(exp(den.mul(-3)));                          // dark cores, bright edges
   // physical scale: a thick cloud's sunlit side glows at ~0.25 x the sun's illuminance (albedo ~0.7 / pi)
   const S=U.sunLight.mul(sunT).mul(phase.add(.8)).mul(powder.mul(.6).add(.4)).mul(.26).add(U.skyAmb.mul(float(.35).add(h.mul(.65))).mul(1.1));
   const a=float(1).sub(exp(den.mul(ds).mul(-.012)));
   L.addAssign(S.mul(a).mul(T));
   T.mulAssign(float(1).sub(a));
  }
  // distant clouds sink into the haze
  const far=float(1).sub(exp(t0.mul(-1/30000).mul(U.haze.add(.3))));
  // and right on the horizon, where samples are too far apart to resolve a cloud, fade them out
  const low=smoothstep(.025,.07,d.y);
  return vec4(mix(L,atmosphere(d).mul(float(1).sub(T)),far).mul(low),mix(1,T,low));   // into the sky behind them, not a white veil
 });

 // ---------- sky ----------
 // skyFull: the dome, with ray-marched clouds. sky: the cheap version used for
 // reflections on wet sand and water, and for skylight on the ground.
 const cirrus=d=>{
  const pc=d.xz.div(max(d.y,.03)).mul(9000);
  const wdir=normalize(U.wind),across=vec2(wdir.y.negate(),wdir.x);
  const ci=vec2(dot(pc,wdir).mul(.00003),dot(pc,across).mul(.00022)).add(vec2(U.time.mul(.0004),0));
  return pow(smoothstep(.45,.85,F(ci,.3)),2).mul(smoothstep(.04,.25,d.y)).mul(float(.2).sub(U.clouds.mul(.12)));   // faint wisps, as in the pano
 };
 // blur: how rough the mirror is (0 sharp, 1 rough sea). A rough surface tilts each bit of the
 // reflection a different way, so clouds come back as soft, low-contrast smears, not sharp shapes.
 const skyCore=(dir,blur)=>{
  const d=normalize(dir).toVar();
  const c=atmosphere(d).toVar();
  c.assign(mix(c,U.sunLight.mul(.08).add(U.skyAmb.mul(.8)),cirrus(d)));
  const t=float(CB+400).sub(cameraPosition.y).div(max(d.y,.02)),at=cameraPosition.xz.add(d.xz.mul(t));
  // lit as the ray-marched clouds are (same sun phase, shadow from the cloud toward the sun,
  // skylight), and fading into the haze with distance the same way, so reflections match the sky
  const s=normalize(U.sun),cs=dot(d,s);
  // seen from below (as in any reflection) a cloud shows its shaded base, not its sunlit top
  const sunT=exp(cloudDensity(at.add(s.xz.mul(260))).mul(-2.6));
  const cloudC=U.sunLight.mul(sunT).mul(mix(hg(cs,.6),hg(cs,-.25),.35).mul(9).add(.8)).mul(.8*.26*.45).add(U.skyAmb.mul(.77));
  const far=float(1).sub(exp(t.mul(-1/30000).mul(U.haze.add(.3))));
  const th=threshold();
  const dens=smoothstep(th.sub(blur.mul(.15)),th.add(.05).add(blur.mul(.25)),coverage(at)).mul(smoothstep(.025,.07,d.y)).mul(float(1).sub(far));
  c.assign(mix(c,cloudC,dens.mul(.9).mul(float(1).sub(blur.mul(.4)))));
  return c;
 };
 const sky=Fn(([dir])=>skyCore(dir,float(0)));
 const skyFull=Fn(([dir])=>{
  const d=normalize(dir).toVar();
  const c=atmosphere(d).toVar();
  c.assign(mix(c,U.sunLight.mul(.08).add(U.skyAmb.mul(.8)),cirrus(d)));   // thin ice: dim, mostly sky-lit
  const cl=cloudMarch(d);
  // cumulus sink into the deck as it thickens, leaving darker shapes in the grey
  const withClouds=c.mul(cl.w).add(cl.xyz).add(c.mul(float(1).sub(cl.w)).mul(U.overcast.mul(.8))).toVar();   // under the deck, cloud takes the deck's grey light
  // the stars at their real brightness: a star of magnitude m gives 2.08e-6 x 10^(-0.4 m) lux,
  // spread over a small spot. No day/night switch: by day the sky is ten thousand times brighter
  // and they vanish; at night the exposure opens up and they appear. Air dims them low down.
  const clearView=pow(float(1).sub(U.overcast),2).mul(cl.w).mul(float(1).sub(U.deckCover)).mul(step(0,d.y))
   .mul(exp(U.zenTau.mul(float(1).div(max(d.y,.035))).negate()));
  const starLight=float(0).toVar();
  for(let i=0;i<STARS.length;i++){const e=U.stars.element(i);const tw=sin(U.time.mul(5+i%7).add(i*2.3)).mul(.15).add(.85);starLight.addAssign(e.w.mul(tw).mul(exp(dot(d,e.xyz).sub(1).div(1.4e-6))));}
  withClouds.addAssign(vec3(1,.96,.9).mul(clearView).mul(starLight.mul(2.08e-6/(2*Math.PI*1.4e-6))).mul(U.expo).mul(U.starGain));
  // the fainter stars (magnitude 4-7, ~900 per steradian, random but turning with the real sky)
  // and the Milky Way along its true path (~21 mag/arcsec2 at its brightest)
  const cel=U.toCel.mul(d);
  const q=cel.mul(240),cell=floor(q),h3=fract(sin(vec3(dot(cell,vec3(127.1,311.7,74.7)),dot(cell,vec3(269.5,183.3,246.1)),dot(cell,vec3(113.5,271.9,124.6)))).mul(43758.5453));
  const off=fract(q).sub(h3.mul(.4).add(.3));
  const mag=float(7).sub(pow(h3.y,2).mul(3));
  const fill=step(.985,h3.x).mul(exp(dot(off,off).div(-.04))).mul(pow(float(10),mag.mul(-.4))).mul(2.08e-6/(2*Math.PI*.02/(240*240)));
  const gp=vec3(-.8676,-.1981,.456),gc=vec3(-.055,-.8734,-.4839);
  const band=exp(pow(dot(cel,gp),2).div(-.016)).mul(dot(cel,gc).mul(.5).add(.6)).mul(F(cel.xy.mul(26).add(cel.z.mul(11)),.4).mul(.8).add(.4));
  withClouds.addAssign(vec3(1,.97,.92).mul(fill.mul(U.starGain).add(band.mul(5e-4))).mul(clearView).mul(U.expo));   // the eye picks out points, not faint glow
  return withClouds.mul(step(0,d.y)).add(atmosphere(vec3(d.x,.0,d.z)).mul(step(d.y,0)));
 });
 // what a rough water or wet surface mirrors: facets tilt the view up off the pale horizon band,
 // so distant water reads darker and bluer than the sky just above it
 const skyRefl=Fn(([r,blur])=>skyCore(vec3(r.x,max(r.y,0).mul(.75).add(.09),r.z),blur));
 const skyMaterial=new THREE.MeshBasicNodeMaterial({side:THREE.BackSide,depthWrite:false,fog:false});
 skyMaterial.colorNode=skyFull(positionWorld.sub(cameraPosition));

 // ---------- aerial perspective ----------
 // Hillaire's aerial perspective, evaluated per pixel: along the path to a surface the
 // air and haze (densities averaged over the path's heights) dim what is behind
 // and add in-scattered sunlight, multiple scattering, or the deck's grey light.
 // Blue scatters most, so distant land takes a blue veil and only far off washes pale.
 const aerial=Fn(([surf])=>{
  const v=positionWorld.sub(cameraPosition),dist=v.length(),n=v.div(dist);
  const y0=cameraPosition.y,y1=positionWorld.y,ym=y0.add(y1).mul(.5);
  const avg=H=>{const e=y=>exp(max(y,-50).div(-H));return e(y0).add(e(ym).mul(4)).add(e(y1)).div(6);};
  const rR=avg(atmo.HR),rM=avg(atmo.HM);
  const sR=U.bR.mul(rR),sM=U.bMs.mul(rM),scat=sR.add(sM);
  const ext=U.bR.mul(rR).add(U.bMe.mul(rM)).max(1e-9);
  const c=dot(n,normalize(U.sun));
  const pR=c.mul(c).add(1).mul(3/(16*Math.PI)),pM=hg(c,atmo.GM);
  const clear=U.sunT.mul(sR.mul(pR).add(sM.mul(pM))).add(U.msG.mul(scat)).mul(U.sunE);
  const grey=U.deckL.mul(scat).mul(.6);                 // lit evenly from above, and a little from the ground
  const S=mix(clear,grey,U.deckCover);
  const Tr=exp(ext.mul(dist).negate());
  return surf.mul(Tr).add(S.div(ext).mul(vec3(1).sub(Tr)));
 });
 const fogNode=Fn(()=>vec4(aerial(output.rgb),output.a))();

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
 // off the map (the offshore wind farms lie 10-40 km out) the field fades, over 5 km, to open sea: 30 m deep,
 // far from any shore, fully exposed (instead of the edge values smeared outward)
 const seaField=p=>mix(vec4(-30,20000,1,20000),texture(fieldTex,p.sub(vec2(far.west,far.north)).div(vec2(far.w*far.res,far.hgt*far.res))),inLayer(far,p,5000));

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
 const ground=new THREE.MeshPhysicalNodeMaterial({roughness:.95});
 const y=positionWorld.y,up=normalWorld.y,p=positionWorld.xz;
 const range=cameraPosition.sub(positionWorld).length();
 // sand grain, its strength varying over ~100 m so there is no even field to spot a repeat in
 const grain0=mix(float(.46),Fq(p.mul(.9),.2),smoothstep(.3,.7,F(p.mul(.01),.6)).mul(.9).add(.35));
 // finer grain up close (~5 cm), and a speckle at your feet (~1.5 cm), each fading before it could shimmer
 const grain=grain0.add(Fq(p.mul(3.7),1.1).sub(.462).mul(.7).mul(float(1).sub(smoothstep(12,45,range))))
  .add(Fq(p.mul(12.3),2.3).sub(.462).mul(.8).mul(float(1).sub(smoothstep(3,12,range)))),patch=F(p.mul(.012),1.3);
 const tone=F(p.mul(.033),1.9).sub(.46).mul(.22).add(1);   // ~30 m patches, a little damper or drier
 const wetSandC=mix(color('#726756'),color('#a69a80'),grain).mul(tone);   // damp sand: brown-grey, a hint of red         // warm ochre-tan of the wet beach (West Shore photo)
 const drySandC=mix(color('#bca784'),color('#e2cfac'),grain).mul(tone);
 const shingleC=mix(color('#8d877e'),color('#b9b5ad'),V(p.mul(3.1),.7)); // cobbles: grey with pale stones
 const marramC=mix(color('#948c62'),color('#aba179'),patch.mul(.6).add(grain.mul(.4)));  // olive-straw marram
 const slackC=mix(color('#7e875c'),color('#90966a'),grain);                            // greener grass in the hollows
 const pastureC=mix(color('#62784c'),color('#76885d'),patch);
 const fellC=mix(color('#5c6a45'),color('#6b704e'),patch);
 const heatherC=mix(color('#5d5249'),color('#6b5d55'),patch);                          // bracken and heather on the tops
 const rockC=mix(color('#8e8a82'),color('#aaa69e'),grain);
 const aboveTide=y.sub(U.tide);
 const wet=float(1).sub(smoothstep(.25,1.8,aboveTide));               // flats still wet from the last tide
 // the intertidal flats stay damp and dark between tides (red-brown in the photos); sand dries pale
 // only above the high-water mark (~+4 m ODN) and well clear of the water
 const dryF=smoothstep(1.2,3.,aboveTide).mul(smoothstep(3.2,4.8,y));
 const hwDist=seaField(p).w;                                           // metres inland of high water
 const beach=float(1).sub(smoothstep(12,40,hwDist));
 const hollow=smoothstep(.45,.6,F(p.mul(.02),.8));
 // colours sampled from the Sandscale pano: grey-olive marsh, straw-olive rush bands
 // saltmarsh is a patchwork: fresh green sward, straw-dry grasses, darker rush and sea-purslane
 // clumps, in patches tens of metres across (as in the Sandscale pano), never one dark sheet
 const mA=F(p.mul(.045),2.2),mB=F(p.mul(.13),.7);
 const marshC=mix(mix(mix(color('#56603c'),color('#6d7a46'),smoothstep(.35,.65,mA)),color('#8a8458'),smoothstep(.6,.78,mB).mul(.7)),color('#3d4632'),smoothstep(.62,.8,F(p.mul(.08),1.4)).mul(.65));
 const exposed=texture(expTex,p.sub(vec2(far.west,far.north)).div(vec2(far.w*far.res,far.hgt*far.res))).r;
 const estuaryC=mix(color('#5d605a'),color('#8a8676'),smoothstep(2.5,4.5,aboveTide));    // sheltered estuary flats: wet silver-grey
 const sandLike0=mix(wetSandC,drySandC,dryF);
 const flatC=mix(estuaryC,sandLike0,exposed);                                             // exposed tidal flats are beach sand
 const sandLike=mix(wetSandC,drySandC,dryF);
 const duneC=mix(mix(marramC,slackC,hollow.mul(.6)),drySandC.mul(.82),smoothstep(.82,.7,up).mul(smoothstep(.68,.74,F(p.mul(.05),2.6))).mul(.8));
 // Real reflectance, measured against the pano under the physical light: plants return only
 // ~10% of visible light (the palette above is their colour; this is how much of it).
 const REFLECT={3:vec3(.4,.38,.27),13:vec3(.4,.38,.27),4:vec3(.28,.33,.35),6:vec3(.33),7:vec3(.33),8:vec3(.27,.35,.55),9:vec3(.33),11:vec3(.33),bare:vec3(.7)};
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
  const R=k=>REFLECT[k]??REFLECT.bare;
  const g=mix(wetSandC,drySandC,dryF).mul(R(1)).toVar();
  g.assign(mix(g,shingleC.mul(R(2)),smoothstep(2.6,3.4,y).mul(beach).mul(max(smoothstep(.55,.35,patch.add(grain.mul(.2))),.4))));
  const dune=float(1).sub(beach).mul(smoothstep(3.5,5,y));
  g.assign(mix(g,duneC.mul(R(3)),dune));
  g.assign(mix(g,pastureC.mul(R(8)),smoothstep(500,1200,hwDist).mul(smoothstep(4,8,y))));
  g.assign(mix(g,fellC.mul(R(7)),smoothstep(60,140,y)));
  g.assign(mix(g,heatherC.mul(R(7)),smoothstep(200,380,y).mul(smoothstep(.3,.6,patch.add(.25)))));
  g.assign(mix(g,rockC.mul(R(12)),smoothstep(.8,.62,up)));
  if(lcMask){
   const acc=vec3(0).toVar(),wsum=float(0).toVar();
   // footpaths and tracks are trodden lines you only see up close: fade them out with distance
   const pathFade=float(1).sub(smoothstep(600,2500,range));
   for(const [k,c] of Object.entries(PALETTE)){const m=+k===21||+k===22?is(+k).mul(pathFade):is(+k);acc.addAssign(c.mul(REFLECT[k]??REFLECT.bare).mul(m));wsum.addAssign(m);}
   g.assign(acc.add(g.mul(max(float(1).sub(wsum),0))));
  }
  return g;
 })();
 // sand detail: pools in the runnels, a mirror band just above the water,
 // and ripple marks that fade out before they could shimmer at distance
 const sandish=lcMask?is(1).add(is(14)).add(max(float(1).sub([1,2,3,4,5,6,7,8,9,10,11,12,13,14,20,21,22,24].reduce((a,k)=>a.add(is(k)),float(0))),0)):float(1);
 const runnel=F(p.mul(vec2(.05,.006)),.05).mul(.75).add(F(p.mul(vec2(.2,.05)),1.7).mul(.25));
 // runnel pools only on sand the water has left: they fade in just above the swash's reach (the
 // sea itself draws the water below it, so the two never show at once)
 const pool=smoothstep(.635,.655,runnel).mul(wet).mul(smoothstep(.985,.995,up)).mul(sandish).mul(smoothstep(.12,.32,aboveTide));
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
 const sheen=gust(p).mul(duneMask);   // gusts lay the grass over and show its paler side
 const shade=cloudShade(positionWorld);
 // ---------- the shore below and behind the rock armour ----------
 // From terrain/armour.py: R = distance to the armour band, G = the promenade just behind it.
 const nearUV=q=>q.sub(vec2(near.west,near.north)).div(vec2(near.w*near.res,near.hgt*near.res));
 const arm=armourTex?texture(armourTex,nearUV(p)):vec4(1,0,0,0);
 const armD=arm.r.mul(255),inNear=inLayer(near,p,60);
 const fwG=length(dFdx(p)).add(length(dFdy(p)));               // ground metres per pixel here
 // cells: distance to the nearest stone centre and that stone's own random number
 const MHWs=4.2;   // mean high water, m ODN
 const cells=Fn(([q])=>{
  const i=floor(q),f=fract(q),best=float(9).toVar(),id=float(0).toVar();
  for(let y=-1;y<=1;y++)for(let x=-1;x<=1;x++){
   const o=vec2(x,y),h=hash22(i.add(o)),d=length(o.add(h.mul(.8).add(.1)).sub(f));
   id.assign(select(d.lessThan(best),fract(h.x.mul(13.7).add(h.y.mul(7.1))),id));best.assign(min(best,d));
  }
  return vec2(best,id);
 });
 // shingle: a bank of grey, buff and a few red-brown stones on the sand seaward of the armour
 // shingle: the storm beach round high water all along this shore, and the bank seaward of the armour
 const band=smoothstep(MHWs-1.4,MHWs-.6,y).mul(float(1).sub(smoothstep(MHWs+1.6,MHWs+2.6,y))).mul(smoothstep(.3,.55,F(p.mul(.03),2.7).mul(.7).add(F(p.mul(.11),.5).mul(.3))));
 // below the armour the shingle runs well down the beach, to about mid-tide
 const low=smoothstep(-.5,.5,y).mul(float(1).sub(smoothstep(90,160,armD))).mul(inNear);
 const shingle=max(max(float(1).sub(smoothstep(16,38,armD)).mul(inNear),band),low).mul(sandish).mul(float(1).sub(smoothstep(MHWs+2.2,MHWs+3.5,y)));
 const sc=cells(p.mul(19).add(vec2(F(p.mul(.7),.3),F(p.mul(.7),1.7)).mul(1.5)));   // stones ~5 cm
 const stoneC=mix(mix(color('#5f6062'),color('#8d8c88'),fract(sc.y.mul(3.1))),mix(color('#6e5a50'),color('#3a3b3c'),step(.6,fract(sc.y.mul(9.7)))),step(.88,sc.y));   // grey, a few rust and dark
 const shingleNear=mix(stoneC.mul(smoothstep(.62,.3,sc.x).mul(.45).add(.55)),color('#55504a'),smoothstep(.42,.6,sc.x).mul(.8));
 const shingleFar=color('#5d5e60');   // the photos' shingle: grey
 const shingleTone=mix(shingleNear,shingleFar,smoothstep(.008,.03,fwG));
 // the coast path: interlocking concrete blocks with oval holes, grass and grit in the holes,
 // laid along the shore (across the armour's distance gradient)
 const gA=vec2(texture(armourTex??fieldTex,nearUV(p.add(vec2(4,0)))).r.sub(arm.r),texture(armourTex??fieldTex,nearUV(p.add(vec2(0,4)))).r.sub(arm.r));
 const across=normalize(gA.add(vec2(1e-5,0))),along=vec2(across.y.negate(),across.x);
 const bu=dot(p,along).div(.45),bv=dot(p,across).div(.3),bc=fract(vec2(bu.add(floor(bv).mul(.5)),bv));
 const hole=float(1).sub(max(smoothstep(.13,.09,length(bc.sub(vec2(.27,.5)).mul(vec2(1,.7)))),smoothstep(.13,.09,length(bc.sub(vec2(.77,.5)).mul(vec2(1,.7))))));
 const joint=smoothstep(.0,.04,bc.x).mul(smoothstep(1,.96,bc.x)).mul(smoothstep(0,.05,bc.y)).mul(smoothstep(1,.95,bc.y));
 const concrete=mix(color('#8d8a83'),color('#6f6d68'),F(p.mul(.6),.9)).mul(V(p.mul(4),.2).mul(.25).add(.85));
 const pathNear=mix(mix(color('#4b4f3a'),color('#5d5a4c'),V(p.mul(9),.4)),concrete,hole).mul(joint.mul(.35).add(.65));
 const pathC=mix(pathNear,mix(concrete,color('#5a5a48'),.25).mul(.9),smoothstep(.015,.05,fwG)).mul(.9);
 const prom=arm.g.mul(inNear);
 // vegetation seen across a landscape is a pale, greyish olive (the pano): less saturated
 const veg=lcMask?is(3).add(is(4)).add(is(6)).add(is(7)).add(is(8)).add(is(9)).add(is(13)).min(1):float(1).sub(sandish);
 const g0=ground0.mul(ripTone),gl0=dot(g0,vec3(.2126,.7152,.0722));
 const gVeg=mix(g0,vec3(gl0),veg.mul(.3)).mul(mix(1,1.25,is(4)));   // and the saltmarsh a little lighter
 const shore0=mix(mix(gVeg,shingleTone,shingle),pathC,prom);
 // the hand-painted surface map (surface.js) overrides the rules where it says so
 const sid=surfaceTex?texture(surfaceTex,nearUV(p)).r.mul(255):float(0);
 const eqS=k=>float(1).sub(step(.5,abs(sid.sub(k)))).mul(inNear);
 const painted=float(1).sub(eqS(0));
 const scrubC=mix(color('#2c3322'),color('#4a4a32'),F(p.mul(.3),1.1)).mul(.32);
 const paintC=mix(color('#000'),mix(wetSandC,drySandC,dryF).mul((REFLECT[1]??REFLECT.bare)),eqS(1))
  .add(shingleTone.mul(eqS(2))).add(estuaryC.mul(.85).mul(eqS(3))).add(marshC.mul((REFLECT[4]??REFLECT.bare)).mul(eqS(4)))
  .add(scrubC.mul(eqS(5))).add(pastureC.mul((REFLECT[8]??REFLECT.bare)).mul(eqS(6))).add(rockC.mul(.6).mul(eqS(7)));
 const shore=mix(shore0,paintC,painted);
 ground.colorNode=mix(clay,mix(shore.mul(float(1).sub(max(shingle,prom).mul(.9)).mul(sheen.mul(.35)).add(1)).mul(mix(1,.62,wet.mul(.5).mul(float(1).sub(prom)))),color('#55657a'),pool.mul(.6).mul(float(1).sub(shingle))),U.tint).mul(shade);
 const dryStone=float(1).sub(max(max(shingle,prom),painted.mul(float(1).sub(eqS(1)).sub(eqS(3)))).mul(.85));   // shingle and concrete drain: no sheen of wet sand
 const wetFlat=max(max(wet,is(14).mul(float(1).sub(exposed)).mul(.55)),mirror).mul(dryStone);    // estuary flats stay glossy long after the tide drops
 ground.roughnessNode=mix(float(.95),mix(mix(mix(.95,.35,wetFlat),.12,mirror),.04,pool),U.tint);
 // dry ground and plant cover hide most of their glancing reflection in their own shadows;
 // only wet sand, flats and pools keep a full water-like specular
 ground.specularIntensityNode=mix(float(.12),float(1),max(max(wetFlat,mirror),pool));
 const eyeG=normalize(cameraPosition.sub(positionWorld));
 const fresG=float(.02).add(pow(float(1).sub(max(dot(normalWorld,eyeG),0)),5).mul(.98));
 const gloss=max(max(wetFlat.mul(.35),pool),mirror.mul(.85)).mul(dryStone);
 ground.emissiveNode=skyRefl(reflect(eyeG.negate(),normalWorld),float(.15)).mul(fresG).mul(gloss).mul(U.tint).mul(shade.mul(.5).add(.5));

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
  const shadeS=cloudShade(positionWorld);
  // lit by the real sun (reddened when low) and the sky, and darkened in cloud shadow
  body.mulAssign(U.sunLight.mul(max(U.sun.y,0)).mul(shadeS).mul(.32).add(U.skyAmb.mul(.9)));
  const ndv=max(dot(n,eye),0);
  const fres=float(.02).add(pow(float(1).sub(ndv),5).mul(.98));
  const refl=skyRefl(reflect(eye.negate(),n),float(.5)).mul(.85);
  const col=mix(body,refl,fres).toVar();
  // sun glitter: countless tiny facets, some tilted to mirror the sun into the eye.
  // The rougher the water (wind, open sea), the wider and softer the glitter path.
  const hS=normalize(U.sun.add(eye)),nh=max(dot(n,hS),.001),nh2=nh.mul(nh);
  const sig2=float(.0012).add(chop.mul(.014));
  const D=exp(float(1).sub(nh2).div(nh2).div(sig2).negate()).div(sig2.mul(3.1416).mul(nh2).mul(nh2));
  const Fh=float(.02).add(pow(float(1).sub(max(dot(hS,eye),0)),5).mul(.98));
  col.addAssign(U.sunLight.mul(min(D.mul(Fh).div(max(ndv,.15).mul(4)),60)).mul(shadeS).mul(step(0,U.sun.y)));
  const foamLit=vec3(.93).mul(U.sunLight.mul(max(U.sun.y,0)).mul(shadeS).mul(.3).add(U.skyAmb.mul(1.3)));
  col.assign(mix(col,foamLit,foam));
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
 // exposure to the open sea (fixed): the West Shore is exposed, the Duddon sheltered at any tide
 const exposureAt=p=>mix(float(1),texture(expTex,p.sub(vec2(far.west,far.north)).div(vec2(far.w*far.res,far.hgt*far.res))).r,inLayer(far,p,5000));
 return {U,atmo,updateSkyTex,aerial,worley,Fq,Vq,sky,skyRefl,skyMaterial,ground,sea,updateSea,gust,cloudShade,F,V,hwDistAt,SWASH,fogNode,seaField,bedAt,exposureAt};
}
