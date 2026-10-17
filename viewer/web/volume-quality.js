export const MAX_FULL_VOLUME_BYTES=2**31-1;
export function validateFullVolume(shape,maxTextureSize,label='全分辨率'){
  if(!Array.isArray(shape)||shape.length!==3||!shape.every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('体数据维度无效');
  if(!Number.isFinite(maxTextureSize)||maxTextureSize<=0)throw new Error('无法读取显卡的三维纹理尺寸限制');
  if(shape.some(n=>n>maxTextureSize))throw new Error(`${label}体素尺寸 ${shape.slice().reverse().join(' × ')} 超过当前显卡三维纹理单边上限 ${maxTextureSize}。请手动选择其他预览精度；没有自动降采样。`);
  const bytes=shape.reduce((a,b)=>a*b,1);
  if(bytes>MAX_FULL_VOLUME_BYTES)throw new Error(`${label} 8 位纹理超过 2 GiB 的单纹理限制；请手动选择其他预览精度。没有自动降采样。`);
  return bytes;
}

export function customSampleCounts(shape,values){
  const counts=values.map(v=>String(v).trim()).map(v=>v===''?NaN:Number(v));
  if(counts.length!==3||!counts.every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('请输入 X、Y、Z 三个正整数');
  const native=shape.slice().reverse();
  if(counts.some((n,i)=>n>native[i]))throw new Error(`各轴抽样数不能超过原始尺寸 ${native.join(' × ')}`);
  if(counts.reduce((a,b)=>a*b,1)>MAX_FULL_VOLUME_BYTES)throw new Error('预计 8 位纹理超过 2 GiB，请减少抽样数');
  return counts;
}
