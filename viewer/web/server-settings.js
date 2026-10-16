const $=id=>document.getElementById(id);

export class ServerSettings {
  constructor(api,post) {
    this.api=api;this.post=post;
    document.querySelectorAll('[data-open-port]').forEach(button=>button.onclick=()=>this.open());
    $('port-close').onclick=()=>$('port-dialog').close();
    $('port-mode').onchange=()=>this.mode();
    $('port-form').onsubmit=async event=>{
      event.preventDefault();$('port-save').disabled=true;$('port-error').hidden=true;$('port-result').hidden=true;
      try {
        const port=$('port-mode').value==='auto'?0:Number($('port-number').value);
        const settings=await this.post('/api/settings/port',{port});this.observe(settings);
        $('port-result').textContent=`已保存：${port===0?'自动分配可用端口':'端口 '+port}。下次重新启动软件时生效；当前页面和解析任务继续运行。`;
        $('port-result').hidden=false;
      }catch(error){$('port-error').textContent=error.message;$('port-error').hidden=false;}
      finally{$('port-save').disabled=false;}
    };
    window.addEventListener('hashchange',()=>{if(location.hash==='#settings')this.open();});
  }
  observe(settings) {
    this.settings=settings;
    $('port-current').textContent=`http://127.0.0.1:${settings.port}/`;
    $('port-current').title='本次实际监听地址';
    $('port-origin').textContent=settings.port_source==='command-line'?'本次使用命令行 --port 指定的端口。':'仅监听本机 127.0.0.1。';
    $('port-warning').textContent=settings.port_warning||'';$('port-warning').hidden=!settings.port_warning;
    $('open-port-settings').title=`当前端口 ${settings.port}；已保存 ${settings.saved_port||'自动分配'}`;
    $('open-port-settings').classList.toggle('port-attention',Boolean(settings.port_warning));
  }
  mode() {
    const custom=$('port-mode').value==='custom';$('port-number-field').hidden=!custom;$('port-number').disabled=!custom;
  }
  async open() {
    $('port-error').hidden=true;$('port-result').hidden=true;
    try {
      const settings=await this.api('/api/settings');this.observe(settings);
      $('port-mode').value=settings.saved_port?'custom':'auto';$('port-number').value=settings.saved_port||8769;this.mode();
      if(!$('port-dialog').open)$('port-dialog').showModal();
    }catch(error){$('port-error').textContent=error.message;$('port-error').hidden=false;if(!$('port-dialog').open)$('port-dialog').showModal();}
  }
}
