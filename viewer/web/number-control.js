// Keep the editable field intact while typing; normalize on blur/Enter.
export function bindRangeNumber(range, number, onChange) {
  range.oninput=()=>{number.value=range.value;onChange();};
  const update=commit=>{
    const value=number.value.trim(),parsed=Number(value);
    if(value!==''&&Number.isFinite(parsed)){
      range.value=Math.max(Number(range.min),Math.min(Number(range.max),parsed));
      onChange();
    }
    if(commit)number.value=range.value;
  };
  number.oninput=()=>update(false);
  number.onchange=()=>update(true);
}
