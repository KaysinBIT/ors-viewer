export function clampZoom(value){return Math.max(.25,Math.min(8,Number.isFinite(Number(value))?Number(value):1));}
export function zoomImageTransform(t,zoom,width,height,focus=[t.cols/2,t.rows/2]){
  const z=clampZoom(zoom),a=t.a*z,c=t.c*z,d=t.d*z;
  return {...t,a,c,d,e:width/2-a*focus[0]-c*focus[1],f:height/2-d*focus[1]};
}
export function zoomMeshTransform(t,zoom,width,height,focus=[t.loU+t.width/(2*t.scale),t.hiV-t.height/(2*t.scale)]){
  const z=clampZoom(zoom),scale=t.scale*z;
  return {...t,scale,width:t.width*z,height:t.height*z,left:width/2-(focus[0]-t.loU)*scale,top:height/2-(t.hiV-focus[1])*scale};
}
export function panImageFocus(t,focus,dx,dy){const row=dy/t.d;return [focus[0]-(dx-t.c*row)/t.a,focus[1]-row];}
export function panMeshFocus(t,focus,dx,dy){return [focus[0]-dx/t.scale,focus[1]+dy/t.scale];}
