import * as THREE from 'three/webgpu';
import {Fn,uniform,float,vec2,vec4,texture,normalize,positionWorld,cameraPosition,atan,asin,fract,step,select,screenUV,smoothstep,min,max} from 'three/tsl';

// A reference photo overlay for matching the scene by eye. The 360° pano is
// wrapped on a sphere around the camera, so from the spot where it was taken
// it lines up with the 3D scene at any heading or lens. Blend fades between
// render and photo; wipe splits the screen at the slider.
//
// The pano is private (it has people in it) and lives in refs/, which git
// ignores; on the public site the file is absent and the control stays hidden.
export const PANOS={
 sandscale:{
  url:'../refs/sandscale-pano.jpg',
  label:'Sandscale dunes, 10 Jul 2022',
  pos:[1809.4,-4414.2],eye:1.6,
  // equirectangular, cropped: the full image would be 9426 × 4713; this keeps rows 1572–3191
  fullH:4713,top:1572,cropH:1619,
  // Black Combe's summit sits at u = 0.329 and lies on a bearing of 334.7° from here
  uRef:.329,bearingRef:334.7
 }
};

export async function createPanoRef(key='sandscale'){
 const P=PANOS[key];
 let bmp;
 try{
  const res=await fetch(P.url);if(!res.ok)return null;
  // WebGPU textures top out at 8192 px wide
  bmp=await createImageBitmap(await res.blob(),{resizeWidth:8192,resizeHeight:Math.round(8192*P.cropH/9426),resizeQuality:'high'});
 }catch{return null;}
 const tex=new THREE.Texture(bmp);tex.colorSpace=THREE.SRGBColorSpace;tex.wrapS=THREE.RepeatWrapping;tex.needsUpdate=true;
 const U={amount:uniform(0),mode:uniform(0),yaw:uniform(0),pitch:uniform(0)};   // mode 0 blend, 1 wipe
 const mat=new THREE.MeshBasicNodeMaterial({side:THREE.BackSide,transparent:true,depthTest:false,depthWrite:false,fog:false});
 mat.toneMapped=false;
 const look=Fn(()=>{
  const d=normalize(positionWorld.sub(cameraPosition));
  const bearing=atan(d.x,d.z.negate()).mul(57.29578);            // compass, degrees
  const el=asin(d.y).mul(57.29578).add(U.pitch);
  const u=fract(float(P.uRef).add(bearing.sub(P.bearingRef).add(U.yaw).div(360)));
  const yFull=float(90).sub(el).div(180).mul(P.fullH);
  const v=yFull.sub(P.top).div(P.cropH);
  const inside=step(0,v).mul(step(v,1));
  const c=texture(tex,vec2(u,float(1).sub(v))).rgb;   // image rows run top-down
  // blend: the whole photo at `amount`; wipe: the photo left of the line at `amount`
  const wipe=step(screenUV.x,U.amount);
  const a=select(U.mode.greaterThan(.5),wipe,U.amount).mul(inside);
  return vec4(c,a);
 })();
 mat.colorNode=look.rgb;mat.opacityNode=look.a;
 const mesh=new THREE.Mesh(new THREE.SphereGeometry(1000,96,48),mat);
 mesh.renderOrder=1000;mesh.frustumCulled=false;
 return {mesh,U,info:P,follow:camera=>mesh.position.copy(camera.position)};
}
