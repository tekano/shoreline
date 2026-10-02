import GUI from '../vendor/lil-gui/lil-gui.esm.min.js';
import {LOOK_DEFAULTS,LOOK_SALTREACH} from './look.js?v=1.3.0';

const STORE='shoreline.look';
const PRESETS={'Shoreline (default)':LOOK_DEFAULTS,'Saltreach original':LOOK_SALTREACH};
const USER_PRESETS='shoreline.presets';
const read=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key)||'null')??fallback;}catch{return fallback;}};
const write=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{}};

// The look panel: every slider writes straight into a shader uniform, so the
// sea changes while you drag. The current settings survive a reload.
export function createPanel({look,onSun,onFoam}){
 const params={...LOOK_DEFAULTS,...read(STORE,{})};
 const gui=new GUI({title:'Look'});
 const changed=()=>{look.apply(params);onSun(params.sunAzimuth,params.sunElevation);onFoam({fresh:params.foamFresh,old:params.foamOld});write(STORE,params);};
 const load=values=>{Object.assign(params,LOOK_DEFAULTS,values);gui.controllersRecursive().forEach(c=>c.updateDisplay());changed();};

 const views={'Final':0,'Foam amount (sim)':1,'Foam pattern':2,'Water depth':3,'Flow':4};
 gui.add(params,'debug',views).name('View layer');

 const light=gui.addFolder('Sun');
 light.add(params,'sunElevation',1,85,.5).name('Elevation °');
 light.add(params,'sunAzimuth',-180,180,1).name('Azimuth °');

 const life=gui.addFolder('Foam lifetime (sim)');
 life.add(params,'foamFresh',.05,3,.01).name('Fresh fade /s');
 life.add(params,'foamOld',.01,1,.005).name('Lingering fade /s');
 life.add(params,'freshWeight',0,2,.01).name('Fresh weight');
 life.add(params,'oldWeight',0,2,.01).name('Lingering weight');
 life.add(params,'foamGain',0,3,.01).name('Coverage gain');
 life.add(params,'patchiness',0,2,.01).name('Patchiness');

 const lace=gui.addFolder('Foam pattern');
 lace.add(params,'laceMix',0,1,1).name('Lace (1) / Saltreach (0)');
 lace.add(params,'laceScale',.3,3,.01).name('Scale');
 lace.add(params,'threadWidth',.2,3,.01).name('Thread width');
 lace.add(params,'sheetBias',-.3,.3,.005).name('Sheet threshold');
 lace.add(params,'breakup',0,1,.01).name('Thread breakup');
 lace.add(params,'warp',0,3,.01).name('Warp');
 lace.add(params,'swapPeriod',.5,8,.1).name('Re-form period s');
 lace.add(params,'foamHeight',0,.06,.001).name('Relief height m');
 lace.add(params,'laceShadow',0,1,.01).name('Cast shadow');
 lace.add(params,'selfShade',0,1,.01).name('Self shade');
 lace.add(params,'laceFadeNear',.002,.05,.001).name('Detail fade start');
 lace.add(params,'laceFadeFar',.01,.2,.001).name('Detail fade end');
 lace.close();

 const white=gui.addFolder('Whitewater');
 white.add(params,'whiteStart',0,2,.01).name('Starts at');
 white.add(params,'whiteEnd',0,3,.01).name('Solid at');
 white.add(params,'whiteLumps',0,1.5,.01).name('Lump shading');
 white.close();

 const water=gui.addFolder('Water body');
 water.add(params,'absorbScale',0,3,.01).name('Absorption ×');
 water.add(params,'absorbR',0,20,.1).name('Absorb red /m');
 water.add(params,'absorbG',0,20,.1).name('Absorb green /m');
 water.add(params,'absorbB',0,20,.1).name('Absorb blue /m');
 water.addColor(params,'shallowColor').name('Clear shallow');
 water.addColor(params,'deepColor').name('Clear deep');
 water.add(params,'turbidity',0,1,.01).name('Surf-zone sand');
 water.add(params,'surfDepth',.2,5,.05).name('Surf zone depth m');
 water.addColor(params,'turbidShallow').name('Sandy thin');
 water.addColor(params,'turbidDeep').name('Sandy deep');
 water.close();

 const crest=gui.addFolder('Crest light');
 crest.addColor(params,'crestColor').name('Crest tint');
 crest.add(params,'crestAmount',0,1,.01).name('Tint amount');
 crest.addColor(params,'glowColor').name('Backlit glow');
 crest.add(params,'glowAmount',0,2,.01).name('Glow amount');
 crest.close();

 const surface=gui.addFolder('Surface');
 surface.add(params,'reflectivity',0,1.5,.01).name('Reflection');
 surface.add(params,'sunSpec',0,2,.01).name('Sun highlight');
 surface.add(params,'glintStrength',0,4,.01).name('Glints');
 surface.add(params,'glintSigma',.03,.5,.005).name('Glint spread');
 surface.add(params,'glintRate',0,4,.01).name('Glint twinkle');
 surface.add(params,'foamSparkle',0,4,.01).name('Foam sparkle');
 surface.close();

 const presets=gui.addFolder('Presets');
 const user=()=>read(USER_PRESETS,{});
 const state={preset:'Shoreline (default)',name:'my look'};
 const names=()=>[...Object.keys(PRESETS),...Object.keys(user())];
 let picker=presets.add(state,'preset',names()).name('Load').onChange(name=>load(PRESETS[name]??user()[name]));
 presets.add(state,'name').name('Save as');
 const actions={
  save(){const all=user();all[state.name]={...params};write(USER_PRESETS,all);picker=picker.options(names()).onChange(name=>load(PRESETS[name]??user()[name]));state.preset=state.name;picker.updateDisplay();},
  copy(){navigator.clipboard?.writeText(JSON.stringify(params,null,1));},
  paste(){const text=prompt('Paste preset JSON');if(!text)return;try{load(JSON.parse(text));}catch(e){alert('Not valid preset JSON: '+e.message);}},
  download(){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(params,null,1)],{type:'application/json'}));a.download=`${state.name.replace(/[^\w-]+/g,'_')}.json`;a.click();URL.revokeObjectURL(a.href);},
  reset(){load(LOOK_DEFAULTS);}
 };
 presets.add(actions,'save').name('Save preset');
 presets.add(actions,'copy').name('Copy JSON');
 presets.add(actions,'paste').name('Paste JSON');
 presets.add(actions,'download').name('Download JSON');
 presets.add(actions,'reset').name('Reset to default');

 gui.onChange(changed);
 changed();
 return {gui,params,set(values){Object.assign(params,values);gui.controllersRecursive().forEach(c=>c.updateDisplay());changed();},setSun(az,el){params.sunAzimuth=Math.round(az);params.sunElevation=Math.round(el*2)/2;gui.controllersRecursive().forEach(c=>c.updateDisplay());changed();}};
}
