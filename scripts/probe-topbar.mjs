import puppeteer from "puppeteer";
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox","--use-gl=swiftshader","--enable-unsafe-swiftshader"]});
const p=await b.newPage(); await p.setViewport({width:1400,height:200,deviceScaleFactor:3});
await p.goto("http://localhost:5187/",{waitUntil:"networkidle0",timeout:20000}).catch(()=>{});
await new Promise(r=>setTimeout(r,700));
const tb=await p.$(".topbar"); const box=await tb.boundingBox();
await p.screenshot({path:"scripts/probe-topbar.png", clip:{x:0,y:0,width:1400,height:Math.ceil(box.height)+8}});
// zähle die Icon-Buttons + ihre computed Größe/Farbe
const info=await p.evaluate(()=>{
  const icons=[...document.querySelectorAll(".view-icon")];
  const svg=icons[0]?.querySelector("svg");
  const cs=icons[0]?getComputedStyle(icons[0]):null;
  return { count:icons.length, cellW:cs?.width, cellH:cs?.height, color:cs?.color, svgW:svg?.getAttribute("width"), gridRows: document.querySelector(".view-grid")?getComputedStyle(document.querySelector(".view-grid")).gridTemplateColumns:null };
});
console.log(JSON.stringify(info));
await b.close();
