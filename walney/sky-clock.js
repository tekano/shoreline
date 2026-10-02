// The sky clock: where the sun and the bright stars stand over Walney at a
// given date and local time. Low-precision almanac formulae, good to a fraction
// of a degree, which is plenty for lighting and for recognisable constellations.
export const SITE={lat:54.12,lon:-3.27};   // north Walney

// The brightest stars that rise over Walney: name, right ascension (hours),
// declination (degrees), visual magnitude. J2000 positions.
export const STARS=[
 ['Sirius',6.752,-16.716,-1.46],['Arcturus',14.261,19.182,-.05],['Vega',18.616,38.784,.03],['Capella',5.278,45.998,.08],
 ['Rigel',5.242,-8.202,.13],['Procyon',7.655,5.225,.34],['Betelgeuse',5.919,7.407,.5],['Altair',19.846,8.868,.77],
 ['Aldebaran',4.599,16.509,.86],['Antares',16.49,-26.432,1.0],['Spica',13.42,-11.161,.97],['Pollux',7.755,28.026,1.14],
 ['Fomalhaut',22.961,-29.622,1.16],['Deneb',20.69,45.28,1.25],['Regulus',10.14,11.967,1.36],['Adhara',6.977,-28.972,1.5],
 ['Castor',7.577,31.888,1.58],['Bellatrix',5.419,6.35,1.64],['Elnath',5.438,28.608,1.65],['Alnilam',5.604,-1.202,1.69],
 ['Alnitak',5.679,-1.943,1.77],['Alioth',12.9,55.96,1.77],['Dubhe',11.062,61.751,1.79],['Mirfak',3.405,49.861,1.79],
 ['Wezen',7.14,-26.393,1.83],['Alkaid',13.792,49.313,1.86],['Menkalinan',5.992,44.948,1.9],['Alhena',6.629,16.399,1.9],
 ['Polaris',2.53,89.264,1.98],['Mirzam',6.378,-17.956,1.98],['Alphard',9.46,-8.659,1.98],['Hamal',2.12,23.462,2.0],
 ['Diphda',.727,-17.987,2.04],['Nunki',18.921,-26.297,2.05],['Mizar',13.399,54.925,2.23],['Saiph',5.796,-9.67,2.06],
 ['Alpheratz',.14,29.09,2.06],['Kochab',14.845,74.155,2.08],['Rasalhague',17.582,12.56,2.08],['Algol',3.136,40.956,2.1],
 ['Denebola',11.818,14.572,2.14],['Mirach',1.163,35.621,2.06],['Almach',2.065,42.33,2.1],['Navi',.945,60.717,2.15],
 ['Schedar',.675,56.537,2.24],['Caph',.153,59.15,2.28],['Ruchbah',1.43,60.235,2.66],['Segin',1.907,63.67,3.35],
 ['Alphecca',15.578,26.715,2.23],['Sadr',20.37,40.257,2.23],['Eltanin',17.943,51.489,2.24],['Mintaka',5.533,-.299,2.23],
 ['Merak',11.031,56.382,2.37],['Phecda',11.897,53.695,2.44],['Megrez',12.257,57.033,3.31],['Enif',21.736,9.875,2.39],
 ['Scheat',23.063,28.083,2.42],['Markab',23.079,15.205,2.49],['Algenib',.22,15.184,2.83],['Alderamin',21.31,62.585,2.45],
 ['Algieba',10.333,19.842,2.08],['Izar',14.75,27.074,2.37],['Zubeneschamali',15.283,-9.383,2.61],['Albireo',19.512,27.96,3.05],
 ['Vindemiatrix',13.036,10.959,2.83],['Menkar',3.038,4.09,2.54],['Alcyone',3.791,24.105,2.87],['Arneb',5.546,-17.822,2.58],
 ['Unukalhai',15.738,6.426,2.63],['Sabik',17.173,-15.725,2.43],['Dschubba',16.006,-22.622,2.29],['Gienah',20.77,33.97,2.48],
 ['Tarazed',19.771,10.613,2.72],['Muphrid',13.911,18.398,2.68],['Cor Caroli',12.934,38.318,2.89]
];

const RAD=Math.PI/180;
// UK clock: BST (UTC+1) between the last Sundays of March and October, roughly
const utcHours=(day,local)=>local-(day>=88&&day<=298?1:0);
export function julianDay(year,day,local){
 const t=Date.UTC(year,0,1)+((day-1)*24+utcHours(day,local))*3600e3;
 return t/864e5+2440587.5;
}
// local sidereal time, in degrees
export function lstDeg(jd,lon=SITE.lon){
 const g=18.697374558+24.06570982441908*(jd-2451545);
 return(((g*15+lon)%360)+360)%360;
}
// equatorial (RA, Dec in degrees) to a scene direction: x east, y up, z south
export function toScene(raDeg,decDeg,lst,lat=SITE.lat){
 const H=(lst-raDeg)*RAD,d=decDeg*RAD,f=lat*RAD;
 const alt=Math.asin(Math.sin(f)*Math.sin(d)+Math.cos(f)*Math.cos(d)*Math.cos(H));
 const az=Math.atan2(-Math.cos(d)*Math.sin(H),Math.sin(d)*Math.cos(f)-Math.cos(d)*Math.sin(f)*Math.cos(H));
 return [Math.sin(az)*Math.cos(alt),Math.sin(alt),-Math.cos(az)*Math.cos(alt),az/RAD,alt/RAD];
}
// the sun's apparent position (Astronomical Almanac low-precision formulae)
export function sunAt(jd){
 const n=jd-2451545,L=(280.46+.9856474*n)*RAD,g=(357.528+.9856003*n)*RAD;
 const lam=L+(1.915*Math.sin(g)+.02*Math.sin(2*g))*RAD,eps=(23.439-4e-7*n)*RAD;
 return {ra:Math.atan2(Math.cos(eps)*Math.sin(lam),Math.cos(lam))/RAD,dec:Math.asin(Math.sin(eps)*Math.sin(lam))/RAD};
}
export function skyAt(year,day,local){
 const jd=julianDay(year,day,local),lst=lstDeg(jd),s=sunAt(jd);
 const sun=toScene(s.ra,s.dec,lst);
 const stars=STARS.map(([,ra,dec,mag])=>[...toScene(ra*15,dec,lst).slice(0,3),Math.pow(10,-.4*mag)]);
 // scene direction -> celestial (equatorial) frame, so the fill stars and the
 // Milky Way turn with the real sky. Rows map (x east, y up, z south).
 const f=SITE.lat*RAD,L=lst*RAD,sf=Math.sin(f),cf=Math.cos(f),sl=Math.sin(L),cl=Math.cos(L);
 // from (E, Up, N): sinδ = sf·Up + cf·N ; cosδcosH = cf·Up − sf·N ; cosδsinH = −E
 // cel = (cosδcosα, cosδsinα, sinδ) with α = LST − H
 const toCel=[
  [-sl, cf*cl, sf*cl],       // cosδcosα with cosδcosH = cf·y + sf·z, cosδsinH = −x  (x=E, y=Up, z=S=−N)
  [ cl, cf*sl, sf*sl],
  [  0,    sf,    -cf]
 ];
 return {sunAz:((sun[3]%360)+360)%360,sunEl:sun[4],stars,lst,toCel};
}
