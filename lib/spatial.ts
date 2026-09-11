// Local demonstration model. Coordinates are image pixels; scale is an explicit demo assumption.
export type Point = {x:number;y:number};
// 底图真实像素尺寸。用于把固定 3:2 基准换成按影像比例派生的基准。
export type ImageSize = {w:number;h:number};
export type Node = Point & {id:string;name:string};
// 候选/确认：status 只表达几何来源（AI 影像候选 / 用户确认），正式判定仍以 confirmed 为准。
export type RoadStatus = 'candidate' | 'confirmed';
export type Road = {id:string;a:string;b:string;width:number|null;source:string;access:string;confirmed:boolean;steps:boolean|null;lit:boolean|null;status?:RoadStatus;length_m?:number|null;widthSource?:string;candidateId?:string;width_n?:number|null};
export type Building = Point & {id:string;name:string;w:number;h:number;kind:string;elderly:number;status?:RoadStatus;hidden?:boolean;height?:number|null;candidateId?:string};
// 保存一次 AI 视觉识别的原始结果，与用户确认结果分开存放，保证可追溯。
export type BlueprintRecord = {result:unknown;model:string;time:string;materialId?:string};
export type Hazard = Point & {id:string;road:string;kind:string;environment:string;status:string;note:string;photo?:string;source:string};
export type Facility = Point & {name:string;size:'小'|'中'|'大';angle:number};
export type LayoutItem = Point & {id:string;kind:string};
export type Config = {role:string;vision:string;familiarity:string;carrying:string;environment:string;start:string;end:string;habit:string[]};
export type Snapshot = {imageSize?:ImageSize;id:string;name:string;time:string;actor:string;reason:string;nodes:Node[];roads:Road[];buildings:Building[];hazards:Hazard[];facility:Facility|null;config:Config;image:string;scale:number;resources?:{id:string;node_id:string;kind:'seat'|'meal';capacity:number|null;opens:number|null;closes:number|null;duration:number|null;source:string}[];calibration?:{status:'unknown'|'demo'|'manual'|'verified';source:string;unit:'m';scaleY?:number};layout:LayoutItem[];goal:string;budget:string;preserve:string;version:number;blueprint?:BlueprintRecord};
export type Spatial = Omit<Snapshot,'id'|'name'|'time'|'actor'|'reason'> & {mode:'empty'|'demo'|'upload';locationConfirmed:boolean;address:string;crs:string;history:Snapshot[];audit:{time:string;actor:string;action:string;before:string;after:string}[]};
export type RouteResult = {nodes:string[];roads:string[];length:number|null;cost:number;events:{road:string;kind:string;category:string;severity:string;source:string;advice:string}[];unknown:number;reachable:boolean};
export const RULE_VERSION='demo-rules-1.0';
export const buildingKinds=['未分类','普通住宅','典型老人住宅','老人住宅聚集区','公厕','食堂／助餐点','活动中心','卫生室','村委会','其他'];
export const hazardKinds=['积水','楼梯','坑洼','青苔／湿滑','人车混行','夜间无照明','道路过窄','缺少休息点','开放排水沟','其他'];
export const defaultConfig:Config={role:'拄杖',vision:'一般视力',familiarity:'熟悉',carrying:'无',environment:'日常',start:'n1',end:'n8',habit:['n1','n2','n4','n5','n8']};
export function emptySpatial(address=''):Spatial{return {mode:'empty',image:'',scale:1,calibration:{status:'unknown',source:'尚未标定',unit:'m'},crs:'演示局部平面坐标',address,locationConfirmed:false,nodes:[],roads:[],buildings:[],hazards:[],facility:null,config:{...defaultConfig},history:[],audit:[],version:0,layout:[],goal:'增设遮阳、休息和照明，让老人可以安心停留。',budget:'低',preserve:'保留树木、建筑、道路与原有出入口'};}
export function demoSpatial(address='青溪村（虚构演示场景）'):Spatial{
 const nodes:Node[]=[{id:'n1',x:159,y:195,name:'西侧老人聚集区'},{id:'n2',x:415,y:195,name:'广场西入口'},{id:'n3',x:545,y:188,name:'村委会'},{id:'n4',x:417,y:356,name:'广场南入口'},{id:'n5',x:545,y:354,name:'活动中心'},{id:'n6',x:155,y:497,name:'南侧老人住宅'},{id:'n7',x:415,y:500,name:'公厕'},{id:'n8',x:545,y:496,name:'助餐点'},{id:'n9',x:845,y:524,name:'东侧住宅'},{id:'n10',x:812,y:197,name:'卫生室'}];
 const pairs=[['n1','n2'],['n2','n3'],['n3','n10'],['n1','n6'],['n2','n4'],['n4','n5'],['n4','n7'],['n3','n5'],['n5','n8'],['n6','n7'],['n7','n8'],['n8','n9'],['n10','n9']];
 const roads:Road[]=pairs.map(([a,b],i)=>({id:`R-${String(i+1).padStart(2,'0')}`,a,b,width:i===4?1.1:i===5?null:3.5,source:i===5?'未知':'演示估计',access:'公开通行',confirmed:false,steps:i===4,lit:i!==3}));
 const buildings:Building[]=[{id:'B-01',name:'西侧住宅组',x:236,y:281,w:49,h:49,kind:'老人住宅聚集区',elderly:28},{id:'B-02',name:'南侧老人住宅',x:192,y:458,w:47,h:33,kind:'典型老人住宅',elderly:6},{id:'B-03',name:'村委会',x:532,y:123,w:75,h:73,kind:'村委会',elderly:0},{id:'B-04',name:'活动中心',x:583,y:294,w:55,h:82,kind:'活动中心',elderly:0},{id:'B-05',name:'卫生室',x:753,y:240,w:65,h:42,kind:'卫生室',elderly:0},{id:'B-06',name:'助餐点',x:488,y:550,w:69,h:42,kind:'食堂／助餐点',elderly:0},{id:'B-07',name:'公厕',x:388,y:435,w:41,h:27,kind:'公厕',elderly:0},{id:'B-08',name:'东侧住宅',x:772,y:468,w:66,h:45,kind:'典型老人住宅',elderly:12}];
 return {...emptySpatial(address),mode:'demo',scale:.5,calibration:{status:'demo',source:'合成示例假设',unit:'m'},image:'/demo-orthophoto.png',nodes,roads,buildings,hazards:[{id:'SP-01',x:416,y:283,road:'R-05',kind:'楼梯',environment:'日常',status:'已确认',note:'示例：巷道内存在台阶，需现场确认高度。',source:'演示人工录入'},{id:'SP-02',x:320,y:195,road:'R-01',kind:'积水',environment:'雨后',status:'已确认',note:'示例：雨后有效通行区缩窄。',source:'演示人工录入'},{id:'SP-03',x:157,y:363,road:'R-04',kind:'夜间无照明',environment:'夜间',status:'待核实',note:'示例候选观察，尚未确认。',source:'演示候选观察'}],layout:[{id:'l1',x:34,y:38,kind:'扶手长椅'},{id:'l2',x:64,y:34,kind:'遮阳棚'},{id:'l3',x:72,y:68,kind:'照明'}]};
}
export function hasMetricScale(s:Pick<Spatial,'scale'|'calibration'>){return !!s.calibration&&s.calibration.status!=='unknown'&&s.scale>0&&Number.isFinite(s.scale);}
export function metricDistance(s:Spatial,a:Point,b:Point){return Math.hypot((a.x-b.x)*s.scale,(a.y-b.y)*(s.calibration?.scaleY??s.scale));}
export const IMAGE_WIDTH=1000,DEFAULT_IMAGE_HEIGHT=667;
// 运行时基准：宽度恒为 1000（横向语义、既有 x 数据与宽度标定全部不变），
// 高度由底图真实像素比例派生；缺省回落 667（3:2），演示与旧项目行为不变。
export function basisHeight(size?:ImageSize){if(!size||!(size.w>0)||!(size.h>0))return DEFAULT_IMAGE_HEIGHT;return Math.max(1,Math.round(IMAGE_WIDTH*size.h/size.w));}
export function imageBasis(s:Pick<Spatial,'imageSize'>){return {w:IMAGE_WIDTH,h:basisHeight(s.imageSize)};}
// 一次性把旧基准（667 高）的纵向几何重标定到真实高度。
// 已记录 imageSize 时原样返回（幂等）；layout 为预览框百分比，不属于影像单位，不参与换算。
export function migrateImageBasis(s:Spatial,size:ImageSize):Spatial{
 if(s.imageSize||!(size.w>0)||!(size.h>0))return s;
 const f=basisHeight(size)/DEFAULT_IMAGE_HEIGHT,fix=(v:number)=>f===1?v:Math.round(v*f*1000)/1000;
 return {...s,imageSize:{w:size.w,h:size.h},nodes:s.nodes.map(n=>({...n,y:fix(n.y)})),buildings:s.buildings.map(b=>({...b,y:fix(b.y),h:fix(b.h)})),hazards:s.hazards.map(h=>({...h,y:fix(h.y)})),facility:s.facility?{...s.facility,y:fix(s.facility.y)}:null};
}
// 尺度（米/图像单位）推导：优先使用研究范围占地面积，其次使用图像宽度对应实际距离。
export function scaleFromArea(areaM2:number,imageSize?:ImageSize){return areaM2>0?Math.sqrt(areaM2/(IMAGE_WIDTH*basisHeight(imageSize))):null;}
export function scaleFromWidth(widthM:number){return widthM>0?widthM/IMAGE_WIDTH:null;}
// 道路长度：用户实测值优先；否则用节点平面距离 × 尺度派生，尺度未知时返回 null。
export function roadLengthMeters(s:Spatial,r:Pick<Road,'a'|'b'|'length_m'>){
 if(typeof r.length_m==='number'&&r.length_m>0)return r.length_m;
 if(!hasMetricScale(s))return null;
 const a=s.nodes.find(n=>n.id===r.a),b=s.nodes.find(n=>n.id===r.b);
 if(!a||!b)return null;
 return metricDistance(s,a,b);
}
export function formatMeters(value:number|null){return value===null?'未知':value<10?`${value.toFixed(1)} m`:`${Math.round(value)} m`;}
// 与既有 confirmed 布尔字段保持同步：status 只表达来源，confirmed 仍是正式判定。
export function syncRoadStatus(r:Road,confirmed:boolean):Road{return {...r,confirmed,status:confirmed?'confirmed':'candidate'};}
export function normalizeSpatial(s:Spatial):Spatial {if(s.calibration)return s;return {...s,calibration:{status:s.mode==='demo'?'demo':'unknown',source:'V1 导入；真实资料待重新核查',unit:'m'},roads:s.roads.map(r=>s.mode==='demo'?r:{...r,steps:null,lit:null,access:'未知',confirmed:false,status:'candidate'})};}
export function distance(a:Point,b:Point){return Math.hypot(a.x-b.x,a.y-b.y);}
export function projectSegment(p:Point,a:Point,b:Point){const t=Math.max(0,Math.min(1,((p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y))/((b.x-a.x)**2+(b.y-a.y)**2||1)));return {x:a.x+t*(b.x-a.x),y:a.y+t*(b.y-a.y),t};}
export function nearestNode(s:Pick<Spatial,'nodes'>,p:Point){return [...s.nodes].sort((a,b)=>distance(a,p)-distance(b,p))[0];}
export function roadEvents(s:Spatial,r:Road,c:Config){
 const events:RouteResult['events']=[];
 for(const [unknown,label] of [[r.steps===null,'台阶情况未知'],[r.lit===null&&c.environment==='夜间','照明情况未知'],[r.access==='未知','通行属性未知']] as const)if(unknown)events.push({road:r.id,kind:label,category:'数据缺口',severity:'待判断',source:r.source,advice:'安排现场核查，当前仅为拓扑候选。'});
 if(r.width===null)events.push({road:r.id,kind:'有效宽度未知',category:'数据缺口',severity:'待判断',source:r.source,advice:'现场测量最窄有效通行宽度。'});
 else if(r.width<(c.role==='使用助行器'?1.5:1.2))events.push({road:r.id,kind:'通行空间较窄',category:'稳定问题',severity:'高',source:r.source,advice:'核实有效宽度并清理占道，评估避让位置。'});
 if(r.steps)events.push({road:r.id,kind:'存在台阶',category:c.role==='独立步行'?'条件性问题':'稳定问题',severity:'高',source:'用户道路属性',advice:'补测台阶与入口条件，比较无台阶绕行路线。'});
 if(c.environment==='夜间'&&r.lit===false)events.push({road:r.id,kind:'夜间照明不足',category:'条件性问题',severity:c.vision==='低视力'?'高':'中',source:'用户道路属性',advice:'夜间实走核查照明连续性。'});
 s.hazards.filter(h=>h.road===r.id&&!['已否定','已解决'].includes(h.status)&&(h.environment==='日常'||h.environment===c.environment)).forEach(h=>events.push({road:r.id,kind:h.kind,category:h.status==='待核实'?'数据缺口':h.environment==='日常'?'稳定问题':'条件性问题',severity:h.status==='待核实'?'待判断':['楼梯','开放排水沟'].includes(h.kind)?'高':'中',source:`${h.id} · ${h.source}`,advice:h.status==='待核实'?'补充现场证据并确认，当前不作为风险事实。':h.kind==='积水'?'排查排水与雨后有效宽度，比较替代路线。':'结合现场证据安排修补、照明、休息或绕行措施。'}));
 return events;
}
function usable(s:Spatial,r:Road,c:Config){return !['不可通行','私人使用'].includes(r.access)&&!(r.access==='季节性通行'&&c.environment==='雨后')&&!(c.role==='使用助行器'&&(r.steps||s.hazards.some(h=>h.road===r.id&&h.kind==='楼梯'&&h.status==='已确认')));}
function roadCost(s:Spatial,r:Road,c:Config,lowRisk:boolean){const a=s.nodes.find(n=>n.id===r.a)!,b=s.nodes.find(n=>n.id===r.b)!;const len=hasMetricScale(s)?metricDistance(s,a,b):distance(a,b);const events=roadEvents(s,r,c);return len+(lowRisk?events.reduce((v,e)=>v+(e.category==='数据缺口'?35:e.severity==='高'?180:90),0)*(c.role==='耐力较弱'?1.2:1)*(c.carrying==='无'?1:1.15)+(c.familiarity==='不熟悉'?12:0):0);}
export function calculateRoute(s:Spatial,c:Config,preference:'shortest'|'safe'|'habit'):RouteResult{
 const failed:RouteResult={nodes:[],roads:[],length:null,cost:0,events:[],unknown:0,reachable:false};
 if(!s.nodes.some(n=>n.id===c.start)||!s.nodes.some(n=>n.id===c.end))return failed;
 let routeNodes:string[]=[],routeRoads:string[]=[];
 if(preference==='habit'){
  routeNodes=c.habit;
  if(routeNodes[0]!==c.start||routeNodes.at(-1)!==c.end)return failed;
  for(let i=1;i<routeNodes.length;i++){const r=s.roads.find(r=>((r.a===routeNodes[i-1]&&r.b===routeNodes[i])||(r.b===routeNodes[i-1]&&r.a===routeNodes[i]))&&usable(s,r,c));if(!r)return failed;routeRoads.push(r.id);}
 }else{
  const distances=new Map(s.nodes.map(n=>[n.id,Infinity]));distances.set(c.start,0);const prev=new Map<string,{node:string;road:string}>();const open=new Set(s.nodes.map(n=>n.id));
  while(open.size){const current=[...open].sort((a,b)=>distances.get(a)!-distances.get(b)!)[0];if(distances.get(current)===Infinity)break;open.delete(current);if(current===c.end)break;
   for(const r of s.roads){if(r.a!==current&&r.b!==current||!usable(s,r,c))continue;const next=r.a===current?r.b:r.a;if(!open.has(next))continue;const cost=distances.get(current)!+roadCost(s,r,c,preference==='safe');if(cost<distances.get(next)!){distances.set(next,cost);prev.set(next,{node:current,road:r.id});}}
  }
  if(distances.get(c.end)===Infinity)return failed;
  let node=c.end;routeNodes=[node];while(node!==c.start){const p=prev.get(node)!;routeRoads.unshift(p.road);routeNodes.unshift(p.node);node=p.node;}
 }
 const roads=routeRoads.map(id=>s.roads.find(r=>r.id===id)!);const events=roads.flatMap(r=>roadEvents(s,r,c));
 return {nodes:routeNodes,roads:routeRoads,length:hasMetricScale(s)?roads.reduce((v,r)=>v+roadCost(s,r,c,false),0):null,cost:roads.reduce((v,r)=>v+roadCost(s,r,c,true),0),events,unknown:events.filter(e=>e.category==='数据缺口').length,reachable:true};
}
export function footprint(f:Facility,scale:number){const size={小:36,中:81,大:144}[f.size];const half=Math.sqrt(size)/scale/2;const angle=f.angle*Math.PI/180;return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>({x:f.x+half*(x*Math.cos(angle)-y*Math.sin(angle)),y:f.y+half*(x*Math.sin(angle)+y*Math.cos(angle))}));}
export function polygonsOverlap(a:Point[],b:Point[]){
 for(const p of [a,b])for(let i=0;i<p.length;i++){const next=p[(i+1)%p.length];const axis={x:-(next.y-p[i].y),y:next.x-p[i].x};const aa=a.map(v=>v.x*axis.x+v.y*axis.y),bb=b.map(v=>v.x*axis.x+v.y*axis.y);if(Math.max(...aa)<Math.min(...bb)||Math.max(...bb)<Math.min(...aa))return false;}return true;
}
export function evaluateSite(s:Spatial,f:Facility){
 const unknown={status:'gray',label:'资料不足',reason:'需要已校正路网和老人起点才能评价。',coverage:0,worst:0,average:0,road:'—',uncovered:0} as const;
 if(!hasMetricScale(s))return {...unknown,reason:'底图尺度待核查；不计算距离、面积及覆盖人数。'};
 if(s.mode!=='demo')return {...unknown,reason:'真实人口及设施覆盖规则尚未核验；仅提供路线分析。'};
 if(!s.roads.length||!s.roads.every(r=>r.confirmed))return unknown;
 const shape=footprint(f,s.scale);
 const basis=imageBasis(s);
 if(shape.some(p=>p.x<0||p.y<0||p.x>basis.w||p.y>basis.h))return {...unknown,status:'red',label:'超出研究范围',reason:'设施轮廓必须完整落在研究范围内。'};
 const hit=s.buildings.find(b=>polygonsOverlap(shape,[{x:b.x-b.w/2,y:b.y-b.h/2},{x:b.x+b.w/2,y:b.y-b.h/2},{x:b.x+b.w/2,y:b.y+b.h/2},{x:b.x-b.w/2,y:b.y+b.h/2}]));
 if(hit)return {...unknown,status:'red',label:'存在空间冲突',reason:`与已知建筑 ${hit.name} 的轮廓重叠。`};
 if(s.mode==='demo'&&polygonsOverlap(shape,[{x:916,y:290},{x:1000,y:280},{x:1000,y:480},{x:924,y:480}]))return {...unknown,status:'red',label:'与水体冲突',reason:'设施轮廓与演示水体边界重叠。'};
 const connections=s.roads.filter(r=>!['不可通行','私人使用'].includes(r.access)).map(r=>{const a=s.nodes.find(n=>n.id===r.a)!,b=s.nodes.find(n=>n.id===r.b)!;const point=projectSegment(f,a,b);return {r,a,b,point,d:distance(f,point)*s.scale};}).sort((a,b)=>a.d-b.d);
 if(!connections.length)return unknown;
 const link=connections[0];
 const roadOverlap=connections.find(v=>{const width=(v.r.width??3)/s.scale/2;const dx=v.b.x-v.a.x,dy=v.b.y-v.a.y,len=distance(v.a,v.b)||1;const normal={x:-dy/len*width,y:dx/len*width};return polygonsOverlap(shape,[{x:v.a.x+normal.x,y:v.a.y+normal.y},{x:v.b.x+normal.x,y:v.b.y+normal.y},{x:v.b.x-normal.x,y:v.b.y-normal.y},{x:v.a.x-normal.x,y:v.a.y-normal.y}]);});
 if(roadOverlap)return {...unknown,status:'red',label:'占用已知道路',reason:`设施轮廓与 ${roadOverlap.r.id} 通行空间重叠。`};
 if(link.d>35)return {...unknown,status:'red',label:'缺少道路接入',reason:'距可接入路段超过演示阈值 35 米，需要补充连接道路。'};
 const residences=s.buildings.filter(b=>b.elderly>0);if(!residences.length)return unknown;
 let coverage=0,uncovered=0,worst=0,total=0,count=0,hasRisk=false;
 for(const home of residences){const start=nearestNode(s,home);const ra=calculateRoute(s,{...s.config,start:start.id,end:link.a.id},'safe'),rb=calculateRoute(s,{...s.config,start:start.id,end:link.b.id},'safe');const options=[{r:ra,add:distance(link.a,link.point)*s.scale},{r:rb,add:distance(link.b,link.point)*s.scale}].filter(o=>o.r.reachable).sort((a,b)=>(a.r.cost+a.add)-(b.r.cost+b.add));const best=options[0];const d=best?best.r.length!+best.add+link.d+distance(home,start)*s.scale:Infinity;
 if(d<=400){coverage+=home.elderly;worst=Math.max(worst,d);total+=d;count++;if(best.r.events.some(e=>e.category!=='数据缺口'))hasRisk=true;}else uncovered+=home.elderly;
 }
 const gaps=s.roads.some(r=>r.width===null);return {status:coverage===0?'yellow':hasRisk||gaps?'yellow':'green',label:coverage===0?'覆盖有限':hasRisk||gaps?'有条件推荐':'当前条件较优',reason:coverage===0?'已录入老人住宅均不在 400 米演示覆盖范围内。':gaps?'部分路段宽度未知，需补测后复核。':hasRisk?'可覆盖老人起点，但到达路线仍经过已知问题路段。':'路网可达、空间无已知冲突，可继续现场核实。',coverage,uncovered,worst,average:count?total/count:0,road:link.r.id};
}
export function snapshot(s:Spatial,name:string,reason:string):Snapshot{return {imageSize:s.imageSize,id:crypto.randomUUID(),name,time:new Date().toISOString(),actor:'张工（本机演示）',reason,nodes:structuredClone(s.nodes),roads:structuredClone(s.roads),buildings:structuredClone(s.buildings),hazards:structuredClone(s.hazards),facility:s.facility?{...s.facility}:null,config:structuredClone(s.config),image:s.image,scale:s.scale,calibration:s.calibration,resources:s.resources,layout:structuredClone(s.layout),goal:s.goal,budget:s.budget,preserve:s.preserve,version:s.version,blueprint:s.blueprint?structuredClone(s.blueprint):undefined};}
