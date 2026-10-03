import * as THREE from 'three/webgpu';

// The surface map: a hand-painted layer over the 4 m near zone saying what the ground really is
// where the rules (LiDAR height, OpenStreetMap land cover) get it wrong. 0 leaves the rules alone.
// Painted on the minimap; saved through the local dev server to walney/data/surface.png, so it
// ships with the site. The ground shader, the grass and the bushes all read it.
export const SURFACES=[
 {id:0,name:'Clear (auto)',color:null},
 {id:1,name:'Sand',color:'#e8d39a'},
 {id:2,name:'Shingle / pebbles',color:'#9a9a9a'},
 {id:3,name:'Mud / silt',color:'#6d6553'},
 {id:4,name:'Saltmarsh',color:'#7d9a5c'},
 {id:5,name:'Scrub / bushes',color:'#2f4a26'},
 {id:6,name:'Grass',color:'#9cc46a'},
 {id:7,name:'Rock',color:'#5b5b63'},
];

export async function createSurface(meta){
 const N=meta.near,W=N.size[0],H=N.size[1];
 const data=new Uint8Array(W*H);
 try{
  const r=await fetch('./data/surface.png');
  if(r.ok){
   const bmp=await createImageBitmap(await r.blob(),{colorSpaceConversion:'none',premultiplyAlpha:'none'});
   const cv=new OffscreenCanvas(W,H),cx=cv.getContext('2d',{willReadFrequently:true});cx.drawImage(bmp,0,0);
   const px=cx.getImageData(0,0,W,H).data;for(let i=0;i<W*H;i++)data[i]=px[i*4];
  }
 }catch{}
 const tex=new THREE.DataTexture(data,W,H,THREE.RedFormat,THREE.UnsignedByteType);
 tex.magFilter=tex.minFilter=THREE.NearestFilter;tex.generateMipmaps=false;tex.needsUpdate=true;
 const at=(x,z)=>{const i=Math.floor((x-N.west)/N.res),j=Math.floor((z-N.north)/N.res);return i<0||j<0||i>=W||j>=H?0:data[j*W+i];};
 // paint a disc of radius r metres
 const paint=(x,z,r,id)=>{
  const i0=Math.max(0,Math.floor((x-r-N.west)/N.res)),i1=Math.min(W-1,Math.ceil((x+r-N.west)/N.res));
  const j0=Math.max(0,Math.floor((z-r-N.north)/N.res)),j1=Math.min(H-1,Math.ceil((z+r-N.north)/N.res));
  for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){
   const cx=N.west+(i+.5)*N.res,cz=N.north+(j+.5)*N.res;
   if((cx-x)**2+(cz-z)**2<=r*r)data[j*W+i]=id;
  }
  dirty=true;
 };
 let dirty=false,last=0;
 const flush=(force)=>{const t=performance.now();if(dirty&&(force||t-last>150)){tex.needsUpdate=true;dirty=false;last=t;}};
 // the painted cells as a small overlay image for the minimap
 const overlay=()=>{
  const cv=new OffscreenCanvas(W,H),cx=cv.getContext('2d'),img=cx.createImageData(W,H),c=SURFACES.map(s=>s.color&&[parseInt(s.color.slice(1,3),16),parseInt(s.color.slice(3,5),16),parseInt(s.color.slice(5,7),16)]);
  for(let i=0;i<W*H;i++){const id=data[i];if(!id)continue;const k=i*4,cc=c[id];img.data[k]=cc[0];img.data[k+1]=cc[1];img.data[k+2]=cc[2];img.data[k+3]=150;}
  cx.putImageData(img,0,0);return cv;
 };
 const save=async()=>{
  const cv=new OffscreenCanvas(W,H),cx=cv.getContext('2d'),img=cx.createImageData(W,H);
  for(let i=0;i<W*H;i++){const k=i*4;img.data[k]=img.data[k+1]=img.data[k+2]=data[i];img.data[k+3]=255;}
  cx.putImageData(img,0,0);
  const blob=await cv.convertToBlob({type:'image/png'});
  const r=await fetch('/__surface',{method:'POST',body:blob}).catch(()=>null);
  return !!(r&&r.ok);
 };
 return {tex,at,paint,flush,overlay,save,any:()=>data.some(v=>v)};
}
