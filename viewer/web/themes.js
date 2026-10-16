// Shared rendering palettes; scalar and label colors retain their data meaning.
export const THEMES={
  mono:{name:'黑白',canvas:'#090a0b',header:'#202224',text:'#e4e4e4',mesh:'#d3d3d3',grid:'#555555',halo:'#000000',axes:['#eeeeee','#bdbdbd','#919191'],dashes:[[],[7,3],[2,3]]},
  light:{name:'浅色',canvas:'#f4f5f6',header:'#e1e4e7',text:'#23282c',mesh:'#777c82',grid:'#b0b5bb',halo:'#ffffff',axes:['#20252b','#535c65','#818b95'],dashes:[[],[7,3],[2,3]]},
  ocean:{name:'深蓝',canvas:'#0c1c2b',header:'#142e44',text:'#dbeaf5',mesh:'#96c5d9',grid:'#34576f',halo:'#000000',axes:['#ff6868','#65e08d','#6aa9ff'],dashes:[[],[],[]]},
};
export function themeFor(key){return THEMES[key]||THEMES.mono;}
