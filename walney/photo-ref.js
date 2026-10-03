import * as THREE from 'three/webgpu';
import {Fn,uniform,float,vec2,vec4,texture,screenUV,step,select,positionGeometry} from 'three/tsl';

// A reference photo laid over the view, fitted to the screen's height. The camera is set to the
// photo's place, heading, lens and moment (main.js), so the two line up; blend fades between
// render and photo, wipe splits the screen. Photos are private (refs/, git-ignored): on the
// public site there is no photos.json and the menu stays hidden.
export async function createPhotoRef(){
 let list;
 try{const r=await fetch('../refs/photos.json');if(!r.ok)return null;list=await r.json();}catch{return null;}
 if(!list.length)return null;
 const U={amount:uniform(.5),mode:uniform(1),aspect:uniform(1),view:uniform(1)};
 const blank=new THREE.DataTexture(new Uint8Array([0,0,0,0]),1,1);blank.needsUpdate=true;
 const tex=texture(blank);
 const mat=new THREE.MeshBasicNodeMaterial({transparent:true,depthTest:false,depthWrite:false,fog:false});
 mat.toneMapped=false;
 mat.vertexNode=vec4(positionGeometry.xy,0,1);            // a full-screen quad
 const look=Fn(()=>{
  const u=screenUV.x.sub(.5).mul(U.view.div(U.aspect)).add(.5);   // the photo spans the height, centred
  const inside=step(0,u).mul(step(u,1));
  const c=tex.sample(vec2(u,screenUV.y)).rgb;
  const a=select(U.mode.greaterThan(.5),step(screenUV.x,U.amount),U.amount).mul(inside);
  return vec4(c,a);
 })();
 mat.colorNode=look.rgb;mat.opacityNode=look.a;
 const mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),mat);
 mesh.frustumCulled=false;mesh.renderOrder=1001;mesh.visible=false;
 const cache=new Map();
 const load=async i=>{
  const P=list[i];
  if(!cache.has(P.file)){
   const blob=await (await fetch('../refs/'+P.file)).blob();
   const bmp=await createImageBitmap(blob,{imageOrientation:'from-image'});
   const t=new THREE.Texture(bmp);t.colorSpace=THREE.SRGBColorSpace;t.flipY=false;t.needsUpdate=true;
   cache.set(P.file,t);
  }
  tex.value=cache.get(P.file);U.aspect.value=P.aspect;
  return P;
 };
 return {mesh,U,list,load};
}
