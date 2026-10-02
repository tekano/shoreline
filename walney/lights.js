import * as THREE from 'three/webgpu';
import {Fn,attribute,uniform,vec3,vec4,float,exp,dot,length,max,step,fract,select,cameraProjectionMatrix,cameraViewMatrix,cameraPosition,screenSize,varying} from 'three/tsl';

// Lamps at their real intensities. A lamp of I candela at distance d gives the eye
// I/d^2 lux, dimmed by the haze on the way. Drawn as a small spot, that is a
// luminance like the sky's, so the same exposure decides what shows: lost in the
// daylight, bright at night. A faint halo stands in for glare in the eye and lens.
//
// lamps: [{pos:[x,y,z], cd, color:[r,g,b] (any scale), flash:{period,on}|null}]
export function createLights({lamps,look}){
 const {U}=look,n=lamps.length;
 const center=new Float32Array(n*12),corner=new Float32Array(n*8),lamp=new Float32Array(n*16),index=[];
 lamps.forEach((l,i)=>{
  const lum=.2126*l.color[0]+.7152*l.color[1]+.0722*l.color[2];   // colour scaled so its luminance is the candela figure
  const rgb=l.color.map(c=>c/lum*l.cd);
  [[-1,-1],[1,-1],[1,1],[-1,1]].forEach(([u,v],k)=>{
   center.set(l.pos,(i*4+k)*3);corner.set([u,v],(i*4+k)*2);
   lamp.set([...rgb,l.flash?l.flash.period:0],(i*4+k)*4);
  });
  index.push(i*4,i*4+1,i*4+2,i*4,i*4+2,i*4+3);
 });
 const g=new THREE.BufferGeometry();
 g.setAttribute('position',new THREE.BufferAttribute(center,3));   // the bounds; the quad is built in the vertex stage
 g.setAttribute('corner',new THREE.BufferAttribute(corner,2));
 g.setAttribute('lamp',new THREE.BufferAttribute(lamp,4));
 g.setIndex(index);

 const HALF=10,SIG=1.1,HALO=4.5;                 // quad half-size, core and halo widths, in pixels
 const pixAngle=uniform(.001);                   // radians per pixel, from the camera
 const m=new THREE.MeshBasicNodeMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,fog:false});
 const c=attribute('position','vec3');
 m.vertexNode=Fn(()=>{
  const clip=cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(c,1));
  return vec4(clip.xy.add(attribute('corner','vec2').mul(HALF*2).div(screenSize).mul(clip.w)),clip.z,clip.w);
 })();
 const dist=varying(length(c.sub(cameraPosition)));
 m.colorNode=Fn(()=>{
  const r=length(attribute('corner','vec2')).mul(HALF),L=attribute('lamp','vec4');
  // the air between: the same sea-level scattering as the aerial perspective
  const T=exp(U.bR.add(vec3(U.bMe)).mul(dist).negate());
  const E=L.rgb.mul(T).div(max(dist.mul(dist),1));                 // lux at the eye
  const omega=pixAngle.mul(pixAngle).mul(2*Math.PI*SIG*SIG);         // solid angle of the core spot
  const k=exp(r.mul(r).div(-2*SIG*SIG)).add(exp(r.mul(r).div(-2*HALO*HALO)).mul(.03*(SIG/HALO)**2));
  const on=select(L.w.greaterThan(0),step(fract(U.time.div(L.w)),.5),float(1));
  return E.div(omega).mul(k).mul(U.expo).mul(on);
 })();
 const mesh=new THREE.Mesh(g,m);mesh.frustumCulled=false;mesh.renderOrder=5;
 const update=(camera,heightPx)=>{pixAngle.value=2*Math.tan(camera.fov*Math.PI/360)/Math.max(heightPx,1);};
 return {mesh,update};
}
