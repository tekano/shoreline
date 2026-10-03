import * as THREE from 'three/webgpu';
import {attribute,vec2,vec3,float,mix,smoothstep,positionWorld,positionLocal,hash,instanceIndex,bumpMap} from 'three/tsl';

// Rock armour: quarried boulders, 1-3 m, piled along the sea defences where the LiDAR shows a
// steep rough band at the top of the beach (terrain/armour.py). Eight angular shapes, each drawn
// thousands of times at its own size and turn, sunk a little into the ground. Pale grey limestone,
// darker and weedy below high water, shaded darker toward the base where stones press together.
const MHW=4.2;   // mean high water, m ODN

function boulder(seed){
 let s=seed*9301+49297;const rnd=()=>((s=(s*233280+49297)%2147483647)/2147483647);
 const g=new THREE.IcosahedronGeometry(1,1).toNonIndexed();   // 80 faces: the quarry cuts carry the shape
 const p=g.attributes.position,v=new THREE.Vector3();
 // a lumpy core, then flat cuts where the quarry split it, then squashed to a slab or block
 const bumps=Array.from({length:5},()=>[new THREE.Vector3(rnd()-.5,rnd()-.5,rnd()-.5).normalize(),rnd()*.25]);
 const cuts=Array.from({length:6+Math.floor(rnd()*4)},()=>[new THREE.Vector3(rnd()-.5,(rnd()-.5)*1.4,rnd()-.5).normalize(),.55+rnd()*.35]);
 const sx=.8+rnd()*.4,sy=.55+rnd()*.3,sz=.75+rnd()*.35;
 for(let i=0;i<p.count;i++){
  v.fromBufferAttribute(p,i);
  let r=1;for(const [d,a] of bumps)r+=a*Math.max(v.dot(d),0)**2;
  v.multiplyScalar(r);
  for(const [nrm,d] of cuts){const k=v.dot(nrm);if(k>d)v.addScaledVector(nrm,d-k);}
  v.set(v.x*sx,v.y*sy,v.z*sz);
  p.setXYZ(i,v.x,v.y,v.z);
 }
 // smooth normals across shared corners (the cut faces still read flat): weathered, not low-poly
 g.computeVertexNormals();
 const acc=new Map(),nr=g.attributes.normal,key=i=>`${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
 for(let i=0;i<p.count;i++){const k=key(i),a=acc.get(k)||[0,0,0];a[0]+=nr.getX(i);a[1]+=nr.getY(i);a[2]+=nr.getZ(i);acc.set(k,a);}
 for(let i=0;i<p.count;i++){const a=acc.get(key(i)),l=Math.hypot(...a)||1;nr.setXYZ(i,a[0]/l,a[1]/l,a[2]/l);}
 return g;
}

export function createRocks({data,height,look}){
 const group=new THREE.Group();
 const n=data.length/5;
 const mat=new THREE.MeshStandardNodeMaterial({roughness:.88,metalness:0});
 // per-stone tone, base occlusion, and the weed and wet below high water
 const tone=hash(instanceIndex.add(17)).mul(.25).add(.85);
 const ao=smoothstep(-.7,.4,positionLocal.y).mul(.55).add(.45);
 // pale grey stone, some warmer (rust-stained), mottled with lichen and grime
 const {F,V}=look,rq=positionLocal.mul(2.2).add(hash(instanceIndex).mul(40));
 const mott=F(rq.xz.add(rq.y.mul(.7)),.4).mul(.6).add(V(rq.xy.mul(3),1.1).mul(.4));
 const stone=mix(mix(vec3(.17,.17,.165),vec3(.2,.175,.15),hash(instanceIndex.add(5)).mul(.7)),vec3(.1,.1,.095),smoothstep(.5,.75,mott).mul(.6)).mul(tone);   // ~18% reflectance, as the stones in the photos
 mat.normalNode=bumpMap(F(rq.xz.mul(3),.9).mul(.6).add(F(rq.xy.mul(7),2.1).mul(.4)),1.2);   // pitted, rough surface
 const weed=vec3(.10,.10,.07);
 const below=float(1).sub(smoothstep(MHW-1.6,MHW-.4,positionWorld.y));
 mat.colorNode=mix(stone,weed,below.mul(.85)).mul(ao).mul(look.cloudShade(positionWorld));
 // drawn only near the camera: all stones stay in memory, the ~1.5 km around you is rebuilt
 // whenever you move a few hundred metres, so a key shot gets every stone and the rest costs nothing
 // (always the full instance count: WebGPU picks its buffer by it; unused slots are zero-size)
 const RADIUS=1500,CAP=40000;
 const meshes=Array.from({length:8},(_,k)=>{const m=new THREE.InstancedMesh(boulder(k+1),mat,CAP/4);m.frustumCulled=false;group.add(m);return m;});
 const m4=new THREE.Matrix4(),q=new THREE.Quaternion(),e=new THREE.Euler(),t=new THREE.Vector3(),sc=new THREE.Vector3();
 const ys=new Float32Array(n);for(let i=0;i<n;i++)ys[i]=height(data[i*5],data[i*5+1]);
 let at=null;
 const update=camera=>{
  const cx=camera.position.x,cz=camera.position.z;
  if(at&&Math.hypot(cx-at[0],cz-at[1])<250)return;
  at=[cx,cz];
  const fill=new Array(8).fill(0);
  for(let i=0;i<n;i++){
   const x=data[i*5],z=data[i*5+1];
   if(Math.abs(x-cx)>RADIUS||Math.abs(z-cz)>RADIUS)continue;
   const k=data[i*5+4]|0;if(fill[k]>=CAP/4)continue;
   const r=data[i*5+2]/2,yaw=data[i*5+3];
   q.setFromEuler(e.set(Math.sin(i*12.9)*.25,yaw,Math.cos(i*7.3)*.25));
   meshes[k].setMatrixAt(fill[k]++,m4.compose(t.set(x,ys[i]+r*.25,z),q,sc.setScalar(r)));
  }
  const zero=new THREE.Matrix4().makeScale(0,0,0);
  meshes.forEach((m,k)=>{for(let j=fill[k];j<CAP/4;j++)m.setMatrixAt(j,zero);m.instanceMatrix.needsUpdate=true;});
 };
 return {group,count:n,update};
}
