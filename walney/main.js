import * as THREE from 'three/webgpu';
import {createLook} from './look.js';
import {createGrass} from './grass.js';
import {loadLandcover} from './landcover.js';
import {makeNoiseTexture} from '../src/noise.js?v=1.3.0';

// Terrain blockout of a real place: LiDAR heights around a camera you place on
// a top-down map. Scene frame: metres, x east, y up (m above Ordnance Datum
// Newlyn), z south, origin at meta.origin_osgb on the British National Grid.
const $=id=>document.getElementById(id);
const STORE='walney.cameras';
const read=()=>{try{return JSON.parse(localStorage.getItem(STORE)||'{}');}catch{return {};}};
const write=v=>{try{localStorage.setItem(STORE,JSON.stringify(v));}catch{}};

const meta=await (await fetch('./data/meta.json')).json();
const [lo,hi]=meta.heightRange;
async function layer(name,info){
 const raw=new Uint16Array(await (await fetch(`./data/${name}.u16`)).arrayBuffer());
 const h=new Float32Array(raw.length);for(let i=0;i<raw.length;i++)h[i]=lo+raw[i]/65535*(hi-lo);
 return {...info,h,w:info.size[0],hgt:info.size[1]};
}
const [far,near]=await Promise.all([layer('far',meta.far),layer('near',meta.near)]);
const sample=(L,x,z)=>{
 let fx=(x-L.west)/L.res-.5,fz=(z-L.north)/L.res-.5;
 fx=Math.min(Math.max(fx,0),L.w-1.001);fz=Math.min(Math.max(fz,0),L.hgt-1.001);
 const i=fx|0,j=fz|0,a=fx-i,b=fz-j,k=j*L.w+i;
 return (L.h[k]*(1-a)+L.h[k+1]*a)*(1-b)+(L.h[k+L.w]*(1-a)+L.h[k+L.w+1]*a)*b;
};
// near detail where it exists, blended into the far layer over its last 300 m
const nearEdge=(x,z)=>{const e=Math.min(x-near.west,near.west+near.w*near.res-x,z-near.north,near.north+near.hgt*near.res-z);return Math.min(Math.max(e/300,0),1);};
const height=(x,z)=>{const w=nearEdge(x,z);return w>0?sample(near,x,z)*w+sample(far,x,z)*(1-w):sample(far,x,z);};

// ---------- view state ----------
const DEFAULT={...meta.cameras.westshore,tide:-1.5,haze:1,sunaz:195,sunel:52,tint:1};
const saved=read();
const presets={...meta.cameras,...saved};
const state={motion:'locked',panDeg:24,panSecs:90,clouds:.5,swell:.8,...DEFAULT,...(saved.__last||{})};
const mm2fov=mm=>2*Math.atan(24/(2*mm))*180/Math.PI;   // vertical FOV of a full-frame lens

// ---------- renderer ----------
const view=$('view');
const renderer=new THREE.WebGPURenderer({antialias:true,reversedDepthBuffer:true,forceWebGL:new URLSearchParams(location.search).has('webgl')});
await renderer.init();
renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
renderer.toneMapping=THREE.NeutralToneMapping;
view.prepend(renderer.domElement);$('status').remove();
const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(40,1,.3,60000);
const sun=new THREE.DirectionalLight('#fff4e2',3.0);scene.add(sun,sun.target);
const hemi=new THREE.HemisphereLight('#a9c4ea','#7a6f5c',1.1);scene.add(hemi);
const haze=new THREE.Color('#a9c1db');
scene.fog=new THREE.FogExp2(haze,0);

// the look (sky, ground, sea) lives in look.js; U.tint switches clay ↔ colour
const landcover=await loadLandcover(meta);
const look=createLook({noiseTex:makeNoiseTexture(),far,near,tide:state.tide,landcover});
const U=look.U;
const ground=look.ground;
const skyDome=new THREE.Mesh(new THREE.SphereGeometry(50000,48,24),look.skyMaterial);skyDome.frustumCulled=false;skyDome.renderOrder=-1;scene.add(skyDome);
const water=new THREE.Mesh(new THREE.PlaneGeometry(200000,200000).rotateX(-Math.PI/2),look.sea);water.renderOrder=2;
scene.add(water);
let seaTide=state.tide,seaTimer=0;

// Camera-centred grid: about 1.5 m apart at the camera, ~100 m at Black Combe.
const N=1024,R=24000,A=.032;
const warp=u=>Math.sign(u)*R*(A*Math.abs(u)+(1-A)*Math.abs(u)**3);
const offsets=new Float32Array(N);for(let i=0;i<N;i++)offsets[i]=warp(-1+2*i/(N-1));
const geometry=new THREE.BufferGeometry();
const positions=new Float32Array(N*N*3);
geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
const index=new Uint32Array((N-1)*(N-1)*6);let n=0;
for(let j=0;j<N-1;j++)for(let i=0;i<N-1;i++){const a=j*N+i,b=a+1,c=a+N,d=c+1;index.set([a,c,b,b,c,d],n);n+=6;}
geometry.setIndex(new THREE.BufferAttribute(index,1));
const terrain=new THREE.Mesh(geometry,ground);terrain.frustumCulled=false;scene.add(terrain);
let builtAt=null;

// What grows where. From the OpenStreetMap land cover when it is present:
// marram on dunes, short grass on fields, marsh grass and rushes on the
// saltmarsh, nothing on sand, tracks, roads, water or buildings. Returns
// [probability, kind] with kind 0 marram, 1 field grass, 2 marsh.
const GROWS={3:[1,0],8:[.55,1],4:[.8,2],13:[.6,2],6:[.35,1],7:[.4,1]};
function zone(x,z){
 const h=height(x,z);
 if(landcover){const g=GROWS[landcover.classAt(x,z)];if(!g||h<state.tide+.05)return [0,0];return g;}
 if(h<4.6||h>45||look.hwDistAt(x,z)<12)return [0,0];
 const e=1.5,slope=Math.hypot(height(x+e,z)-h,height(x,z+e)-h)/e;
 return [slope>1.1?0:h<6?.5:1,0];
}
const grass=createGrass({look,height,zone});scene.add(grass.mesh);
let grassAt=null;
function buildTerrain(cx,cz){
 // snap to the far layer's grid so rebuilding does not make the hills crawl
 cx=Math.round(cx/16)*16;cz=Math.round(cz/16)*16;
 if(builtAt&&builtAt[0]===cx&&builtAt[1]===cz)return;
 for(let j=0;j<N;j++)for(let i=0;i<N;i++){const k=(j*N+i)*3,x=cx+offsets[i],z=cz+offsets[j];positions[k]=x;positions[k+1]=height(x,z);positions[k+2]=z;}
 geometry.attributes.position.needsUpdate=true;geometry.computeVertexNormals();geometry.computeBoundingSphere();builtAt=[cx,cz];
}

function apply(){
 const [x,z]=state.pos;
 buildTerrain(x,z);
 if(!grassAt||Math.hypot(x-grassAt[0],z-grassAt[1])>4){grass.update(x,z);grassAt=[x,z];}
 const groundY=height(x,z);
 const camY=Math.max(groundY,state.tide)+state.eye;
 camera.position.set(x,camY,z);
 camera.rotation.set(state.pitch*Math.PI/180,-state.heading*Math.PI/180,0,'YXZ');
 camera.fov=mm2fov(state.mm??fovToMm(state.fov));camera.updateProjectionMatrix();
 water.position.y=state.tide+look.SWASH;U.tide.value=state.tide;U.clouds.value=state.clouds;U.swell.value=state.swell;U.tint.value=+state.tint;skyDome.position.copy(camera.position);
 // the waterline field is rebuilt after the tide slider settles
 if(state.tide!==seaTide){clearTimeout(seaTimer);seaTimer=setTimeout(()=>{look.updateSea(state.tide);seaTide=state.tide;},120);}
 scene.fog.density=state.haze*0.00006;
 const az=state.sunaz*Math.PI/180,el=state.sunel*Math.PI/180;
 sun.position.set(x+Math.sin(az)*Math.cos(el)*5000,camY+Math.sin(el)*5000,z-Math.cos(az)*Math.cos(el)*5000);sun.target.position.set(x,camY,z);
 U.sun.value.set(Math.sin(az)*Math.cos(el),Math.sin(el),-Math.cos(az)*Math.cos(el));
 for(const k of ['eye','heading','pitch','tide','haze','sunaz','sunel','panDeg','panSecs','clouds','swell'])$(k).value=state[k];
 $('clouds-v').textContent=Math.round(state.clouds*100)+'%';$('swell-v').textContent=state.swell.toFixed(2);
 $('motion').value=state.motion;$('panDeg-v').textContent=state.panDeg;$('panSecs-v').textContent=state.panSecs;
 $('fov').value=state.mm??fovToMm(state.fov);$('tint').value=state.tint;
 $('eye-v').textContent=state.eye.toFixed(1);$('heading-v').textContent=state.heading.toFixed(1);$('pitch-v').textContent=state.pitch.toFixed(1);
 $('fov-v').textContent=Math.round($('fov').value);$('tide-v').textContent=state.tide.toFixed(1);$('haze-v').textContent=state.haze.toFixed(2);
 $('sunaz-v').textContent=state.sunaz;$('sunel-v').textContent=state.sunel;
 const E=meta.origin_osgb[0]+x,Nn=meta.origin_osgb[1]-z;
 $('readout').textContent=`E ${E.toFixed(0)}  N ${Nn.toFixed(0)}  ·  ground ${groundY.toFixed(1)} m  ·  eye ${camY.toFixed(1)} m ODN  ·  ${Math.round(state.heading)}°`;
 const last={...state};write({...read(),__last:last});
 drawMap();
}
function fovToMm(v){return Math.round(24/(2*Math.tan(v*Math.PI/360)));}

// ---------- controls ----------
for(const k of ['eye','heading','pitch','tide','haze','sunaz','sunel'])$(k).oninput=e=>{state[k]=+e.target.value;apply();};
$('fov').oninput=e=>{state.mm=+e.target.value;apply();};
$('tint').onchange=e=>{state.tint=+e.target.value;apply();};
for(const k of ['panDeg','panSecs','clouds','swell'])$(k).oninput=e=>{state[k]=+e.target.value;apply();};
$('motion').onchange=e=>{state.motion=e.target.value;panStart=performance.now()/1000;apply();};
function fillPresets(){const all={...meta.cameras,...read()};delete all.__last;$('preset').innerHTML='<option value="">Choose a view…</option>'+Object.entries(all).map(([k,v])=>`<option value="${k}">${v.label||k}</option>`).join('');}
fillPresets();
$('preset').onchange=e=>{const all={...meta.cameras,...read()};const p=all[e.target.value];if(p){Object.assign(state,p);if(p.fov&&!p.mm)state.mm=fovToMm(p.fov);apply();}};
const cameraJSON=()=>{const [x,z]=state.pos,groundY=height(x,z);return {label:state.label,pos:[+x.toFixed(1),+z.toFixed(1)],osgb:[+(meta.origin_osgb[0]+x).toFixed(1),+(meta.origin_osgb[1]-z).toFixed(1)],eye:state.eye,eyeHeightODN:+(Math.max(groundY,state.tide)+state.eye).toFixed(2),heading:state.heading,pitch:state.pitch,mm:state.mm??fovToMm(state.fov),verticalFov:+mm2fov(state.mm??fovToMm(state.fov)).toFixed(2),tide:state.tide,sunaz:state.sunaz,sunel:state.sunel,haze:state.haze};};
$('save').onclick=()=>{const name=prompt('Name this view','My view');if(!name)return;const all=read();all[name.replace(/\W+/g,'_')]={...cameraJSON(),label:name};write(all);fillPresets();};
$('copy').onclick=()=>navigator.clipboard?.writeText(JSON.stringify(cameraJSON(),null,1));
$('download').onclick=()=>{const all=read();delete all.__last;const data={frame:meta.units,origin_osgb:meta.origin_osgb,current:cameraJSON(),saved:all};const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,1)],{type:'application/json'}));a.download='walney-cameras.json';a.click();URL.revokeObjectURL(a.href);};

// look around by dragging the 3D view
let aim=null;
renderer.domElement.addEventListener('pointerdown',e=>{aim={x:e.clientX,y:e.clientY,h:state.heading,p:state.pitch};renderer.domElement.setPointerCapture(e.pointerId);});
renderer.domElement.addEventListener('pointermove',e=>{if(!aim)return;const k=(camera.fov/renderer.domElement.clientHeight);state.heading=((aim.h-(e.clientX-aim.x)*k)%360+360)%360;state.pitch=Math.max(-45,Math.min(30,aim.p+(e.clientY-aim.y)*k));apply();});
renderer.domElement.addEventListener('pointerup',()=>aim=null);

// ---------- top-down map ----------
const mapCanvas=$('map'),ctx=mapCanvas.getContext('2d');
// an ImageBitmap decodes in a background tab too (Image.decode waits until the page is visible)
const mapImg=await createImageBitmap(await (await fetch('./data/map.jpg')).blob());
const M=meta.map,mapW=M.size[0]*M.res,mapH=M.size[1]*M.res;
const mv={scale:0,cx:0,cz:0};   // metres per css pixel, view centre
function fitMap(){const r=mapCanvas.getBoundingClientRect();mapCanvas.width=r.width*devicePixelRatio;mapCanvas.height=r.height*devicePixelRatio;if(!mv.scale){mv.scale=Math.max(mapW/r.width,mapH/r.height);mv.cx=M.west+mapW/2;mv.cz=M.north+mapH/2;}drawMap();}
const toScreen=(x,z)=>{const r=mapCanvas.getBoundingClientRect();return [(x-mv.cx)/mv.scale+r.width/2,(z-mv.cz)/mv.scale+r.height/2];};
const toWorld=(sx,sy)=>{const r=mapCanvas.getBoundingClientRect();return [(sx-r.width/2)*mv.scale+mv.cx,(sy-r.height/2)*mv.scale+mv.cz];};
function drawMap(){
 if(!mv.scale)return;
 const d=devicePixelRatio;ctx.setTransform(d,0,0,d,0,0);ctx.fillStyle='#4c6b7d';ctx.fillRect(0,0,mapCanvas.width,mapCanvas.height);
 const [x0,y0]=toScreen(M.west,M.north);ctx.imageSmoothingEnabled=true;ctx.drawImage(mapImg,x0,y0,mapW/mv.scale,mapH/mv.scale);
 const [nx,ny]=toScreen(near.west,near.north);ctx.strokeStyle='#ffffff55';ctx.setLineDash([4,4]);ctx.strokeRect(nx,ny,near.w*near.res/mv.scale,near.hgt*near.res/mv.scale);ctx.setLineDash([]);
 // view cone, a kilometre long
 const [cx,cy]=toScreen(...state.pos),h=state.heading*Math.PI/180,half=(camera.fov*camera.aspect/2)*Math.PI/180,L=1500/mv.scale;
 ctx.fillStyle='#e9a23b44';ctx.strokeStyle='#e9a23b';ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.sin(h-half)*L,cy-Math.cos(h-half)*L);ctx.lineTo(cx+Math.sin(h+half)*L,cy-Math.cos(h+half)*L);ctx.closePath();ctx.fill();ctx.stroke();
 ctx.fillStyle='#e9a23b';ctx.beginPath();ctx.arc(cx,cy,4,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='#fff';ctx.font='11px system-ui';ctx.fillText(`${(mv.scale*100).toFixed(0)} m / 100 px`,8,mapCanvas.height/d-8);
}
let drag=null;
mapCanvas.addEventListener('contextmenu',e=>e.preventDefault());
mapCanvas.addEventListener('pointerdown',e=>{
 mapCanvas.setPointerCapture(e.pointerId);
 const r=mapCanvas.getBoundingClientRect(),sx=e.clientX-r.left,sy=e.clientY-r.top;
 if(e.button===2||e.button===1){drag={pan:true,sx,sy,cx:mv.cx,cz:mv.cz};return;}
 state.pos=toWorld(sx,sy).map(v=>+v.toFixed(1));state.label='Custom';drag={aim:true};apply();
});
mapCanvas.addEventListener('pointermove',e=>{
 if(!drag)return;const r=mapCanvas.getBoundingClientRect(),sx=e.clientX-r.left,sy=e.clientY-r.top;
 if(drag.pan){mv.cx=drag.cx-(sx-drag.sx)*mv.scale;mv.cz=drag.cz-(sy-drag.sy)*mv.scale;drawMap();return;}
 const [cx,cy]=toScreen(...state.pos);if(Math.hypot(sx-cx,sy-cy)<6)return;
 state.heading=+((Math.atan2(sx-cx,-(sy-cy))*180/Math.PI+360)%360).toFixed(1);apply();
});
mapCanvas.addEventListener('pointerup',()=>drag=null);
mapCanvas.addEventListener('wheel',e=>{e.preventDefault();const r=mapCanvas.getBoundingClientRect(),sx=e.clientX-r.left,sy=e.clientY-r.top;const [wx,wz]=toWorld(sx,sy);const k=Math.exp(e.deltaY*.0015);mv.scale=Math.min(Math.max(mv.scale*k,.5),60);mv.cx=wx-(sx-r.width/2)*mv.scale;mv.cz=wz-(sy-r.height/2)*mv.scale;drawMap();},{passive:false});

// ---------- go ----------
$('credit').textContent=meta.attribution;
function resize(){const r=view.getBoundingClientRect();if(!r.width||!r.height)return;renderer.setSize(r.width,r.height,false);camera.aspect=r.width/r.height;camera.updateProjectionMatrix();fitMap();}
new ResizeObserver(resize).observe(view);new ResizeObserver(fitMap).observe(mapCanvas);
resize();apply();
// Camera motion for showing it off: an eased sway, or a slow continuous drift.
// Only the aim changes, so the terrain and grass never rebuild mid-shot.
let panStart=performance.now()/1000;
function panHeading(now){
 const t=now-panStart;
 if(state.motion==='sway')return state.heading+state.panDeg/2*Math.sin(t/state.panSecs*Math.PI*2);
 if(state.motion==='right'||state.motion==='left')return state.heading+(state.motion==='right'?1:-1)*state.panDeg*t/state.panSecs;
 return state.heading;
}
renderer.setAnimationLoop(t=>{U.time.value=t/1000;
 if(state.motion!=='locked'&&!aim)camera.rotation.set(state.pitch*Math.PI/180,-panHeading(t/1000)*Math.PI/180,0,'YXZ');const r=view.getBoundingClientRect();if(r.width&&r.height)renderer.render(scene,camera);});
// dev: render one frame and save it through tools/serve.py (captures/, git-ignored)
async function capture(name='walney.png'){renderer.render(scene,camera);const blob=await new Promise(r=>renderer.domElement.toBlob(r,'image/png'));await fetch(`/__capture?name=${encodeURIComponent(name)}`,{method:'POST',body:blob});return name;}
window.walney={state,apply,height,meta,capture,grass,look,scene,water,terrain};
