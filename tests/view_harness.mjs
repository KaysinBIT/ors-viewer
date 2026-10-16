// Observable UI state used by the pre-refactor characterization fixtures.
export function viewHarness(input) {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {hidden:false, checked:false, value:'', attributes:{},
      setAttribute(name,value) { this.attributes[name]=String(value); }});
    return nodes.get(id);
  };
  element('volume-mode').value=input.mode;
  element('show-grid').checked=input.grid;
  element('section-enabled').checked=true;
  const state={object:input.kind?{kind:input.kind}:null, meshMPR:input.meshMPR, faceSection:true,
    preview:input.preview?{meta:{kind:input.kind}}:null};
  const calls=[];
  const scene=input.renderer?{
    camera:{isOrthographicCamera:input.orthographic},
    perspective(){calls.push(['perspective']);this.camera.isOrthographicCamera=false;},
    volumeMode(mode){calls.push(['volumeMode',mode]);},
    showGrid(show){calls.push(['showGrid',show]);},
  }:undefined;
  const mpr={active:input.active,indices:[3,4,5],panes:[{zoom:1.5},{zoom:2},{zoom:.75}],
    setActive(active){calls.push(['setActive',active]);this.active=active;}};
  const updateSection=()=>calls.push(['updateSection']);
  const snapshot=()=>({state,mpr:{active:mpr.active,indices:mpr.indices,zoom:mpr.panes.map(p=>p.zoom)},
    nodes:Object.fromEntries([...nodes].sort().map(([id,n])=>[id,{hidden:n.hidden,checked:n.checked,value:n.value,attributes:n.attributes}])),calls});
  return {state,scene,mpr,element,updateSection,snapshot};
}
