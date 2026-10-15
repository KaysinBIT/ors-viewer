// Same-machine file selection without browser uploads or manually typed paths.
export class LocalFilePicker {
  constructor(post){
    this.post=post;this.dialog=document.getElementById('local-picker');this.sequence=0;this.last={};
    const $=id=>document.getElementById(id);this.$=$;
    $('picker-cancel').onclick=()=>this.finish(null);
    this.dialog.oncancel=event=>{event.preventDefault();this.finish(null);};
    $('picker-roots').onclick=()=>this.load('');
    $('picker-up').onclick=()=>this.load(this.listing.parent);
    $('picker-confirm').onclick=()=>this.finish(this.kind==='directory'?this.listing?.path:this.selected?.path);
    $('picker-prev').onclick=()=>this.load(this.listing.path,Math.max(0,this.listing.offset-200),true);
    $('picker-next').onclick=()=>this.load(this.listing.path,this.listing.offset+200,true);
    $('picker-search').oninput=()=>{clearTimeout(this.searchTimer);this.searchTimer=setTimeout(()=>this.load(this.listing?.path||'',0,true),180);};
    $('picker-create').onclick=async()=>{
      try{
        const result=await this.post('/api/filesystem/mkdir',{path:this.listing.path,name:$('picker-folder-name').value});
        $('picker-folder-name').value='';await this.load(result.path);
      }catch(error){this.error(error.message);}
    };
  }
  open({kind='file',title='选择本地文件'}={}){
    if(this.resolve)return Promise.reject(new Error('已有文件选择窗口打开'));
    this.kind=kind;this.selected=null;
    this.$('picker-title').textContent=title;this.$('picker-confirm').textContent=kind==='directory'?'选择此目录':'选择文件';
    this.$('picker-new-folder').hidden=kind!=='directory';this.$('picker-folder-name').value='';
    const result=new Promise(resolve=>this.resolve=resolve);this.dialog.showModal();
    this.load(this.last[kind]||'');return result;
  }
  finish(path){
    const resolve=this.resolve;if(!resolve)return;
    if(path)this.last[this.kind]=this.listing.path;
    this.resolve=null;++this.sequence;clearTimeout(this.searchTimer);this.dialog.close();resolve(path||null);
  }
  error(message){this.$('picker-error').textContent=message;this.$('picker-error').hidden=false;}
  async load(path,offset=0,preserveSearch=false){
    const request=++this.sequence,$=this.$;this.selected=null;
    $('picker-error').hidden=true;$('picker-confirm').disabled=true;$('picker-selection').value='';
    $('picker-list').replaceChildren();$('picker-progress').textContent='正在读取文件夹…';
    if(!preserveSearch)$('picker-search').value='';
    try{
      const listing=await this.post('/api/filesystem/list',{path:path||'',kind:this.kind,offset,query:$('picker-search').value});
      if(request!==this.sequence||!this.resolve)return;
      this.listing=listing;$('picker-location').value=listing.path||'本机位置';
      $('picker-search').disabled=!listing.path;
      $('picker-up').disabled=listing.parent===null;$('picker-create').disabled=!listing.path;
      $('picker-confirm').disabled=this.kind!=='directory'||!listing.path;
      $('picker-selection').value=this.kind==='directory'?listing.path:'';
      $('picker-progress').textContent=listing.total?`${listing.offset+1}-${Math.min(listing.offset+listing.entries.length,listing.total)} / ${listing.total} 项`:'没有符合条件的文件或文件夹';
      $('picker-prev').disabled=listing.offset===0;$('picker-next').disabled=listing.offset+listing.entries.length>=listing.total;
      for(const entry of listing.entries){
        const button=document.createElement('button');button.type='button';button.className='picker-item';
        button.setAttribute('aria-label',(entry.kind==='directory'?'文件夹 ':'文件 ')+entry.name);
        const icon=document.createElement('span');icon.className='picker-icon';icon.textContent=entry.kind==='directory'?'▸':'◇';
        const name=document.createElement('span');name.textContent=entry.name;
        const detail=document.createElement('small');detail.textContent=entry.kind==='directory'?'文件夹':entry.size<1024*1024?`${Math.ceil(entry.size/1024)} KB`:`${(entry.size/1024/1024).toFixed(1)} MB`;
        button.append(icon,name,detail);$('picker-list').append(button);
        button.onclick=()=>{
          if(entry.kind==='directory'){this.load(entry.path);return;}
          this.selected=entry;$('picker-selection').value=entry.path;$('picker-confirm').disabled=false;
          for(const item of $('picker-list').children)item.classList.toggle('active',item===button);
        };
        if(entry.kind==='file')button.ondblclick=()=>this.finish(entry.path);
      }
    }catch(error){if(request===this.sequence&&this.resolve){$('picker-progress').textContent='无法读取此位置';this.error(error.message);}}
  }
}
