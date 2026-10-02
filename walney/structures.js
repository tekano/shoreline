import * as THREE from 'three/webgpu';
import {attribute,mix,vec3,float,smoothstep,positionWorld} from 'three/tsl';

// Small man-made things that tell you where you are: buildings extruded from
// their OpenStreetMap footprints (standing on the LiDAR ground), and the wind
// turbines at their mapped positions, facing into the wind and turning with it.
// Map data © OpenStreetMap contributors (ODbL).
const WALL={house:[.78,.75,.70],hut:[.13,.13,.13],industry:[.62,.64,.65]};   // render, black-tarred huts, grey cladding
const ROOF={house:[.33,.31,.31],hut:[.09,.09,.09],industry:[.55,.57,.58]};    // slate, felt, metal

export function createStructures({features,height,look}){
 const group=new THREE.Group();

 // ---------- buildings: one merged mesh ----------
 const pos=[],col=[],idx=[];
 const v=(x,y,z,c)=>{pos.push(x,y,z);col.push(...c);return pos.length/3-1;};
 for(const b of features.buildings){
  let pts=b.p;if(pts.length<3)continue;
  // wind every footprint the same way, so walls face out and roofs face up
  let area=0;for(let i=0;i<pts.length;i++){const [x0,z0]=pts[i],[x1,z1]=pts[(i+1)%pts.length];area+=x0*z1-x1*z0;}
  if(area<0)pts=[...pts].reverse();
  const base=Math.min(...pts.map(([x,z])=>height(x,z)))-.3,top=base+.3+b.h;
  const wall=WALL[b.k]||WALL.house,roof=ROOF[b.k]||ROOF.house;
  const tint=.9+((pts[0][0]*7.3+pts[0][1]*3.1)%1+1)%1*.2;              // no two houses quite the same
  const wc=wall.map(c=>c*tint),rc=roof.map(c=>c*tint);
  for(let i=0;i<pts.length;i++){
   const [x0,z0]=pts[i],[x1,z1]=pts[(i+1)%pts.length];
   const a=v(x0,base,z0,wc),bb=v(x1,base,z1,wc),c=v(x1,top,z1,wc),d=v(x0,top,z0,wc);
   idx.push(a,c,bb,a,d,c);
  }
  const contour=pts.map(([x,z])=>new THREE.Vector2(x,z));
  const tris=THREE.ShapeUtils.triangulateShape(contour,[]);
  const start=pos.length/3;for(const [x,z] of pts)v(x,top,z,rc);
  for(const [a,bb,c] of tris)idx.push(start+a,start+c,start+bb);   // (a,c,b): with this winding the roof faces up
 }
 const g=new THREE.BufferGeometry();
 g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
 g.setAttribute('color',new THREE.Float32BufferAttribute(col,3));
 g.setIndex(idx);g.computeVertexNormals();
 const mat=new THREE.MeshStandardNodeMaterial({roughness:.85,side:THREE.DoubleSide});
 mat.colorNode=attribute('color','vec3').mul(look.cloudShade(positionWorld));
 const buildings=new THREE.Mesh(g,mat);buildings.frustumCulled=false;group.add(buildings);

 // ---------- wind turbines ----------
 // OpenStreetMap has no sizes for these, so a typical onshore machine is assumed
 const HUB=50,ROTOR=44;
 const white=new THREE.MeshStandardNodeMaterial({color:'#e8eaea',roughness:.55});
 white.colorNode=vec3(1,1,1).mul(look.cloudShade(positionWorld));
 white.emissiveNode=vec3(.08,.08,.085);   // painted white: stays readable against haze
 const towerG=new THREE.CylinderGeometry(1.1,2,HUB,14).translate(0,HUB/2,0);
 const nacelleG=new THREE.BoxGeometry(3.2,3,8).translate(0,0,1);
 const bladeG=new THREE.BoxGeometry(.9,ROTOR/2,.25).translate(0,ROTOR/4,0);
 // a slight taper so blades read as blades, not planks
 {const p=bladeG.attributes.position;for(let i=0;i<p.count;i++){const yy=p.getY(i)/(ROTOR/2);p.setX(i,p.getX(i)*(1-yy*.65));}p.needsUpdate=true;bladeG.computeVertexNormals();}
 const turbines=[];
 for(const t of features.turbines){
  const [x,z]=t.pos,ground=height(x,z);
  const tower=new THREE.Mesh(towerG,white);tower.position.set(x,ground,z);
  const head=new THREE.Group();head.position.set(x,ground+HUB,z);
  head.add(new THREE.Mesh(nacelleG,white));
  const rotor=new THREE.Group();rotor.position.set(0,0,-3.2);
  for(let k=0;k<3;k++){const blade=new THREE.Mesh(bladeG,white);blade.rotation.z=k*Math.PI*2/3;rotor.add(blade);}
  rotor.add(new THREE.Mesh(new THREE.SphereGeometry(1.1,10,8),white));
  head.add(rotor);group.add(tower,head);
  turbines.push({head,rotor,phase:Math.random()*6});
 }
 // face into the wind; spin from cut-in at 3 m/s up to ~16 rpm
 const update=(dt,wind,windSpeed)=>{
  const yaw=Math.atan2(wind.x,wind.y);           // rotor on the upwind side
  const rpm=windSpeed<3?0:Math.min(16,2+windSpeed*1.4);
  for(const t of turbines){t.head.rotation.y=yaw;t.rotor.rotation.z-=rpm/60*Math.PI*2*dt;}
 };
 return {group,update,count:{buildings:features.buildings.length,turbines:turbines.length}};
}
