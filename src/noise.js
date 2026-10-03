import * as THREE from 'three/webgpu';
export function makeNoiseTexture(size=512){
 const hash=(x,y)=>{let h=Math.imul(x,374761393)+Math.imul(y,668265263);h=Math.imul(h^(h>>>13),1274126177);return ((h^(h>>>16))>>>0)/4294967295;};
 const value=(x,y,p)=>{const ix=Math.floor(x),iy=Math.floor(y);let a=x-ix,b=y-iy;a=a*a*(3-2*a);b=b*b*(3-2*b);const xx=((ix%p)+p)%p,yy=((iy%p)+p)%p;return (hash(xx,yy)*(1-a)+hash((xx+1)%p,yy)*a)*(1-b)+(hash(xx,(yy+1)%p)*(1-a)+hash((xx+1)%p,(yy+1)%p)*a)*b;};
 const data=new Uint8Array(size*size*4);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const s=x/size,t=y/size,k=(y*size+x)*4;
  const f=value(s*8,t*8,8)*.48+value(s*16,t*16,16)*.27+value(s*32,t*32,32)*.15+value(s*64,t*64,64)*.1;
  data[k]=Math.round(f*255);
  data[k+1]=Math.round(value(s*48+3.1,t*48+8.2,48)*255);
  data[k+2]=Math.round(hash(x,y)*255);
  data[k+3]=Math.round(value(s*128,t*128,128)*255);
 }
 const tex=new THREE.DataTexture(data,size,size,THREE.RGBAFormat);
 tex.wrapS=tex.wrapT=THREE.RepeatWrapping;tex.magFilter=THREE.LinearFilter;
 tex.minFilter=THREE.LinearMipmapLinearFilter;tex.generateMipmaps=true;tex.needsUpdate=true;
 return tex;
}

// Gradient (Perlin) noise, tileable, for textures seen over wide areas (sand grain, foam).
// Value noise shows faint straight lines along its lattice; gradient noise does not, and the
// octaves here sit at non-harmonic periods (12, 20, 33, 54 cells per tile) so no octave lines up
// with another. R: four octaves; G: three octaves offset differently. Matched to the old texture's
// mean and spread, channel by channel, so thresholds tuned on it still hold.
export function makeDetailNoiseTexture(size=384){
 const hash=(x,y,s)=>{let h=Math.imul(x,374761393)+Math.imul(y,668265263)+Math.imul(s,1442695041);h=Math.imul(h^(h>>>13),1274126177);return ((h^(h>>>16))>>>0)/4294967295;};
 const grad=(x,y,p,s)=>{
  const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy;
  const g=(cx,cy)=>{const a=hash(((cx%p)+p)%p,((cy%p)+p)%p,s)*6.2831853;return [Math.cos(a),Math.sin(a)];};
  const d=(cx,cy,dx,dy)=>{const v=g(cx,cy);return v[0]*dx+v[1]*dy;};
  const u=fx*fx*fx*(fx*(fx*6-15)+10),v=fy*fy*fy*(fy*(fy*6-15)+10);
  const a=d(ix,iy,fx,fy),b=d(ix+1,iy,fx-1,fy),c=d(ix,iy+1,fx,fy-1),e=d(ix+1,iy+1,fx-1,fy-1);
  return (a*(1-u)+b*u)*(1-v)+(c*(1-u)+e*u)*v;   // ~[-0.7, 0.7]
 };
 const R=new Float32Array(size*size),G=new Float32Array(size*size);
 const oR=[[12,.46,1],[20,.28,2],[33,.16,3],[54,.1,4]],oG=[[14,.55,5],[26,.3,6],[45,.15,7]];
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const s=x/size,t=y/size,i=y*size+x;
  let r=0,g=0;for(const [p,w,k] of oR)r+=grad(s*p,t*p,p,k)*w;for(const [p,w,k] of oG)g+=grad(s*p,t*p,p,k)*w;
  R[i]=r;G[i]=g;
 }
 // match the value-noise texture channel by channel (R: mean .462, sd .138; G: .5, .216)
 const fit=(A,mu,sdT)=>{let m=0;for(const v of A)m+=v;m/=A.length;let q=0;for(const v of A)q+=(v-m)**2;const sd=Math.sqrt(q/A.length);return v=>Math.max(0,Math.min(255,Math.round(((v-m)/sd*sdT+mu)*255)));};
 const fr=fit(R,.462,.138),fg=fit(G,.5,.216),data=new Uint8Array(size*size*4);
 for(let i=0;i<size*size;i++){data[i*4]=fr(R[i]);data[i*4+1]=fg(G[i]);data[i*4+2]=128;data[i*4+3]=255;}
 const tex=new THREE.DataTexture(data,size,size,THREE.RGBAFormat);
 tex.wrapS=tex.wrapT=THREE.RepeatWrapping;tex.magFilter=THREE.LinearFilter;
 tex.minFilter=THREE.LinearMipmapLinearFilter;tex.generateMipmaps=true;tex.needsUpdate=true;
 return tex;
}
