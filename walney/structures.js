import * as THREE from 'three/webgpu';
import {attribute,mix,vec3,float,smoothstep,positionWorld} from 'three/tsl';

// Small man-made things that tell you where you are: buildings extruded from
// their OpenStreetMap footprints (standing on the LiDAR ground), and the wind
// turbines at their mapped positions, facing into the wind and turning with it.
// Map data © OpenStreetMap contributors (ODbL).
const WALL={house:[.78,.75,.70],hut:[.13,.13,.13],industry:[.62,.64,.65]};   // render, black-tarred huts, grey cladding
const ROOF={house:[.33,.31,.31],hut:[.09,.09,.09],industry:[.55,.57,.58]};    // slate, felt, metal

export function createStructures({features,height,look,offshore=[]}){
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
  // no two buildings alike: render, pebbledash, brick or painted walls; slate, tile or metal roofs
  const hr=k=>((Math.sin(pts[0][0]*12.9898+pts[0][1]*78.233+k*37.7)*43758.5453)%1+1)%1;
  const WALLS=b.k==='house'?[[.78,.75,.70],[.62,.58,.52],[.52,.36,.28],[.80,.80,.78],[.66,.64,.58]]:b.k==='industry'?[[.62,.64,.65],[.42,.46,.48],[.55,.58,.52],[.30,.33,.36]]:[wall];
  const ROOFS=b.k==='house'?[[.33,.31,.31],[.42,.27,.22],[.26,.27,.29],[.48,.42,.36]]:b.k==='industry'?[[.55,.57,.58],[.40,.44,.47],[.30,.34,.30]]:[roof];
  const tint=.85+hr(1)*.25;
  const wc=WALLS[Math.floor(hr(2)*WALLS.length)].map(c=>c*tint),rc=ROOFS[Math.floor(hr(3)*ROOFS.length)].map(c=>c*tint);
  const wl=wc.map(c=>c*.7);                                                            // grime and shade low down
  for(let i=0;i<pts.length;i++){
   const [x0,z0]=pts[i],[x1,z1]=pts[(i+1)%pts.length];
   const a=v(x0,base,z0,wl),bb=v(x1,base,z1,wl),c=v(x1,top,z1,wc),d=v(x0,top,z0,wc);
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
 mat.colorNode=attribute('color','vec3').mul(.6).mul(look.cloudShade(positionWorld));   // walls and roofs reflect ~20-30%
 const buildings=new THREE.Mesh(g,mat);buildings.frustumCulled=false;group.add(buildings);

 // ---------- wind turbines ----------
 // OpenStreetMap has no sizes for these, so a typical onshore machine is assumed
 const HUB=50,ROTOR=44;
 const white=new THREE.MeshStandardNodeMaterial({color:'#e8eaea',roughness:.55});
 white.colorNode=vec3(1,1,1).mul(look.cloudShade(positionWorld));
 white.emissiveNode=look.U.skyAmb.mul(.12);   // painted white: stays readable against haze (scaled with the light, so dark at night)
 const towerG=new THREE.CylinderGeometry(1.1,2,HUB,14).translate(0,HUB/2,0);
 const nacelleG=new THREE.BoxGeometry(3.2,3,8).translate(0,0,1);
 const bladeG=new THREE.BoxGeometry(.9,ROTOR/2,.25).translate(0,ROTOR/4,0);
 // a slight taper so blades read as blades, not planks
 {const p=bladeG.attributes.position;for(let i=0;i<p.count;i++){const yy=p.getY(i)/(ROTOR/2);p.setX(i,p.getX(i)*(1-yy*.65));}p.needsUpdate=true;bladeG.computeVertexNormals();}
 const turbines=[],lamps=[];
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
  // aviation light on the nacelle: steady red, 2000 cd dimmed to 200 cd in good visibility (UK CAA)
  lamps.push({pos:[x,ground+HUB+2,z],cd:200,color:[1,.08,.03],flash:0});
 }
 // ---------- the offshore wind farms ----------
 // Walney 1-2 and its Extension, West of Duddon Sands, Ormonde and Barrow: ~340 machines
 // on the western horizon, drawn instanced (one draw per part) at their real sizes
 const unitTower=new THREE.CylinderGeometry(.5,1,1,10).translate(0,.5,0);   // scaled to hub height and rotor/40 at the base
 const unitHead=new THREE.BoxGeometry(.06,.05,.13).translate(0,0,.016);               // scaled by rotor diameter
 const unitRotor=(()=>{const parts=[];for(let k=0;k<3;k++){const b=new THREE.BoxGeometry(.03,.5,.008).translate(0,.25,0);b.rotateZ(k*Math.PI*2/3);parts.push(b);}
  const g=new THREE.BufferGeometry(),pos=[],nor=[];for(const b of parts){const bb=b.toNonIndexed();pos.push(...bb.attributes.position.array);nor.push(...bb.attributes.normal.array);}
  g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));return g;})();
 const nOff=offshore.length;
 const towers=new THREE.InstancedMesh(unitTower,white,nOff),heads=new THREE.InstancedMesh(unitHead,white,nOff),rotors=new THREE.InstancedMesh(unitRotor,white,nOff);
 const m4=new THREE.Matrix4(),q=new THREE.Quaternion(),e=new THREE.Euler(),V3=new THREE.Vector3(),sc=new THREE.Vector3();
 const farm=offshore.map(([x,z,hub,rotor,lit],i)=>{
  const y=Math.max(height(x,z),0);
  towers.setMatrixAt(i,m4.makeScale(rotor/40,hub,rotor/40).setPosition(x,y,z));   // towers thicken with the machine
  return {x,y:y+hub,z,rotor,lit,phase:Math.random()*6.3};
 });
 // the yellow transition piece (~20 m above the sea, painted for visibility) and its grey work platform
 const yellow=new THREE.MeshStandardNodeMaterial({roughness:.6});yellow.colorNode=vec3(.85,.62,.06).mul(look.cloudShade(positionWorld));
 const grey=new THREE.MeshStandardNodeMaterial({roughness:.8});grey.colorNode=vec3(.32,.33,.34).mul(look.cloudShade(positionWorld));
 const tps=new THREE.InstancedMesh(new THREE.CylinderGeometry(1,1,1,12).translate(0,.5,0),yellow,nOff);
 const decks=new THREE.InstancedMesh(new THREE.CylinderGeometry(1,1,1,14).translate(0,.5,0),grey,nOff);
 offshore.forEach(([x,z,hub,rotor],i)=>{
  const y=Math.max(height(x,z),0),r=rotor/40*1.15;
  tps.setMatrixAt(i,m4.makeScale(r,20,r).setPosition(x,y,z));
  decks.setMatrixAt(i,m4.makeScale(r*2.2,.6,r*2.2).setPosition(x,y+20,z));
 });
 for(const m of [towers,heads,rotors,tps,decks]){m.frustumCulled=false;if(nOff)group.add(m);}
 const placeFarm=(yaw,spin)=>{
  farm.forEach((t,i)=>{
   heads.setMatrixAt(i,m4.compose(V3.set(t.x,t.y,t.z),q.setFromEuler(e.set(0,yaw,0)),sc.setScalar(t.rotor)));
   const back=V3.set(0,0,-.03*t.rotor).applyAxisAngle(sc.set(0,1,0),yaw);
   rotors.setMatrixAt(i,m4.compose(V3.set(t.x+back.x,t.y,t.z+back.z),q.setFromEuler(e.set(0,yaw,t.phase-spin,'YXZ')),sc.setScalar(t.rotor)));
  });
  heads.instanceMatrix.needsUpdate=rotors.instanceMatrix.needsUpdate=true;
 };
 let spin=0;
 if(nOff)placeFarm(0,0);   // placed once now, then every frame with the wind
 // face into the wind; spin from cut-in at 3 m/s up to ~16 rpm
 const update=(dt,wind,windSpeed)=>{
  const yaw=Math.atan2(wind.x,wind.y);           // rotor on the upwind side
  const rpm=windSpeed<3?0:Math.min(16,2+windSpeed*1.4);
  for(const t of turbines){t.head.rotation.y=yaw;t.rotor.rotation.z-=rpm/60*Math.PI*2*dt;}
  spin+=rpm*.7/60*Math.PI*2*dt;if(nOff)placeFarm(yaw,spin);   // the big offshore rotors turn slower
 };
 // aviation lights on the offshore nacelles round each farm's edge: red, flashing Morse W in sync (UK CAA),
 // 2000 cd dimmed to 200 cd in good visibility
 for(const t of farm)if(t.lit)lamps.push({pos:[t.x,t.y+4,t.z],cd:200,color:[1,.08,.03],flash:-5});
 return {group,update,lamps,count:{buildings:features.buildings.length,turbines:turbines.length}};
}
