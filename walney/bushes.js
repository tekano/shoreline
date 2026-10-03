import * as THREE from 'three/webgpu';
import {vec3,float,mix,smoothstep,positionWorld,positionLocal,normalWorld,hash,instanceIndex,dot,normalize,bumpMap} from 'three/tsl';

// Wind-sculpted hawthorn and scrub, as in the Roanhead pano: low, dense crowns on short leaning
// trunks, the crown swept downwind of the prevailing south-westerly and clipped on its windward
// side. Each bush is a cluster of rounded leaf masses (smooth-shaded, so they read as foliage, not
// facets). Placed from OpenStreetMap scrub and woodland, and singly across dunes and grassland;
// drawn only near the camera, like the rock armour.
const DOWNWIND=60*Math.PI/180;   // the crowns stream toward the north-east

function bush(seed){
 let s=seed*7919+101;const rnd=()=>((s=(s*48271)%2147483647)/2147483647);
 const parts=[],lumps=10+Math.floor(rnd()*6);
 for(let i=0;i<lumps;i++){
  const t=rnd();                                         // 0 windward .. 1 leeward
  // a low, spreading crown down to the ground, rising toward its leeward end, clipped windward
  const c=new THREE.Vector3((t-.4)*2.2,.3+t*.5+rnd()*.2,(rnd()-.5)*1.4*(1-Math.abs(t-.55)));
  const r=.35+rnd()*.3-(1-t)*.1;
  const g=new THREE.IcosahedronGeometry(r,1).toNonIndexed();
  const p=g.attributes.position,nrm=new Float32Array(p.count*3),v=new THREE.Vector3();
  for(let k=0;k<p.count;k++){
   v.fromBufferAttribute(p,k);
   v.multiplyScalar(1+(Math.sin(v.x*9+seed)+Math.sin(v.z*11+i))*.06);   // lumpy edge
   const n=v.clone().normalize();n.y=n.y*.8+.35;n.normalize();             // soft, sky-facing shading
   nrm.set([n.x,n.y,n.z],k*3);
   p.setXYZ(k,v.x+c.x,v.y*.8+c.y,v.z+c.z);
  }
  g.setAttribute('normal',new THREE.BufferAttribute(nrm,3));parts.push(g);
 }
 // a short trunk leaning downwind
 const trunk=new THREE.CylinderGeometry(.06,.11,.9,6).toNonIndexed();
 trunk.rotateZ(-.7);trunk.translate(-.55,.3,0);parts.push(trunk);
 const g=new THREE.BufferGeometry();
 for(const name of ['position','normal']){
  const arr=[];for(const q of parts)arr.push(...q.attributes[name].array);
  g.setAttribute(name,new THREE.Float32BufferAttribute(arr,3));
 }
 return g;
}

export function createBushes({spots,height,look,radius=1500,cap=12000,tall=1,light=1}){
 const group=new THREE.Group(),n=spots.length/3;
 const mat=new THREE.MeshStandardNodeMaterial({roughness:.9,metalness:0});
 // dark olive foliage, lighter on top where it meets the sun, each bush its own shade
 const up=smoothstep(-.2,.9,normalWorld.y);
 const leaf=mix(vec3(.018,.021,.014),vec3(.052,.056,.036),up).mul(hash(instanceIndex).mul(.5).add(.75)).mul(light);
 // foliage: a dense leafy grain and deep gaps, so the crown reads as twigs and leaves, not a smooth skin
 const lq=positionLocal.mul(9).add(hash(instanceIndex).mul(30));
 const leafy=look.F(lq.xz.add(lq.y.mul(.6)),.3).mul(.55).add(look.V(lq.xy.mul(2.3),1.7).mul(.45));
 mat.normalNode=bumpMap(leafy,3);
 const gaps=smoothstep(.3,.55,leafy).mul(.7).add(.3).mul(smoothstep(-.05,.6,positionLocal.y).mul(.5).add(.5));
 const speck=smoothstep(.55,.8,look.F(positionWorld.xz.mul(3.1).add(positionWorld.y.mul(2)),1.3));
 mat.colorNode=mix(leaf,leaf.mul(1.6),speck.mul(.5)).mul(gaps).mul(look.cloudShade(positionWorld));
 const KINDS=6,CAP=cap;
 const meshes=Array.from({length:KINDS},(_,k)=>{const m=new THREE.InstancedMesh(bush(k+1),mat,CAP/KINDS);m.frustumCulled=false;group.add(m);return m;});
 const ys=new Float32Array(n);for(let i=0;i<n;i++)ys[i]=height(spots[i*3],spots[i*3+1]);
 const m4=new THREE.Matrix4(),q=new THREE.Quaternion(),e=new THREE.Euler(),t=new THREE.Vector3(),sc=new THREE.Vector3(),zero=new THREE.Matrix4().makeScale(0,0,0);
 let at=null;
 const update=camera=>{
  const cx=camera.position.x,cz=camera.position.z,R=radius;
  if(at&&Math.hypot(cx-at[0],cz-at[1])<200)return;
  at=[cx,cz];
  const fill=new Array(KINDS).fill(0);
  // nearest first, so a dense town far off never crowds out the trees close by
  const near=[];for(let i=0;i<n;i++){const dx=spots[i*3]-cx,dz=spots[i*3+1]-cz;if(Math.abs(dx)<R&&Math.abs(dz)<R)near.push(i,dx*dx+dz*dz);}
  const order=Array.from({length:near.length/2},(_,j)=>j).sort((a,b)=>near[a*2+1]-near[b*2+1]);
  for(const j of order){
   const i=near[j*2],x=spots[i*3],z=spots[i*3+1];
   const k=i%KINDS;if(fill[k]>=CAP/KINDS)continue;
   const size=spots[i*3+2];
   // crowns turned downwind, with a little spread; sunk a touch into the ground
   q.setFromEuler(e.set(0,-DOWNWIND+Math.PI/2+Math.sin(i*3.7)*.35,0));
   meshes[k].setMatrixAt(fill[k]++,m4.compose(t.set(x,ys[i]-.1*size,z),q,sc.set(size,size*tall*(.85+Math.cos(i*5.1)*.15),size)));
  }
  meshes.forEach((m,k)=>{for(let j=fill[k];j<CAP/KINDS;j++)m.setMatrixAt(j,zero);m.instanceMatrix.needsUpdate=true;});
 };
 return {group,update,count:n};
}
