import puppeteer from "puppeteer";
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox","--use-gl=swiftshader","--enable-unsafe-swiftshader"]});
const p=await b.newPage(); await p.setViewport({width:1400,height:880,deviceScaleFactor:1.5});
await p.goto("http://localhost:5187/",{waitUntil:"networkidle0",timeout:20000}).catch(()=>{});
await new Promise(r=>setTimeout(r,1000));
// ersten Dropdown-Trigger (Detailgrad) klicken
const tr=await p.$(".tb-dd-trigger"); if(tr){const r=await tr.boundingBox();await p.mouse.click(r.x+r.width/2,r.y+r.height/2);await new Promise(t=>setTimeout(t,350));}
const info=await p.evaluate(()=>{const menu=document.querySelector(".tb-dd-menu, .ctx-menu");if(!menu)return{open:false};const item=menu.querySelector(".ctx-item, .tb-dd-item");const cs=item?getComputedStyle(item):null;const ic=menu.querySelector(".ctx-item-icon, .material-symbols-outlined");return{open:true,itemFont:cs?.fontSize,itemPad:cs?.padding,menuFont:getComputedStyle(menu).fontSize,radius:getComputedStyle(menu).borderRadius,iconFont:ic?getComputedStyle(ic).fontSize:"(none)"};});
await p.screenshot({path:"scripts/probe-dd-size.png"});
console.log(JSON.stringify(info));
await b.close();
