export const MAX_FULL_VOLUME_BYTES=2**31-1;
export function validateFullVolume(shape,maxTextureSize){
  if(!Array.isArray(shape)||shape.length!==3||!shape.every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('体数据维度无效');
  if(!Number.isFinite(maxTextureSize)||maxTextureSize<=0)throw new Error('无法读取显卡的三维纹理尺寸限制');
  if(shape.some(n=>n>maxTextureSize))throw new Error(`原始体素尺寸 ${shape.slice().reverse().join(' × ')} 超过当前显卡三维纹理单边上限 ${maxTextureSize}。请手动选择其他预览精度；没有自动降采样。`);
  const bytes=shape.reduce((a,b)=>a*b,1);
  if(bytes>MAX_FULL_VOLUME_BYTES)throw new Error('全分辨率 8 位纹理超过 2 GiB 的单纹理限制；请手动选择其他预览精度。没有自动降采样。');
  return bytes;
}
