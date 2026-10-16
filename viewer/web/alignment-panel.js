import {IDENTITY,poseMatrix,transformPoint,anglesFromRotation,rotationFromAngles,faceRotation,pointsRotation,dot} from './alignment-math.js';

export class AlignmentPanel {
  constructor({host,scene,mpr,post,onChange,onPickMode,notify}){
    Object.assign(this,{scene,mpr,post,onChange,onPickMode,notify});this.points=[];this.mode=null;this.generation=0;
    this.panel=document.createElement('section');this.panel.className='inspector-section alignment-panel';this.panel.hidden=true;
    this.panel.innerHTML=`<div class="control-heading">整个数据集 · 初始姿态</div>
      <p class="note">旋转数据，三切面 XYZ 轴固定。网格、CT、分割共用数据集中心，保持相对位置。</p>
      <div class="alignment-angles"></div>
      <label class="field"><span>参考面旋转到</span><select aria-label="自动对齐目标平面"><option value="2">XY 平面（Z 切面）</option><option value="1">XZ 平面（Y 切面）</option><option value="0">YZ 平面（X 切面）</option></select></label>
      <div class="alignment-buttons"><button data-action="face">选择参考面</button><button data-action="points">选择三个点</button><button data-action="cancel" hidden>取消选取</button></div>
      <p class="alignment-status note" role="status"></p>
      <div class="alignment-buttons"><button data-action="save">保存对齐</button><button data-action="reset">恢复原始姿态</button></div>
      <p class="note">CT 三点请在二维切面点选；网格／分割可在三维表面点选。三个点不可共线；点 1→2 决定面内方向。对齐后参考面位置同步到对应切面。原始文件及 PLY 导出坐标不变。</p>`;
    host.prepend(this.panel);this.status=this.panel.querySelector('.alignment-status');this.target=this.panel.querySelector('select');
    this.controls=[0,1,2].map(axis=>{
      const row=document.createElement('div');row.className='alignment-angle';
      row.innerHTML=`<label class="range-field"><span>${'XYZ'[axis]} 角度</span><input type="range" min="-180" max="180" step="0.1" value="0" aria-label="数据集 ${'XYZ'[axis]} 旋转角度"></label><div class="alignment-buttons"><button title="绕 ${'XYZ'[axis]} 减少 90 度">−90°</button><input type="number" min="-180" max="180" step="any" value="0" aria-label="数据集 ${'XYZ'[axis]} 精确角度"><button title="绕 ${'XYZ'[axis]} 增加 90 度">+90°</button></div>`;
      this.panel.querySelector('.alignment-angles').append(row);const [slider,number]=row.querySelectorAll('input'),[minus,plus]=row.querySelectorAll('button');
      const update=value=>{if(value===''||!Number.isFinite(Number(value)))return;this.angles[axis]=Math.max(-180,Math.min(180,Number(value)));this.cancel();this.change({...this.pose,enabled:true,rotation:rotationFromAngles(this.angles)},null,this.angles.slice());};
      slider.oninput=()=>update(slider.value);number.onchange=()=>update(number.value);
      minus.onclick=()=>update(((this.angles[axis]-90+540)%360)-180);plus.onclick=()=>update(((this.angles[axis]+90+540)%360)-180);
      return {slider,number};
    });
    const action=name=>this.panel.querySelector(`[data-action=${name}]`);
    action('reset').onclick=()=>{this.cancel();this.change({enabled:false,rotation:IDENTITY.map(r=>r.slice()),pivot:this.defaultPivot.slice()});};
    action('save').onclick=async()=>{
      const id=this.id,pose=structuredClone(this.pose),generation=this.generation;action('save').disabled=true;
      try{await this.post(`/api/datasets/${id}/alignment`,{pose});if(this.id===id&&generation===this.generation)this.status.textContent='对齐已保存；再次打开此数据集自动恢复。';}
      catch(error){this.notify(error.message);}finally{action('save').disabled=false;}
    };
    action('cancel').onclick=()=>this.cancel();
    for(const mode of ['face','points'])action(mode).onclick=()=>this.start(mode);
    this.mpr.pickPoint=point=>this.pick({point});
    this.scene?.canvas.addEventListener('pointerdown',event=>{this.down=[event.clientX,event.clientY];});
    this.scene?.canvas.addEventListener('pointerup',event=>{
      if(!this.ready||!this.mode||event.button!==0||!this.down||Math.hypot(event.clientX-this.down[0],event.clientY-this.down[1])>4)return;
      const hit=this.scene.pickSource(event);if(hit)this.pick(hit);else this.status.textContent='未命中可见网格表面。CT 请在二维三切面中选点。';
    });
    window.addEventListener('keydown',event=>{if(event.key==='Escape'&&this.mode)this.cancel();});
  }
  load(id,result){this.cancel();this.id=id;this.defaultPivot=result.default_pivot;this.pose=result.pose;this.generation++;this.panel.hidden=false;this.sync();this.status.textContent=result.warning||(this.pose.enabled?'已恢复此数据集保存的对齐。':'原始姿态。手动旋转顺序：固定 X → Y → Z。');}
  sync(angles=null){this.angles=angles||anglesFromRotation(this.pose.enabled?this.pose.rotation:IDENTITY);this.controls.forEach((c,i)=>{c.slider.value=this.angles[i];c.number.value=Number(this.angles[i].toFixed(6));});}
  cancel(){this.mode=null;this.points=[];this.mpr.picking=false;this.panel.querySelector('[data-action=cancel]').hidden=true;if(this.scene)this.scene.canvas.style.cursor='';}
  start(mode){
    if(!this.pose)return;
    if(!this.ready){this.status.textContent='请等待当前对象载入完成后选择参考点或参考面。';return;}
    if(mode==='face'&&!this.scene?.mesh){this.status.textContent='CT 没有可选三角表面，请使用“选择三个点”并在二维切面点选。';return;}
    this.cancel();this.mode=mode;this.mpr.picking=mode==='points';this.panel.querySelector('[data-action=cancel]').hidden=false;
    if(this.scene)this.scene.canvas.style.cursor='crosshair';this.onPickMode(mode);
    this.status.textContent=mode==='face'?'点击三维模型上的参考三角面；使用当前显示网格。':'请点选第 1 / 3 个参考点（CT 使用二维切面）。';
  }
  async pick(hit){
    if(!this.mode||!this.pose)return;const axis=Number(this.target.value);let rotation,point;
    try{
      if(this.mode==='face'){
        if(!hit.normal)return;const current=this.pose.enabled?this.pose.rotation:IDENTITY,normal=current.map(row=>dot(row,hit.normal)),delta=faceRotation(normal,axis);
        rotation=delta.map(row=>[0,1,2].map(c=>dot(row,current.map(r=>r[c]))));point=hit.point;
      }else{
        this.points.push(hit.point);if(this.points.length<3){this.status.textContent=`已选 ${this.points.length} / 3 点：${hit.point.map(x=>Number(x.toPrecision(7))).join(', ')}。请继续选点。`;return;}
        rotation=pointsRotation(this.points,axis);point=this.points[0];
      }
      this.cancel();const pose={...this.pose,enabled:true,rotation},coordinate=transformPoint(poseMatrix(pose),point)[axis];
      await this.change(pose,{axis,coordinate});
    }catch(error){this.cancel();this.status.textContent=error.message;}
  }
  async change(pose,snap=null,angles=null){
    this.pose=pose;this.generation++;this.sync(angles);this.status.textContent='对齐未保存。点击“保存对齐”可供下次恢复。';
    try{await this.onChange(pose,snap);}catch(error){this.status.textContent='对齐切面更新失败：'+error.message;}
  }
}
