'use strict';

const by = id => document.getElementById(id);
const CELLS = 180*360, MISSING = -32768, OUTSIDE = 65535;
const humidityColors = ['834820','b97537','e2c8a6','f6f5eb','b1dedf','458ca5','164e71'];
const humidityModes = {
  absolute: {name:'Absolutní vlhkost', unit:'g/m³', canvasLabel:'Mapa anomálie absolutní vlhkosti'},
  relative: {name:'Relativní vlhkost', unit:'p. b.', canvasLabel:'Mapa anomálie relativní vlhkosti'}
};
const pal = {
  temp: {limit:3, colors:['22417d','5489c2','b8d9ea','f6f5eb','f0bd90','c85e3d','842b32']},
  absolute: {limit:2, colors:humidityColors},
  relative: {limit:6, colors:humidityColors},
  wind: {limit:1, colors:['5b317c','8a64ab','c8b7de','f6f5eb','b7decf','4b9a86','125959']}
};
const months = ['leden','únor','březen','duben','květen','červen','červenec','srpen','září','říjen','listopad','prosinec'];
const mapTypes = ['temp','humidity','wind'];
const maps = Object.fromEntries(mapTypes.map(type => {
  const element = by(type+'-map'), canvas = element.querySelector('canvas');
  return [type, {element, canvas, ctx:canvas.getContext('2d'), line:element.querySelector('img'), target:element.querySelector('.target')}];
}));
const blockCache = new Map(), indexCache = new Map(), payloads = new Map();
window.Atlas = Object.freeze({register(key,payload) { payloads.set(key,payload); }});

function monthIndex(iso) {
  const [y,m] = iso.split('-').map(Number);
  return 12*y + m-1;
}
function monthText(k) { return months[k%12] + ' ' + Math.floor(k/12); }
function num(n, decimals=2) { return n.toLocaleString('cs-CZ',{maximumFractionDigits:decimals}); }
function signed(n,decimals=2) { return (n>0?'+':n<0?'−':'') + num(Math.abs(n),decimals); }
function valueText(n,unit) { return n===MISSING?'chybí data':signed(n/100)+' '+unit; }

async function inflate(s) {
  const raw = Uint8Array.from(atob(s), ch => ch.charCodeAt(0));
  return new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
function loadBlock(key) {
  if (blockCache.has(key)) {
    const promise=blockCache.get(key);
    blockCache.delete(key); blockCache.set(key,promise);
    return promise;
  }
  const script=document.createElement('script');
  const promise=new Promise((resolve,reject)=>{
    script.onload=()=>{const payload=payloads.get(key); payloads.delete(key); payload?resolve(payload):reject(new Error(key));};
    script.onerror=()=>reject(new Error(key));
    script.src='data-1946/'+key+'.js';
    document.head.append(script);
  }).then(inflate).then(buf=>{
    const arr=new Int16Array(buf);
    if (arr.length%CELLS) throw new Error(key);
    for(let i=CELLS;i<arr.length;i++) arr[i]+=arr[i-CELLS];
    return arr;
  }).catch(err=>{blockCache.delete(key);throw err;}).finally(()=>script.remove());
  blockCache.set(key,promise);
  if (blockCache.size>12) blockCache.delete(blockCache.keys().next().value);
  return promise;
}
async function field(type,width,offset) {
  const n=PERIOD.block;
  const data=await loadBlock(type+'-'+width+'-'+Math.floor(offset/n));
  const start=(offset%n)*CELLS;
  if (start+CELLS>data.length) throw new Error('Neúplný snímek');
  return data.subarray(start,start+CELLS);
}
function geography(region) {
  if (!indexCache.has(region)) {
    const g=GEOMETRY[region];
    indexCache.set(region,inflate(g.index).then(buf=>{
      const idx=new Uint16Array(buf);
      if (idx.length!==g.w*g.h) throw new Error('Neplatná geometrie mapy');
      return {idx,w:g.w,h:g.h};
    }));
  }
  return indexCache.get(region);
}
for (const p of Object.values(pal)) {
  const colors=p.colors.map(c=>[0,2,4].map(i=>parseInt(c.slice(i,i+2),16)));
  p.steps=Math.round(100*p.limit);
  p.rgb=Array.from({length:2*p.steps+1},(_,i)=>{
    const t=i/(2*p.steps)*6, j=Math.min(5,Math.floor(t)), a=t-j;
    return colors[j].map((v,k)=>Math.round(v*(1-a)+colors[j+1][k]*a));
  });
}
function setLegend(id, type) {
  const legend = by(id);
  const limit = pal[type].limit;
  legend.textContent = '';
  for(const x of [-limit,-limit/2,0,limit/2,limit]){
    const tick=document.createElement('span');
    tick.textContent=signed(x);
    legend.append(tick);
  }
}
setLegend('temp-legend', 'temp');
setLegend('wind-legend', 'wind');
function draw(map, type, data, geo, region) {
  if (map.canvas.width!==geo.w||map.canvas.height!==geo.h) {
    map.canvas.width=geo.w; map.canvas.height=geo.h;
    map.element.style.aspectRatio=geo.w+'/'+geo.h;
    map.image=map.ctx.createImageData(geo.w,geo.h);
  }
  const pixels=map.image.data, p=pal[type];
  for(let i=0,k=0;i<geo.idx.length;i++,k+=4) {
    const j=geo.idx[i];
    if(j===OUTSIDE) {pixels[k+3]=0;continue;}
    const n=data[j];
    const c=n===MISSING ? [211,216,211] : p.rgb[Math.max(0,Math.min(p.steps*2,n+p.steps))];
    pixels[k]=c[0]; pixels[k+1]=c[1]; pixels[k+2]=c[2]; pixels[k+3]=255;
  }
  map.ctx.putImageData(map.image,0,0);
  if (map.region!==region) {map.line.src='lin-'+region+'.png';map.region=region;}
}
const range=by('month'), play=by('play'), date=by('date');
let width=12, region='world', end, start, chosen, drawn=null, hover=null;
let humidityType='absolute';
let playing=false, sequence=0, timer;

function mark(x) {
  for(const map of Object.values(maps)) {
    map.target.hidden=!x;
    if(x) {map.target.style.left=x.x*100+'%';map.target.style.top=x.y*100+'%';}
  }
}
function updateHover() {
  if (!drawn || !hover) {mark(null); return;}
  const {idx,w,h}=drawn.geo;
  const cell=idx[Math.floor(hover.y*h)*w+Math.floor(hover.x*w)];
  if(cell===undefined||cell===OUTSIDE) {mark(null);by('readout').textContent='Přejeďte přes mapu a porovnejte hodnoty ve stejné buňce.';return;}
  mark(hover);
  const lat=89.5-Math.floor(cell/360), lon=(cell%360)-179.5;
  const pos=num(Math.abs(lat),1)+'° '+(lat>=0?'s. š.':'j. š.')+', '+num(Math.abs(lon),1)+'° '+(lon>=0?'v. d.':'z. d.');
  const mode = humidityModes[drawn.humidityType];
  const filledDays = drawn.estimated[cell];
  const filledReferenceMonths = drawn.referenceEstimates[cell];
  const referenceMonths = 12 * (PERIOD.reference[1] - PERIOD.reference[0] + 1);
  const estimateNote = filledDays || filledReferenceMonths
    ? ' (doplněno v okně '+num(filledDays)+' % dnů, v referenci '+filledReferenceMonths+'/'+referenceMonths+' měsíců)'
    : '';
  by('readout').textContent=pos+'  ·  Teplota '+valueText(drawn.temp[cell],'°C')
    +estimateNote
    +'  ·  '+mode.name+' '+valueText(drawn.humidity[cell],mode.unit)
    +'  ·  Vítr '+valueText(drawn.wind[cell],'m/s');
}
for(const map of Object.values(maps)) {
  map.element.addEventListener('pointermove', e=>{
    const rect=map.element.getBoundingClientRect();
    hover={x:(e.clientX-rect.left)/rect.width,y:(e.clientY-rect.top)/rect.height};
    updateHover();
  });
  map.element.addEventListener('pointerleave',()=>{
    hover=null;mark(null);by('readout').textContent='Přejeďte přes mapu a porovnejte hodnoty ve stejné buňce.';
  });
}
function labels() {
  range.min=start+width-1;range.max=end;range.value=chosen;
  const text=monthText(chosen-width+1)+' – '+monthText(chosen);
  range.setAttribute('aria-valuetext',text);
  by('first').textContent=Math.floor((start+width-1)/12);
  by('last').textContent=Math.floor(end/12);
  for(const tick of document.querySelectorAll('.ticks [data-year]'))
    tick.style.left=((12*Number(tick.dataset.year)-Number(range.min))/(end-Number(range.min)))*100+'%';
  by('prev').disabled=chosen<=Number(range.min);
  by('next').disabled=chosen>=end;
  return text;
}
function stop() {
  playing=false;clearTimeout(timer);
  play.innerHTML='▶ <span>Přehrát</span>';
  play.setAttribute('aria-label','Přehrát animaci');
}
async function render() {
  clearTimeout(timer);
  const id=++sequence, w=width, r=region, m=chosen, text=labels();
  const moisture = humidityType;
  const offset=m-start-w+1;
  try {
    const [geo,temp,humidity,wind,estimated,referenceEstimates]=await Promise.all([
      geography(r), field('temp',w,offset), field(moisture,w,offset), field('wind',w,offset),
      field('temp-estimated',w,offset), loadBlock('temp-estimated-reference')
    ]);
    if (id!==sequence) return;
    draw(maps.temp,'temp',temp,geo,r);
    draw(maps.humidity,moisture,humidity,geo,r);
    draw(maps.wind,'wind',wind,geo,r);
    if (drawn?.humidityType !== moisture) {
      const mode = humidityModes[moisture];
      by('humidity-unit').textContent = mode.unit;
      maps.humidity.canvas.setAttribute('aria-label', mode.canvasLabel);
      setLegend('humidity-legend', moisture);
    }
    drawn={temp,humidity,wind,geo,estimated,referenceEstimates,humidityType:moisture};
    date.textContent=text;
    by('status').hidden=true;
    updateHover();
    if(playing) {
      if(chosen>=end) {stop();return;}
      if (offset%PERIOD.block>=PERIOD.block-4) {
        const key='-'+w+'-'+(Math.floor(offset/PERIOD.block)+1);
        if (m+PERIOD.block-offset%PERIOD.block<=end) {
          for(const type of ['temp',moisture,'wind','temp-estimated']) loadBlock(type+key).catch(()=>{});
        }
      }
      timer=setTimeout(()=>{chosen++;render();},120);
    }
  } catch(e) {
    if (id!==sequence) return;
    console.error(e);
    stop();
    by('status').textContent='Snímek se nepodařilo načíst. Otevřete index.html v aktuálním prohlížeči a ponechte vedle něj všechny soubory atlasu.';
    by('status').hidden=false;
    if(!drawn) date.textContent='Mapy nejsou načtené';
  }
}
function bind() {
  start=monthIndex(PERIOD.start);end=monthIndex(PERIOD.end);chosen=end;
  const ref=PERIOD.reference.join('–');
  by('coverage').textContent=Math.floor(start/12)+' – '+Math.floor(end/12)+' · SÍŤ 1°';
  by('reference').textContent='Reference '+ref;
  by('ref-method').textContent=ref;
  for(const b of by('regions').querySelectorAll('button')) b.addEventListener('click',()=>{
    region=b.dataset.region;
    for(const x of b.parentElement.children) x.setAttribute('aria-pressed',x===b);
    render();
  });
  for(const b of by('windows').querySelectorAll('button')) b.addEventListener('click',()=>{
    width=Number(b.dataset.window);chosen=Math.max(chosen,start+width-1);
    for(const x of b.parentElement.children) x.setAttribute('aria-pressed',x===b);
    render();
  });
  for (const b of by('humidity-types').querySelectorAll('button')) b.addEventListener('click', () => {
    humidityType = b.dataset.humidity;
    for (const option of b.parentElement.children) option.setAttribute('aria-pressed', option === b);
    render();
  });
  range.addEventListener('input',()=>{stop();chosen=Number(range.value);render();});
  by('prev').addEventListener('click',()=>{stop();chosen=Math.max(chosen-1,Number(range.min));render();});
  by('next').addEventListener('click',()=>{stop();chosen=Math.min(chosen+1,end);render();});
  play.addEventListener('click',()=>{
    if(playing) {stop();return;}
    playing=true;
    play.innerHTML='❚❚ <span>Pauza</span>';play.setAttribute('aria-label','Pozastavit animaci');
    if(chosen===end) chosen=Number(range.min);
    render();
  });
  render();
}
if(typeof PERIOD==='undefined'||typeof GEOMETRY==='undefined'){
  date.textContent='Data se nepodařilo načíst';
  by('status').textContent='Zkontrolujte, že index.html zůstal ve složce se všemi soubory atlasu.';
  by('status').hidden=false;
} else bind();
