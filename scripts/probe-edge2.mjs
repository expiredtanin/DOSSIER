import puppeteer from "puppeteer";
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox","--use-gl=swiftshader","--enable-unsafe-swiftshader"]});
const p=await b.newPage(); await p.setViewport({width:1280,height:820,deviceScaleFactor:1});
const errs=[]; p.on("pageerror",e=>errs.push(e.message));
await p.goto("http://localhost:5173/",{waitUntil:"networkidle0",timeout:20000}).catch(()=>{});
await new Promise(r=>setTimeout(r,700));
// Screen-bbox aller Wand-Polygone bestimmen, dann auf die obere Bandkante klicken.
const bb=await p.evaluate(()=>{
  const polys=[...document.querySelectorAll(".plan-svg polygon")];
  if(!polys.length) return null;
  let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
  for(const pl of polys){ const r=pl.getBoundingClientRect(); minX=Math.min(minX,r.left);minY=Math.min(minY,r.top);maxX=Math.max(maxX,r.right);maxY=Math.max(maxY,r.bottom);}
  return {minX,minY,maxX,maxY};
});
let sel=false;
if(bb){
  const cx=(bb.minX+bb.maxX)/2;
  // ein paar Punkte auf der oberen Bandkante probieren
  for(const dy of [4,8,12,16]){
    await p.mouse.click(cx, bb.minY+dy); await new Promise(r=>setTimeout(r,120));
    const k=await p.evaluate(()=>document.querySelector(".objinfo-kind")?.textContent||"");
    if(/Wand/.test(k)){ sel=true; break; }
  }
}
const dims=()=>p.evaluate(()=>[...document.querySelectorAll(".objinfo-input")].map(i=>i.value));
const before=await dims();
const tri=await p.evaluate(()=>{
  const el=document.querySelector(".plan-edge-grip"); if(!el) return null;
  const pts=el.getAttribute("points").trim().split(/\s+/).map(s=>s.split(",").map(Number));
  const svg=el.ownerSVGElement; const ctm=svg.getScreenCTM();
  const cs=pts.map(([x,y])=>{const pt=svg.createSVGPoint();pt.x=x;pt.y=y;const sp=pt.matrixTransform(ctm);return [sp.x,sp.y];});
  return {cx:cs.reduce((a,c)=>a+c[0],0)/3, cy:cs.reduce((a,c)=>a+c[1],0)/3, count:document.querySelectorAll(".plan-edge-grip").length};
});
let after=before, dragged=false;
if(tri){
  await p.mouse.move(tri.cx,tri.cy); await p.mouse.down();
  for(let i=1;i<=6;i++){ await p.mouse.move(tri.cx, tri.cy - i*8); await new Promise(r=>setTimeout(r,20)); }
  await p.mouse.up(); await new Promise(r=>setTimeout(r,200));
  after=await dims(); dragged=true;
}
await p.screenshot({path:"scripts/probe-edge2.png"});
console.log(JSON.stringify({wallSelected:sel, edgeGripCount:tri&&tri.count, dims_before:before, dims_after:after, errs}, null, 2));
await b.close();
