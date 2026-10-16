import { SceneView, parsePacket, labelColor } from './scene.js';
import { SectionController } from './section.js';
import { LocalFilePicker } from './file-picker.js';
import { MPRView } from './mpr.js';
import { ServerSettings } from './server-settings.js';

const $=id=>document.getElementById(id);
const state={datasets:[],dataset:null,object:null,meta:null,preview:null,filter:'all',request:0,tableStart:0,selectedLabel:0};
const kinds={mesh:'三角网格',volume:'体数据',labels:'分割标签'};
const icons={mesh:'◇',volume:'▧',labels:'◈'};
const fmt=n=>Number(n).toLocaleString('zh-CN');
const compact=n=>n>=1e6?(n/1e6).toFixed(2)+' M':n>=1e3?(n/1e3).toFixed(1)+' K':fmt(n);
function number(v){if(v==null)return '—';if(typeof v!=='number')return String(v);if(!Number.isFinite(v))return '—';if(v===0)return '0';if(Math.abs(v)<.001||Math.abs(v)>=1e6)return v.toExponential(3);return Number(v.toPrecision(6)).toLocaleString('en-US');}
function el(tag,text,cls){const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;}
function showError(message){$('scene-error').textContent=message;$('scene-error').hidden=false;}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
let scene,section,rendererError;
try{scene=new SceneView($('viewport'),showError);section=new SectionController(scene,(status,count)=>{
  if(state.object?.kind==='volume')return;
  $('section-note').textContent=status==='exact'?`精确截线 ${fmt(count)} 段；剖切实时更新，不自动封口。`:status==='live'?'实时剖切与截线显示；后台精确截线暂不可用。':'剖切与截线实时显示；正在后台更新精确截线。';
});}catch(error){rendererError='当前浏览器无法启用 WebGL 2 三维显示：'+error.message;showError(rendererError);}
const mpr=new MPRView($('view-layout'),scene,setSlicePosition,extendWindowRange);
async function api(path,options){const response=await fetch(path,options);if(!response.ok){let value;try{value=await response.json();}catch{}throw new Error(value?.error||`请求失败 (${response.status})`);}return response.json();}
function objectUrl(action){return `/api/objects/${state.object.id}/${action}`;}

async function loadCatalog(selectId){
  const result=await api('/api/catalog');state.datasets=result.datasets;
  $('dataset-select').replaceChildren(...state.datasets.map(d=>{const o=el('option',d.name);o.value=d.id;return o;}));
  $('dataset-count').textContent=state.datasets.length;
  $('empty-state').hidden=state.datasets.length>0;
  if(!state.datasets.length){$('app-status').textContent='本地服务已连接 · 尚未添加数据';return;}
  $('dataset-select').value=selectId||state.datasets[0].id;
  switchDataset();
}
function switchDataset(){
  state.dataset=state.datasets.find(d=>d.id===$('dataset-select').value);state.filter='all';$('search').value='';$('show-hidden').checked=false;
  document.querySelectorAll('#type-filters button').forEach(b=>b.classList.toggle('active',b.dataset.kind==='all'));
  const counts={mesh:0,volume:0,labels:0};state.dataset.objects.forEach(o=>counts[o.kind]++);
  $('dataset-caption').textContent=`${state.dataset.objects.length} 个对象 · ${state.dataset.raw_complete?'原始记录已完整提取':'原始记录提取未完成'}`;
  $('app-status').textContent=`已连接 · ${state.dataset.name}`;
  renderList();
  const first=state.dataset.objects.find(o=>!o.hidden)||state.dataset.objects[0];selectObject(first.id);
}
function renderList(){
  const search=$('search').value.toLowerCase(),showHidden=$('show-hidden').checked;
  const objects=state.dataset?.objects.filter(o=>(state.filter==='all'||o.kind===state.filter)&&(!o.hidden||showHidden)&&o.title.toLowerCase().includes(search))||[];
  $('object-list').replaceChildren();
  for(const object of objects){
    const button=el('button',null,'object-item');button.dataset.id=object.id;button.classList.toggle('active',state.object?.id===object.id);button.setAttribute('aria-label',object.title);
    button.append(el('span',icons[object.kind],'object-icon'));
    const copy=el('span',null,'object-copy');copy.append(el('strong',object.title));
    const detail=object.kind==='mesh'?`${compact(object.triangle_count||0)} 三角形`:object.kind==='volume'?object.shape?.slice(1).reverse().join(' × '):`${object.label_count||1} 个标签`;
    copy.append(el('small',`${kinds[object.kind]} · ${detail}`));button.append(copy);
    button.onclick=()=>selectObject(object.id);$('object-list').append(button);
  }
  if(!objects.length)$('object-list').append(el('div','没有匹配的对象','list-empty'));
}
async function selectObject(id){
  const object=state.dataset.objects.find(o=>o.id===id);if(!object)return;
  ++state.request;state.abort?.abort();
  mpr.clear();$('section-controls').hidden=false;$('mpr-toggle').hidden=object.kind!=='volume';$('volume-mode').value='mpr';
  state.object=object;state.selectedLabel=0;state.tableStart=0;state.meta=null;state.preview=null;
  if(scene?.camera.isOrthographicCamera)scene.perspective();
  $('retention').value=100;$('retention-value').textContent='100%';$('section-enabled').checked=false;$('section-distance').value=0;$('section-distance-number').value=0;$('section-fields').hidden=true;
  $('section-mode').value='cut';$('section-flip').checked=false;
  $('section-azimuth').value=0;$('section-elevation').value=0;state.faceSection=false;
  $('retention-field').hidden=object.kind==='volume';$('quality').closest('label').hidden=object.kind==='mesh';
  $('inspector').scrollTop=0;
  $('table-panel').hidden=true;$('stage').classList.remove('has-table');$('scene-error').hidden=true;
  $('object-title').textContent=object.title;$('object-kind').textContent=`${kinds[object.kind].toUpperCase()} / OBJECT ${object.index}`;
  $('object-state').textContent='已解析';renderList();$('opacity').value=100;$('opacity-value').textContent='100%';$('wireframe').checked=false;
  $('scalar-legend').hidden=true;
  $('scalar-select').value='solid';
  $('volume-controls').hidden=object.kind!=='volume';$('label-controls').hidden=object.kind!=='labels';$('wireframe-field').hidden=object.kind==='volume';
  try{const meta=await api(objectUrl('metadata'));if(state.object.id!==id)return;state.meta=meta;renderMetadata();await loadPreview();}
  catch(error){if(state.object.id===id){showError(error.message);$('loading').hidden=true;}}
}
function renderMetadata(){
  const o=state.object,m=state.meta;const stats=[];
  if(o.kind==='mesh')stats.push(['原始顶点',compact(m.vertex_count)],['原始三角形',compact(m.triangle_count)]);
  else if(o.kind==='volume')stats.push(['切片数',fmt(m.grid.shape_tzyx[1])],['时间步',fmt(m.grid.shape_tzyx[0])]);
  else stats.push(['标签数量',fmt(Object.keys(m.label_voxel_counts||{}).length)],['前景体素',compact(m.foreground_voxels||0)]);
  $('object-stats').replaceChildren(...stats.map(([label,value])=>{const box=el('div',null,'stat');box.append(el('strong',value),el('small',label));return box;}));
  const details=[['对象编号',String(o.index)],['数据类型',m.type.replace(/^Cxv/,'')]];
  if(m.grid){details.push(['维度 XYZ',m.grid.size_xyz.join(' × ')],['体素间距',m.grid.spacing_xyz.map(number).join(' / ')]);}
  if(o.kind==='mesh'){details.push(['三角形',fmt(m.triangle_count)],['顶点',fmt(m.vertex_count)]);}
  if(o.kind==='labels')details.push(['区间数',fmt(m.interval_count)],['前景体素',fmt(m.foreground_voxels)]);
  $('metadata-details').replaceChildren(...details.map(([key,value])=>{const div=el('div');div.append(el('dt',key),el('dd',value));return div;}));
  const tables=m.tables||[];$('show-table').hidden=!tables.length;$('measurement-count').textContent=`${tables.length} 张表`;
  $('table-select').replaceChildren(...tables.map(t=>{const option=el('option',({label_measurements:'标签测量',label_internal_fields:'标签属性',vertex_measurements:'顶点测量',face_measurements:'面测量'})[t.group]||t.group);option.value=t.group;return option;}));
  const original=o.kind==='mesh'?m.ply?.file||'vertices.npy':o.kind==='volume'?'volume.npy':m.dense_labels?.file||'label_intervals.npy';
  $('download-original').hidden=false;$('download-original').href=objectUrl('download')+'?file='+encodeURIComponent(original);
  $('download-original').textContent=`下载 ${original} ↗`;
  if(o.kind==='labels')renderLabels();
  if(o.kind==='volume'){
    const nt=m.grid.shape_tzyx[0];$('time-field').hidden=nt<=1;
    $('time-step').replaceChildren(...Array.from({length:nt},(_,i)=>{const option=el('option',`T = ${i}`);option.value=i;return option;}));
  }
}
async function loadPreview(){
  if(!state.object)return;
  if(!scene){showError(rendererError||'WebGL 2 三维显示不可用');$('render-status').textContent='三维渲染不可用';return;}
  const request=++state.request,oid=state.object.id;
  const previousScalar=$('scalar-select').value;
  state.abort?.abort();state.abort=new AbortController();
  $('loading').hidden=false;$('loading-description').textContent=state.object.kind==='mesh'?(Number($('retention').value)===100?'正在载入全部原始网格，大模型需要更多时间和内存':'正在按指定比例简化网格'):'正在生成三维显示数据';
  $('scene-error').hidden=true;$('render-status').textContent='正在载入…';$('app-status').textContent='准备预览 · '+state.object.title;
  $('viewport').dataset.ready='false';
  try{
    const url=objectUrl('preview')+`?quality=${$('quality').value}&time=${$('time-step').value||0}&label=${state.selectedLabel||0}&retention=${$('retention').value}`;
    const response=await fetch(url,{signal:state.abort.signal});if(!response.ok){const v=await response.json();throw new Error(v.error);}
    const packet=parsePacket(await response.arrayBuffer());if(request!==state.request||oid!==state.object.id)return;
    state.preview=packet;scene.load(packet);scene.opacity(Number($('opacity').value)/100);scene.wireframe($('wireframe').checked);scene.showGrid($('show-grid').checked);scene.showBox($('show-box').checked);
    const m=packet.meta;$('preview-note').textContent=m.approximation;
    if(m.kind==='volume'){
      setupVolume(m);$('render-status').textContent=`3D 预览 ${m.sample_shape_zyx.slice().reverse().join(' × ')} · 二维切片为原始分辨率`;
      $('preview-note').textContent='CT 二维切片读取原始分辨率，按实际体素间距显示；窗口映射使用 float32，定位读数来自原始数值。三维快速纹理为采样预览，原始切片到达后同步替换定位平面。';
    }else{$('render-status').textContent=`${m.focus_label?'标签 '+m.focus_label+' · ':''}${m.simplified===false?'原始网格':'当前显示'} ${fmt(m.preview_triangles||0)} 三角形`;}
    const base=m.base_triangles||m.preview_triangles||0,ratio=m.actual_retention??100;
    $('retention-info').textContent=`${m.kind==='mesh'?'原始网格':'当前采样表面'} ${fmt(base)} → ${fmt(m.preview_triangles||0)} 面 · 实际保留 ${ratio.toFixed(2)}%`;
    $('download-preview').hidden=m.kind==='volume';
    updateSection();if(state.faceSection)section.face();
    $('object-kind').textContent=`${kinds[state.object.kind]} / OBJECT ${state.object.index}${m.focus_label?' / LABEL '+m.focus_label:''}`;
    $('scalar-field').hidden=!(m.scalars?.length);
    $('scalar-select').replaceChildren(el('option','单色材质'));
    $('scalar-select').firstChild.value='solid';
    for(const scalar of m.scalars||[]){const option=el('option',scalar.name+(scalar.unit?` (${scalar.unit})`:''));option.value=scalar.key;$('scalar-select').append(option);}
    $('scalar-legend').hidden=true;
    if(m.scalars?.some(s=>s.key===previousScalar)){$('scalar-select').value=previousScalar;selectScalar();}
    if(m.kind==='labels'){
      const missing=m.missing_labels||[];$('label-warning').hidden=!missing.length;
      $('label-warning').textContent=`${missing.length} 个细小标签在概览中不可见。点击标签可局部放大查看；统计仍为完整数据。`;
      if(!m.preview_triangles)showError('当前采样下没有可见表面，请尝试“精细”预览。');
      selectLabel(state.selectedLabel);
    }
    $('app-status').textContent=`就绪 · ${state.dataset.name}`;
    $('viewport').dataset.ready='true';$('viewport').dataset.kind=m.kind;
  }catch(error){if(error.name!=='AbortError'&&request===state.request){showError(error.message);$('render-status').textContent='预览未完成';$('app-status').textContent='载入失败，请检查提示';}}
  finally{if(request===state.request)$('loading').hidden=true;}
}
function setupVolume(meta){
  const previous=mpr.id===state.object.id?mpr.indices:null;
  const [min,max]=meta.range;
  ['window-low','window-high'].forEach((key,i)=>{const input=$(key);input.min=min;input.max=max>min?max:min+1;input.step='any';input.value=meta.window[i];});
  const indices=[];
  ['x','y','z'].forEach((axis,i)=>{const n=meta.original_shape_tzyx[3-i],input=$('slice-'+axis);input.min=0;input.max=n-1;input.step=1;input.value=previous?.[i]??Math.floor((n-1)/2);indices.push(Number(input.value));});
  mpr.source(state.object.id,state.meta,meta.time_step,indices);setSlicePosition(indices);
  updateWindow();updateVolumeMode();scene.iso(Number($('iso').value)/100);
}
function extendWindowRange(range){for(const key of ['window-low','window-high']){const input=$(key);input.min=Math.min(Number(input.min),range[0]);input.max=Math.max(Number(input.max),range[1]);}}
function updateWindow(event){
  let low=Number($('window-low').value),high=Number($('window-high').value);
  const gap=Math.max((Number($('window-high').max)-Number($('window-low').min))*1e-6,1e-10);
  if(low>=high){if(event?.target?.id==='window-low')low=high-gap;else high=low+gap;}
  $('window-low').value=low;$('window-high').value=high;
  $('window-low-value').textContent=number(low);$('window-high-value').textContent=number(high);scene?.setWindow(low,high);mpr.window(low,high);
}
function updateVolumeMode(){
  const mode=$('volume-mode').value,isMPR=mode==='mpr'&&state.object?.kind==='volume';
  $('slice-fields').hidden=!isMPR&&mode!=='slices';$('iso-field').hidden=mode!=='iso';$('mpr-help').hidden=!isMPR;
  $('section-controls').hidden=isMPR;$('mpr-toggle').setAttribute('aria-pressed',String(isMPR));
  if(isMPR){$('section-enabled').checked=false;state.faceSection=false;if(scene?.camera.isOrthographicCamera)scene.perspective();}
  mpr.setActive(isMPR);scene?.volumeMode(isMPR?'slices':mode);scene?.showGrid(!isMPR&&$('show-grid').checked);
  if(state.preview?.meta.kind==='volume')updateSection();
}
function setSlicePosition(indices){
  ['x','y','z'].forEach((axis,i)=>{const input=$('slice-'+axis);input.value=indices[i];const value=Number(input.value);$('slice-'+axis+'-value').textContent=value;scene?.slice(i,value);});
  mpr.position(['x','y','z'].map(axis=>Number($('slice-'+axis).value)));
}
function updateSlice(){setSlicePosition(['x','y','z'].map(axis=>Number($('slice-'+axis).value)));}
function renderLabels(){
  const counts=state.meta.label_voxel_counts||{};$('label-list').replaceChildren();
  for(const [id,count] of Object.entries(counts).sort((a,b)=>Number(a[0])-Number(b[0]))){
    const button=el('button',null,'label-chip');button.dataset.label=id;button.title=`标签 ${id} · ${fmt(count)} 体素`;
    const dot=el('i');dot.style.background='#'+labelColor(Number(id)).getHexString();
    button.append(dot,el('span','标签 '+id),el('small',compact(count)));button.onclick=()=>selectLabel(Number(id));$('label-list').append(button);
  }
}
function selectLabel(id){
  state.selectedLabel=id;scene?.label(id);
  document.querySelectorAll('.label-chip').forEach(b=>b.classList.toggle('active',Number(b.dataset.label)===id));
  if(state.object?.kind==='labels' && state.preview && (state.preview.meta.focus_label||0)!==id)loadPreview();
}
function selectScalar(){
  const key=$('scalar-select').value;scene?.colorScalar(key);const info=state.preview?.meta.scalars?.find(x=>x.key===key);
  $('scalar-legend').hidden=!info;if(info){$('legend-title').textContent=info.name+(info.unit?` / ${info.unit}`:'');$('legend-min').textContent=number(info.min);$('legend-max').textContent=number(info.max);}
}
async function showTable(reset=false){
  if(!state.meta?.tables?.length)return;if(reset)state.tableStart=0;
  $('table-panel').hidden=false;$('stage').classList.add('has-table');
  const id=state.object.id,group=$('table-select').value;
  try{
    const table=await api(objectUrl('table')+`?group=${encodeURIComponent(group)}&start=${state.tableStart}&limit=50`);
    if(state.object.id!==id||$('table-select').value!==group)return;
    state.tableTotal=table.total;state.tableStart=table.start;
    $('table-summary').textContent=fmt(table.total)+' 行 · 原始数据';$('measurement-table').replaceChildren();
    const head=el('thead'),tr=el('tr');tr.append(el('th',table.row_kind==='label_index'?'标签 ID':table.row_kind==='vertex_index'?'顶点 ID':'索引'));
    table.columns.forEach(c=>{const th=el('th',c.name);if(c.unit)th.append(el('small',c.unit));tr.append(th);});head.append(tr);$('measurement-table').append(head);
    const body=el('tbody');table.rows.forEach(row=>{const tr=el('tr');row.forEach(v=>{const td=el('td',number(v));td.title=v==null?'':String(v);tr.append(td);});if(table.row_kind==='label_index')tr.onclick=()=>selectLabel(row[0]);body.append(tr);});$('measurement-table').append(body);
    $('table-page-info').textContent=`${table.start+1}–${Math.min(table.start+table.rows.length,table.total)} / ${fmt(table.total)}`;
    $('table-prev').disabled=table.start===0;$('table-next').disabled=table.start+table.rows.length>=table.total;
    $('download-csv').hidden=!table.csv_file;if(table.csv_file)$('download-csv').href=objectUrl('download')+'?file='+encodeURIComponent(table.csv_file);
  }catch(error){toast(error.message);}
}
function openDialog(){$('add-error').hidden=true;$('add-dialog').showModal();$('browse-path').focus();}

function updateSection(distance,commitNumber=false){
  if(!section||!state.preview)return;
  const enabled=$('section-enabled').checked,azimuth=Number($('section-azimuth').value),elevation=Number($('section-elevation').value);
  $('section-fields').hidden=!enabled;$('azimuth-value').textContent=azimuth+'°';$('elevation-value').textContent=elevation+'°';
  const {half}=section.limits(azimuth,elevation),d=Math.max(-half,Math.min(half,Number(distance??$('section-distance-number').value)||0));
  for(const id of ['section-distance','section-distance-number']){const input=$(id);input.min=-half;input.max=half;if(id!=='section-distance-number'||commitNumber||document.activeElement!==input)input.value=d;}
  section.update({enabled,azimuth,elevation,distance:d,flip:$('section-flip').checked,only:$('section-mode').value==='only',guide:$('section-guide').checked});
  if(state.object.kind==='volume')$('section-note').textContent='灰度剖面随角度和距离实时更新；窗口设置同时生效。';
  $('viewport').dataset.section=enabled?'on':'off';$('viewport').dataset.sectionDistance=String(d);
  if(state.faceSection&&enabled)section.face();
}
function exportPreview(){
  if(!state.preview?.arrays.indices)return;
  const {positions,indices}=state.preview.arrays;
  const header=new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\ncomment ORS Viewer display mesh; clipping not applied\nelement vertex ${positions.length/3}\nproperty float x\nproperty float y\nproperty float z\nelement face ${indices.length/3}\nproperty list uchar uint vertex_indices\nend_header\n`);
  const faces=new Uint8Array(indices.length/3*13),view=new DataView(faces.buffer);
  for(let i=0;i<indices.length/3;i++){view.setUint8(i*13,3);for(let j=0;j<3;j++)view.setUint32(i*13+1+j*4,indices[i*3+j],true);}
  const blob=new Blob([header,positions,faces],{type:'application/octet-stream'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download='ORS_display_'+$('retention').value+'pct.ply';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
  toast('已导出当前显示网格（剖切仅影响显示，未写入导出）');
}
const token=()=>document.querySelector('meta[name=viewer-token]').content;
const post=(path,body)=>api(path,{method:'POST',headers:{'Content-Type':'application/json','X-Viewer-Token':token()},body:JSON.stringify(body)});
const picker=new LocalFilePicker(post);
const serverSettings=new ServerSettings(api,post);
function importMode(){const mode=$('import-mode').value;$('path-field').hidden=mode==='file';$('file-field').hidden=mode!=='file';$('folder-path').value='';$('import-file').required=mode==='file';$('path-label').textContent=mode==='directory'?'解析输出目录':'本地文件路径';$('browse-path').textContent=mode==='directory'?'选择目录':'选择文件';$('folder-path').placeholder=mode==='directory'?'尚未选择解析目录':'尚未选择文件';$('confirm-add').textContent=mode==='directory'?'载入数据':'解析并显示';}
$('browse-path').onclick=async()=>{
  const directory=$('import-mode').value==='directory';
  const path=await picker.open({kind:directory?'directory':'file',title:directory?'选择解析输出目录':'选择本地文件'});
  if(path)$('folder-path').value=path;
};
$('setup-dialog').oncancel=event=>event.preventDefault();
$('setup-browse').onclick=async()=>{
  const path=await picker.open({kind:'directory',title:'选择软件数据目录'});
  if(path){$('setup-path').value=path;$('setup-save').disabled=false;$('setup-error').hidden=true;}
};
$('setup-form').onsubmit=async event=>{
  event.preventDefault();$('setup-save').disabled=true;$('setup-error').hidden=true;
  try{
    const settings=await post('/api/settings/data-directory',{path:$('setup-path').value});
    state.dataDirectory=settings.data_directory;$('setup-dialog').close();await loadCatalog();toast('数据目录已保存，后续启动会自动使用');
  }catch(error){$('setup-error').textContent=error.message;$('setup-error').hidden=false;}
  finally{$('setup-save').disabled=!$('setup-path').value;}
};
function uploadFile(file){return new Promise((resolve,reject)=>{
  const request=new XMLHttpRequest();request.open('POST','/api/import-upload?name='+encodeURIComponent(file.name));request.setRequestHeader('X-Viewer-Token',token());request.setRequestHeader('Content-Type','application/octet-stream');
  request.upload.onprogress=e=>{if(e.lengthComputable)$('import-progress').textContent=`正在传入本机服务：${Math.round(e.loaded/e.total*100)}%`;};
  request.onload=()=>{try{const body=JSON.parse(request.responseText);if(request.status>=400)reject(new Error(body.error));else resolve(body);}catch{reject(new Error('导入响应无效'));}};
  request.onerror=()=>reject(new Error('本机文件传输失败'));request.send(file);
});}
async function watchImport(job){
  localStorage.setItem('ors-import-job',job.id);
  while(true){
    $('import-progress').hidden=false;$('import-progress').textContent=job.message;
    if(job.status==='completed'){
      $('import-progress').textContent=`已导入 ${job.object_count} 个三维对象。${job.warning||''} 输出：${job.output}`;
      localStorage.removeItem('ors-import-job');await loadCatalog(job.dataset_id);toast('文件解析完成，已载入三维结果');return;
    }
    if(job.status==='failed'){localStorage.removeItem('ors-import-job');throw new Error(job.message);}
    await new Promise(resolve=>setTimeout(resolve,1000));job=await api('/api/imports/'+job.id);
  }
}

$('dataset-select').onchange=switchDataset;$('search').oninput=renderList;$('show-hidden').onchange=renderList;
document.querySelectorAll('#type-filters button').forEach(button=>button.onclick=()=>{state.filter=button.dataset.kind;document.querySelectorAll('#type-filters button').forEach(b=>b.classList.toggle('active',b===button));renderList();});
$('quality').onchange=loadPreview;$('time-step').onchange=loadPreview;
$('retention').oninput=()=>{$('retention-value').textContent=$('retention').value+'%';};$('retention').onchange=loadPreview;
$('download-preview').onclick=exportPreview;
$('section-enabled').onchange=()=>{state.faceSection=false;updateSection();};
for(const id of ['section-azimuth','section-elevation'])$(id).oninput=()=>updateSection();
for(const id of ['section-flip','section-guide','section-mode'])$(id).onchange=()=>updateSection();
$('section-distance').oninput=()=>updateSection($('section-distance').value,true);
$('section-distance-number').onchange=()=>updateSection($('section-distance-number').value,true);
$('section-distance-number').oninput=()=>{const value=$('section-distance-number').value;if(value!==''&&Number.isFinite(Number(value)))updateSection(value);};
$('section-center').onclick=()=>updateSection(0);
$('section-face').onclick=()=>{state.faceSection=true;updateSection($('section-distance-number').value,true);section?.face(true);$('auto-rotate').setAttribute('aria-pressed','false');toast('已正对剖面 · 正交投影');};
$('perspective-view').onclick=()=>{state.faceSection=false;scene?.perspective();$('auto-rotate').setAttribute('aria-pressed','false');};
$('viewport').addEventListener('pointerdown',()=>state.faceSection=false);
$('fit-view').onclick=()=>{state.faceSection=false;scene?.fit();};document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{state.faceSection=false;scene?.view(b.dataset.view);});
$('auto-rotate').onclick=()=>{state.faceSection=false;const value=$('auto-rotate').getAttribute('aria-pressed')!=='true';$('auto-rotate').setAttribute('aria-pressed',value);scene?.rotate(value);};
$('screenshot').onclick=()=>{if(!scene)return;if(mpr.active&&!mpr.ready())return toast('当前切片正在读取，请稍后截图');const a=$('save-screenshot');a.href=mpr.screenshot();a.download='ORS_'+(mpr.active?'CT':'3D')+'_'+new Date().toISOString().replace(/[:.]/g,'-')+'.png';$('screenshot-image').src=a.href;$('screenshot-dialog').showModal();};
$('close-screenshot').onclick=()=>{$('screenshot-dialog').close();$('screenshot-image').removeAttribute('src');$('save-screenshot').removeAttribute('href');};
$('mpr-toggle').onclick=()=>{$('volume-mode').value=mpr.active?'mip':'mpr';updateVolumeMode();};
$('opacity').oninput=()=>{$('opacity-value').textContent=$('opacity').value+'%';scene?.opacity(Number($('opacity').value)/100);};
$('wireframe').onchange=()=>scene?.wireframe($('wireframe').checked);$('show-grid').onchange=()=>scene?.showGrid($('show-grid').checked);$('show-box').onchange=()=>scene?.showBox($('show-box').checked);
$('scalar-select').onchange=selectScalar;$('volume-mode').onchange=updateVolumeMode;
$('window-low').oninput=updateWindow;$('window-high').oninput=updateWindow;
$('iso').oninput=()=>{$('iso-value').textContent=$('iso').value+'%';scene?.iso(Number($('iso').value)/100);};
['x','y','z'].forEach((axis,i)=>$('slice-'+axis).oninput=()=>updateSlice(axis,i));$('all-labels').onclick=()=>selectLabel(0);
$('show-table').onclick=()=>showTable(true);$('table-select').onchange=()=>showTable(true);
$('close-table').onclick=()=>{$('table-panel').hidden=true;$('stage').classList.remove('has-table');};
$('table-prev').onclick=()=>{state.tableStart=Math.max(0,state.tableStart-50);showTable();};$('table-next').onclick=()=>{state.tableStart+=50;showTable();};
$('add-dataset').onclick=openDialog;$('empty-add').onclick=openDialog;$('close-dialog').onclick=()=>$('add-dialog').close();
$('toggle-inspector').onclick=()=>document.body.classList.toggle('inspector-open');
$('close-inspector').onclick=()=>document.body.classList.remove('inspector-open');
$('import-mode').onchange=importMode;
$('add-form').onsubmit=async event=>{
  event.preventDefault();$('confirm-add').disabled=true;$('add-error').hidden=true;$('import-progress').hidden=false;$('import-progress').textContent='正在提交导入任务…';
  try{
    const mode=$('import-mode').value;
    if(mode!=='file'&&!$('folder-path').value.trim())throw new Error(mode==='directory'?'请先点击“选择目录”':'请先点击“选择文件”');
    if(mode==='directory'){const dataset=await api('/api/datasets',{method:'POST',headers:{'Content-Type':'application/json','X-Viewer-Token':token()},body:JSON.stringify({path:$('folder-path').value.trim()})});$('add-dialog').close();await loadCatalog(dataset.id);}
    else{const job=mode==='file'?await uploadFile($('import-file').files[0]):await api('/api/imports',{method:'POST',headers:{'Content-Type':'application/json','X-Viewer-Token':token()},body:JSON.stringify({path:$('folder-path').value.trim().replace(/^"|"$/g,'')})});await watchImport(job);$('add-dialog').close();}
  }catch(error){$('add-error').textContent=error.message;$('add-error').hidden=false;$('import-progress').hidden=true;}
  finally{$('confirm-add').disabled=false;}
};
window.addEventListener('keydown',event=>{if(event.key==='Escape')document.body.classList.remove('inspector-open');if(event.key.toLowerCase()==='f'&&!document.querySelector('dialog[open]')&&!['INPUT','SELECT','TEXTAREA'].includes(event.target.tagName)){state.faceSection=false;scene?.fit();}});
async function initialize(){
  const settings=await api('/api/settings');state.dataDirectory=settings.data_directory;
  serverSettings.observe(settings);
  if(!settings.ready){
    $('app-status').textContent='首次使用 · 请选择数据目录';$('setup-message').textContent=settings.message||'解析结果、显示缓存和日志将保存在你选择的目录中。';
    $('setup-dialog').showModal();if(location.hash==='#settings'||settings.port_warning)await serverSettings.open();return;
  }
  await loadCatalog();
  if(location.hash==='#settings'||settings.port_warning)await serverSettings.open();
  const pendingJob=localStorage.getItem('ors-import-job');if(pendingJob){$('confirm-add').disabled=true;api('/api/imports/'+pendingJob).then(watchImport).catch(error=>{localStorage.removeItem('ors-import-job');toast(error.message);}).finally(()=>$('confirm-add').disabled=false);}
}
initialize().catch(error=>{showError(error.message);$('app-status').textContent='无法连接本地数据服务';});
