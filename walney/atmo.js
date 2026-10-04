// A physically based atmosphere, after Hillaire 2020 ("A Scalable and Production
// Ready Sky and Atmosphere Rendering Technique"), the model behind Unreal's
// SkyAtmosphere. Air (Rayleigh), sea haze (Mie) and ozone are given real
// scattering coefficients; sunlight arrives at 128,000 lux above the air.
// Everything else follows from that: sun colour and strength at the ground,
// the sky's brightness and colour in every direction, multiple scattering,
// the haze over distance, and the light the land receives.
//
// The tables are small and built on the CPU (a few ms), so the same numbers
// light the scene, meter the exposure and feed the shaders:
//   transmittance  T(h, mu)        256 x 64   rebuilt when the haze changes
//   multi-scatter  Psi(h, mu_s)     32 x 32   rebuilt when the haze changes
//   sky view       L(az, el)        96 x 48   rebuilt when the sun or haze moves
// Units: metres, lux, cd/m2. Sky radiance is stored per unit of top-of-air sun.

export const E0=128000;                       // solar illuminance above the atmosphere, lux
const R0=6360e3,R1=6460e3,HTOP=R1-R0;
const BR=[8.67e-6,13.558e-6,26.5e-6],HR=8000;   // air: Rayleigh scattering at sea level, per metre, at sRGB-like 615/550/465 nm
const HM=2000,GM=.8;                             // sea haze, mixed up through a ~2 km summer boundary layer, and forward-scattering
const OZ=[2.85e-6,1.881e-6,.23e-6];              // ozone absorption at its peak, ~25 km: the deep blue overhead
const ozone=h=>Math.max(0,1-Math.abs(h-25000)/15000);
const PI=Math.PI,ALBEDO=.2;                      // dunes, marsh and sea seen from above
export const phaseR=c=>3/(16*PI)*(1+c*c);
export const phaseM=c=>{const g=GM;return (1-g*g)/(4*PI*Math.pow(1+g*g-2*g*c,1.5));};

// Haze (the slider) sets the aerosol at sea level. Maritime haze barely absorbs.
// Each step of the slider doubles it: 0 is crisp (~220 km), 4 a coastal summer day, 10 fog (~1 km).
export const mieFor=haze=>{const s=4e-6*2**haze;return {s,e:s*1.05};};
export const visibilityKm=haze=>3.912/(BR[1]+mieFor(haze).e)/1000;   // meteorological range at 550 nm

const rayTop=(r,mu)=>-r*mu+Math.sqrt(Math.max(r*r*(mu*mu-1)+R1*R1,0));
const rayGround=(r,mu)=>{const d=r*r*(mu*mu-1)+R0*R0;return mu<0&&d>=0?-r*mu-Math.sqrt(d):-1;};

export function createAtmosphere(){
 const TW=256,TH=64,MW=32,MH=32,SW=96,SH=48;
 const tLUT=new Float32Array(TW*TH*3),mLUT=new Float32Array(MW*MH*3),sky=new Float32Array(SW*SH*3);
 let mie=mieFor(1),camH=20;

 const tUV=(h,mu)=>[(Math.sign(mu)*Math.sqrt(Math.abs(mu))+1)/2,Math.sqrt(Math.min(Math.max(h,0),HTOP)/HTOP)];
 const bilerp=(lut,W,H,u,v,out)=>{
  const x=Math.min(Math.max(u*(W-1),0),W-1.0001),y=Math.min(Math.max(v*(H-1),0),H-1.0001);
  const x0=x|0,y0=y|0,fx=x-x0,fy=y-y0;
  for(let c=0;c<3;c++){
   const a=lut[(y0*W+x0)*3+c],b=lut[(y0*W+x0+1)*3+c],d=lut[((y0+1)*W+x0)*3+c],e=lut[((y0+1)*W+x0+1)*3+c];
   out[c]=(a*(1-fx)+b*fx)*(1-fy)+(d*(1-fx)+e*fx)*fy;
  }
  return out;
 };
 const T=(h,mu,out=[0,0,0])=>{const [u,v]=tUV(h,mu);return bilerp(tLUT,TW,TH,u,v,out);};
 const Psi=(h,mu,out=[0,0,0])=>bilerp(mLUT,MW,MH,(mu+1)/2,Math.sqrt(Math.min(Math.max(h,0),HTOP)/HTOP),out);

 // scattering and extinction at height h
 const coef=(h,o)=>{
  h=Math.max(h,0);const r=Math.exp(-h/HR),m=Math.exp(-h/HM),z=ozone(h);
  for(let c=0;c<3;c++){o.sR[c]=BR[c]*r;o.ext[c]=BR[c]*r+mie.e*m+OZ[c]*z;}
  o.sM=mie.s*m;return o;
 };

 function buildTransmittance(){
  const o={sR:[0,0,0],ext:[0,0,0],sM:0},N=40;
  for(let j=0;j<TH;j++)for(let i=0;i<TW;i++){
   const x=i/(TW-1)*2-1,mu=Math.sign(x)*x*x,h=Math.max(Math.pow(j/(TH-1),2)*HTOP,2),r=R0+h;
   const k=(j*TW+i)*3;
   if(rayGround(r,mu)>0){tLUT[k]=tLUT[k+1]=tLUT[k+2]=0;continue;}   // the sun is below this point's horizon
   const L=rayTop(r,mu),dt=L/N,od=[0,0,0];
   for(let s=0;s<N;s++){
    const t=(s+.5)*dt,hh=Math.sqrt(r*r+t*t+2*r*mu*t)-R0;coef(hh,o);
    for(let c=0;c<3;c++)od[c]+=o.ext[c]*dt;
   }
   for(let c=0;c<3;c++)tLUT[k+c]=Math.exp(-od[c]);
  }
 }

 // Hillaire's multiple scattering: from each point, gather second-order light from
 // all directions with an isotropic phase, then sum the infinite series as 1/(1-f).
 function buildMultiScatter(){
  const o={sR:[0,0,0],ext:[0,0,0],sM:0},ts=[0,0,0],N=20,D=8,dirs=[];
  for(let a=0;a<D;a++)for(let b=0;b<D;b++){const ct=1-2*(a+.5)/D,st=Math.sqrt(1-ct*ct),ph=2*PI*(b+.5)/D;dirs.push([st*Math.cos(ph),ct,st*Math.sin(ph)]);}
  const iso=1/(4*PI);
  for(let j=0;j<MH;j++)for(let i=0;i<MW;i++){
   const muS=i/(MW-1)*2-1,h=Math.max(Math.pow(j/(MH-1),2)*HTOP,2),r=R0+h,sun=[Math.sqrt(1-muS*muS),muS,0];
   const L2=[0,0,0],fms=[0,0,0];
   for(const d of dirs){
    const mu=d[1],g=rayGround(r,mu),L=g>0?g:rayTop(r,mu),dt=L/N,Tv=[1,1,1];
    for(let s=0;s<N;s++){
     const t=(s+.5)*dt,px=d[0]*t,py=r+d[1]*t,pz=d[2]*t,rr=Math.hypot(px,py,pz),hh=rr-R0;
     coef(hh,o);T(hh,(px*sun[0]+py*sun[1])/rr,ts);
     for(let c=0;c<3;c++){
      const sc=o.sR[c]+o.sM,st=Math.exp(-o.ext[c]*dt),w=Tv[c]*(1-st)/o.ext[c];
      L2[c]+=w*sc*ts[c]*iso;fms[c]+=w*sc;Tv[c]*=st;
     }
    }
    if(g>0){   // ground bounce, lit by the sun at the point below
     const gx=d[0]*g,gy=r+d[1]*g,gz=d[2]*g,gr=Math.hypot(gx,gy,gz),mg=(gx*sun[0]+gy*sun[1])/gr;
     T(0,mg,ts);for(let c=0;c<3;c++)L2[c]+=Tv[c]*ts[c]*Math.max(mg,0)*ALBEDO/PI;}
   }
   const k=(j*MW+i)*3;
   for(let c=0;c<3;c++){const l=L2[c]/dirs.length,f=fms[c]/dirs.length*iso*4*PI;mLUT[k+c]=l/(1-f);}
  }
 }

 // the sky as seen from the camera: azimuth from the sun (0..180 deg, the sky is
 // symmetric about the sun's plane) and elevation (squeezed toward the horizon)
 let sunMu=1;
 // rows j0..j1 of the sky table into out (the playback builds the next table a few rows a frame)
 function buildSky(sunY,out=sky,j0=0,j1=SH){
  if(out===sky&&j0===0)sunMu=sunY;
  const o={sR:[0,0,0],ext:[0,0,0],sM:0},ts=[0,0,0],ps=[0,0,0],N=24;
  const sx=Math.sqrt(Math.max(1-sunY*sunY,0)),r=R0+camH;
  for(let j=j0;j<j1;j++)for(let i=0;i<SW;i++){
   const x=j/(SH-1)*2-1,el=Math.sign(x)*x*x*PI/2,az=i/(SW-1)*PI;
   const d=[Math.cos(el)*Math.cos(az),Math.sin(el),Math.cos(el)*Math.sin(az)];
   const c=d[0]*sx+d[1]*sunY,pr=phaseR(c),pm=phaseM(c);
   const g=rayGround(r,d[1]),Lr=g>0?g:rayTop(r,d[1]),L=[0,0,0],Tv=[1,1,1];
   let t0=0;
   for(let s=0;s<N;s++){
    const t1=Lr*Math.pow((s+1)/N,2),dt=t1-t0,t=(t0+t1)/2;t0=t1;   // fine steps near the eye, coarse far away
    const px=d[0]*t,py=r+d[1]*t,pz=d[2]*t,rr=Math.hypot(px,py,pz),hh=rr-R0,mS=(px*sx+py*sunY)/rr;
    coef(hh,o);T(hh,mS,ts);Psi(hh,mS,ps);
    for(let k=0;k<3;k++){
     const S=ts[k]*(o.sR[k]*pr+o.sM*pm)+ps[k]*(o.sR[k]+o.sM),st=Math.exp(-o.ext[k]*dt);
     L[k]+=Tv[k]*S*(1-st)/o.ext[k];Tv[k]*=st;
    }
   }
   const k=(j*SW+i)*3;out[k]=L[0];out[k+1]=L[1];out[k+2]=L[2];
  }
 }
 const skyAt=(el,az,out=[0,0,0],tab=sky)=>{const x=Math.sign(el)*Math.sqrt(Math.abs(el)/(PI/2));return bilerp(tab,SW,SH,az/PI,(x+1)/2,out);};

 // light on level ground from the whole sky (per unit top-of-air sun)
 function skyIrradiance(tab=sky){
  const E=[0,0,0],v=[0,0,0],NE=24,NA=24;
  for(let a=0;a<NE;a++){
   const el=(a+.5)/NE*PI/2,w=Math.sin(el)*Math.cos(el)*(PI/2/NE)*(PI/NA)*2;   // both halves of the dome
   for(let b=0;b<NA;b++){skyAt(el,(b+.5)/NA*PI,v,tab);for(let c=0;c<3;c++)E[c]+=v[c]*w;}
  }
  return E;
 }

 function setHaze(haze){mie=mieFor(haze);buildTransmittance();buildMultiScatter();}
 setHaze(1);
 return {
  setHaze,buildSky,skyAt,skyIrradiance,sky,SW,SH,
  sunTransmittance:mu=>T(camH,mu),msAt:mu=>Psi(camH,mu),
  get mie(){return mie;},
  // optical depth straight up, for starlight and the aerial-perspective shader
  zenithDepth:()=>BR.map((b,c)=>b*HR+mie.e*HM+OZ[c]*15000),
  BR,HR,HM,GM
 };
}
