/** Split inspected filter regions into native companion functions.
 * Companions execute the original, typed IL through the Wasm emitter; the source
 * method's argument/local storage is shared through explicit by-reference cells.
 */
export function prepareNativeExceptionFilters(methods) {
  const companions=[],nativeFilters=[];
  const mainMethods=methods.map((source,index)=>{
    const filters=source.exceptionPlan?.handlers?.filter(handler=>handler.kind==='filter')??[];
    if(!filters.length)return source;
    const filterExports={};
    for(const handler of filters){
      const exportName=`__filter_${index}_${handler.order}`;
      const blocks=source.blocks.filter(block=>block.offset>=handler.filterOffset&&block.offset<handler.handlerOffset);
      if(!blocks.length)throw Object.assign(new Error('An exception filter has no native basic blocks.'),{code:'WASM_EXCEPTION_REGIONS'});
      // C# filter expressions contain no nested protected regions. Reject unusual
      // hand-authored IL until nested filter-body regions get their own frame plan.
      if(source.exceptionPlan.handlers.some(region=>region!==handler&&region.tryOffset>=handler.filterOffset&&region.tryOffset<handler.handlerOffset))throw Object.assign(new Error('Protected regions inside a filter expression are not supported by the native filter companion.'),{code:'WASM_EXCEPTION_REGIONS'});
      const id=`${source.id??source.key}|filter:${handler.order}`;
      companions.push({...source,id,key:id,isRoot:false,
        method:{...source.method,name:exportName,isStatic:true,parameters:['System.Object','System.Exception'],returnType:'System.Int32',locals:[],exceptionHandlers:[]},
        paramTypes:['externref','externref'],localTypes:[],resultType:'i32',blocks,
        addressTakenArgs:[],addressTakenLocals:[],exceptionPlan:{handlers:[],handlerEntries:[]},
        nativeFilter:{source,handler,exportName}
      });
      nativeFilters.push({exportName,owner:source.id??source.key,handlerOrder:handler.order,filterOffset:handler.filterOffset});
      filterExports[handler.order]=exportName;
    }
    return {...source,blocks:source.blocks.filter(block=>!filters.some(handler=>block.offset>=handler.filterOffset&&block.offset<handler.handlerOffset)),exceptionPlan:{...source.exceptionPlan,filterExports},ownsNativeFilters:true};
  });
  return {mainMethods,companions,methods:[...mainMethods,...companions],nativeFilters};
}
