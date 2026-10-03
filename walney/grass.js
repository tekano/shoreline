import * as THREE from 'three/webgpu';
import {Fn,float,vec2,vec3,color,mix,smoothstep,max,pow,dot,normalize,cross,sin,cos,sqrt,clamp,varying,step,
 attribute,cameraPosition,instancedBufferAttribute,frontFacing,select,transformNormalToView} from 'three/tsl';

// Marram grass that moves in the shared wind.
//
// Every blade is one instance of a thin tapered strip. The vertex shader bends
// it by its own lean (an arch away from its root), the shared gust field, and
// a fast per-blade flutter, so a tussock reads as hundreds of separate leaves
// rather than a card. Two populations share the shader:
//  - field: scattered clumps that thin out with distance (bigger blades far
//    away keep the coverage), out to RADIUS metres;
//  - tussocks: hero clumps near the camera, fountains of long arching leaves.
const SEGMENTS=5,RADIUS=140,FIELD=260000,TUSSOCKS=46,PER_TUSSOCK=260;
const MAX=FIELD+TUSSOCKS*PER_TUSSOCK;

function bladeGeometry(){
 // x across the blade (-.5….5), y along it (0 root … 1 tip)
 const pos=[],idx=[];
 for(let i=0;i<=SEGMENTS;i++){const t=i/SEGMENTS;if(i<SEGMENTS)pos.push(-.5,t,0,.5,t,0);else pos.push(0,1,0);}
 for(let i=0;i<SEGMENTS-1;i++){const a=i*2;idx.push(a,a+1,a+2,a+1,a+3,a+2);}
 const a=(SEGMENTS-1)*2;idx.push(a,a+1,a+2);
 const g=new THREE.InstancedBufferGeometry();
 g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setIndex(idx);
 return g;
}

export function createGrass({look,height,zone}){
 const {U,gust}=look;
 const geometry=bladeGeometry();
 const root=new THREE.InstancedBufferAttribute(new Float32Array(MAX*4),4);    // x, y, z, yaw
 const shape=new THREE.InstancedBufferAttribute(new Float32Array(MAX*4),4);   // length, width, lean, phase
 const tone=new THREE.InstancedBufferAttribute(new Float32Array(MAX*4),4);    // dryness, stiffness, sheen, kind (0 marram, 1 field, 2 marsh)
 for(const a of [root,shape,tone])a.setUsage(THREE.DynamicDrawUsage);
 geometry.setAttribute('root',root);geometry.setAttribute('shape',shape);geometry.setAttribute('tone',tone);
 geometry.instanceCount=0;

 const R=instancedBufferAttribute(root),S=instancedBufferAttribute(shape),T=instancedBufferAttribute(tone);
 // the blade's own coordinates; positionLocal would return the displaced position once positionNode is set
 const blade=attribute('position','vec3'),t=blade.y,s=blade.x;
 const len=S.x,wid=S.y,lean=S.z,ph=S.w;
 const dir=vec2(sin(R.w),cos(R.w));                 // the way this leaf arches
 const side=vec2(dir.y,dir.x.negate());
 const g=gust(R.xz);
 const wdir=normalize(U.wind);
 const stiff=T.y;
 const flutter=sin(U.time.mul(float(5.5).add(ph.mul(3))).add(ph.mul(40))).mul(.6).add(sin(U.time.mul(13.7).add(ph.mul(71))).mul(.4));
 const push=U.windSpeed.div(9).mul(float(.25).add(g.mul(1.1))).add(flutter.mul(.12).mul(g.mul(.8).add(.25))).div(stiff);
 const bend=dir.mul(lean).add(wdir.mul(push));       // curvature, per unit length
 const bendLen=bend.length();
 // quadratic arch; height shrinks as it bends so leaves keep their length
 const off=bend.mul(len).mul(t.mul(t)).mul(.9);
 const yy=len.mul(t).mul(sqrt(max(float(1).sub(bendLen.mul(bendLen).mul(t).mul(.55)),.08)));
 const w=wid.mul(pow(float(1).sub(t),.75)).mul(float(1).add(t.mul(.15)));
 const posW=vec3(R.x.add(side.x.mul(s).mul(w)).add(off.x),R.y.add(yy),R.z.add(side.y.mul(s).mul(w)).add(off.y));
 // normal from the blade's tangent and its width direction
 const tangent=normalize(vec3(bend.x.mul(len).mul(t).mul(1.8),len,bend.y.mul(len).mul(t).mul(1.8)));
 const n0=normalize(cross(vec3(side.x,0,side.y),tangent));
 const vN=varying(n0,'bladeNormal'),vT=varying(t,'bladeT'),vG=varying(g,'bladeGust'),vTone=varying(T,'bladeTone'),vP=varying(posW,'bladePos');

 // lit like the terrain (same sun and sky), so blades and ground agree
 const material=new THREE.MeshPhysicalNodeMaterial({side:THREE.DoubleSide,roughness:.85,metalness:0,specularIntensity:.25});   // a canopy shades its own sheen
 material.positionNode=posW;
 // normals bent toward the sky so thin leaves take the same light as the ground beneath
 material.normalNode=transformNormalToView(normalize(select(frontFacing,vN,vN.negate()).add(vec3(0,.9,0))));
 const albedo=Fn(()=>{
  const dry=vTone.x;
  // marram: dark olive at the root, olive-straw up the leaf, pale straw tips
  const green=mix(color('#4e5b3e'),color('#808963'),vT);
  const straw=mix(color('#807963'),color('#b6ad86'),pow(vT,1.4));
  const base=mix(green,straw,dry).toVar();
  // field grass: fresher green; saltmarsh: dark sea-green grasses and rushes
  const kind=vTone.w;
  base.assign(mix(base,mix(mix(color('#4d6a36'),color('#86a05d'),vT),color('#9d9a71'),dry.mul(.5)),step(.5,kind).mul(step(kind,1.5))));
  base.assign(mix(base,mix(mix(color('#394d30'),color('#6a824f'),vT),color('#898256'),dry.mul(.4)),step(1.5,kind)));
  // rolled marram leaves flash silver-grey when a gust lays them over
  base.assign(mix(base,color('#a9a898'),vG.mul(vTone.z).mul(smoothstep(.2,.9,vT)).mul(.3)));
  // real reflectance, measured against the pano: marram, field grass, saltmarsh
  const reflect=mix(mix(vec3(.37,.37,.32),vec3(.27,.35,.55),step(.5,kind)),vec3(.28,.33,.35),step(1.5,kind));   // field grass greener than marram (the November photos)
  return base.mul(reflect).mul(mix(.68,1,smoothstep(0,.5,vT))).mul(look.cloudShade(vP));      // darker down in the clump, and under cloud
 })();
 material.colorNode=albedo;
 // sun shining through backlit leaves
 material.emissiveNode=Fn(()=>{
  const eye=normalize(cameraPosition.sub(vP));
  return albedo.mul(pow(max(dot(eye.negate(),U.sun),0),3).mul(vT)).mul(U.sunLight.mul(.45));   // in the sun's real light
 })();
 material.fog=true;

 const mesh=new THREE.Mesh(geometry,material);mesh.frustumCulled=false;

 // ---------- placement around the camera ----------
 let seed=1;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 // radial density: dense at the camera, thinning out; blades get bigger to keep coverage
 const density=r=>40/(1+Math.pow(r/6,1.6));
 const scale=r=>1+r/22;
 const N=512,cdf=new Float64Array(N+1);
 for(let i=1;i<=N;i++){const r=(i-.5)/N*RADIUS;cdf[i]=cdf[i-1]+r*density(r);}
 for(let i=0;i<=N;i++)cdf[i]/=cdf[N];
 const sampleR=u=>{let lo=0,hi=N;while(hi-lo>1){const m=(lo+hi)>>1;if(cdf[m]<u)lo=m;else hi=m;}return (lo+(u-cdf[lo])/Math.max(cdf[hi]-cdf[lo],1e-9))/N*RADIUS;};
 let count=0;
 const put=(x,z,yaw,len,wid,lean,phase,dry,stiff,sheen,kind=0)=>{
  if(count>=MAX)return;const k=count*4,y=height(x,z);
  root.array.set([x,y-.02,z,yaw],k);shape.array.set([len,wid,lean,phase],k);tone.array.set([dry,stiff,sheen,kind],k);count++;
 };
 function update(cx,cz,density=1){
  seed=(Math.round(cx*7.1)^Math.round(cz*3.3))>>>0||1;count=0;
  // hero tussocks: fountains of long arching leaves near the camera
  for(let n=0;n<TUSSOCKS*density;n++){
   const a=rnd()*Math.PI*2,r=1.6+Math.pow(rnd(),.8)*16,x=cx+Math.sin(a)*r,z=cz+Math.cos(a)*r;
   const [p0,k0]=zone(x,z);if(p0<.5||k0!==0)continue;
   const size=.75+rnd()*.55,dry=.2+rnd()*.45;
   for(let b=0;b<PER_TUSSOCK;b++){
    const ya=rnd()*Math.PI*2,rr=Math.sqrt(rnd())*.22*size;
    // outer leaves arch further out; a few stand nearly upright in the middle
    const out=rr/(.22*size);
    put(x+Math.sin(ya)*rr,z+Math.cos(ya)*rr,ya,(.55+rnd()*.6)*size*(1.15-out*.35),.014+rnd()*.008,.2+out*.75+rnd()*.25,rnd(),Math.min(1,dry+(rnd()-.5)*.35),.8+rnd()*.6,.6+rnd()*.4);
   }
  }
  // the field: clumps near, scattered blades further out
  const field=Math.floor(FIELD*density);
  let placed=0,tries=0;
  while(placed<field&&tries<field*3){
   tries++;
   const r=sampleR(rnd()),a=rnd()*Math.PI*2,x=cx+Math.sin(a)*r,z=cz+Math.cos(a)*r;
   const [p0,kind]=zone(x,z);if(p0<=0||rnd()>p0)continue;
   // field grass is shorter and finer; marsh grass mid-height
   const lenK=kind===1?.55:kind===2?.75:1;
   const k=scale(r),clump=r<45?6+Math.floor(rnd()*14):1;
   for(let c=0;c<clump&&placed<field;c++,placed++){
    const ya=rnd()*Math.PI*2,rr=clump>1?Math.sqrt(rnd())*.2*k:0;
    put(x+Math.sin(ya)*rr,z+Math.cos(ya)*rr,ya,(.35+rnd()*.45)*Math.min(k,2.2)*lenK,(.012+rnd()*.008)*k,.3+rnd()*.9,rnd(),.15+rnd()*.55,.9+rnd()*.5,.5+rnd()*.5,kind);
   }
  }
  geometry.instanceCount=count;
  for(const a of [root,shape,tone]){a.needsUpdate=true;a.clearUpdateRanges?.();}
  return count;
 }
 return {mesh,update,debug:{vT,vTone,vG,albedo},get count(){return count;}};
}
