import * as THREE from 'three/webgpu';
const DATA=new URLSearchParams(location.search).has('play')?'./play/data/':'./data/';

// OpenStreetMap land cover rasterised onto the LiDAR grids (terrain/landcover.py).
// One class id per cell; ids are listed in meta.landcover.classes.
async function loadClassMap(url,info){
 const blob=await (await fetch(url)).blob();
 const bmp=await createImageBitmap(blob,{colorSpaceConversion:'none',premultiplyAlpha:'none'});
 const canvas=new OffscreenCanvas(bmp.width,bmp.height),ctx=canvas.getContext('2d',{willReadFrequently:true});
 ctx.drawImage(bmp,0,0);
 const rgba=ctx.getImageData(0,0,bmp.width,bmp.height).data,data=new Uint8Array(bmp.width*bmp.height);
 for(let i=0;i<data.length;i++)data[i]=rgba[i*4];
 const tex=new THREE.DataTexture(data,bmp.width,bmp.height,THREE.RedFormat,THREE.UnsignedByteType);
 tex.magFilter=tex.minFilter=THREE.NearestFilter;tex.generateMipmaps=false;tex.needsUpdate=true;
 return {...info,w:bmp.width,hgt:bmp.height,data,tex};
}

export async function loadLandcover(meta){
 if(!meta.landcover)return null;
 const [near,far]=await Promise.all([loadClassMap(DATA+'landcover_near.png',meta.near),loadClassMap(DATA+'landcover_far.png',meta.far)]);
 const at=(L,x,z)=>{const i=Math.floor((x-L.west)/L.res),j=Math.floor((z-L.north)/L.res);return i<0||j<0||i>=L.w||j>=L.hgt?-1:L.data[j*L.w+i];};
 const classAt=(x,z)=>{const c=at(near,x,z);return c>=0?c:Math.max(at(far,x,z),0);};
 return {near,far,classAt,ids:meta.landcover.classes};
}
