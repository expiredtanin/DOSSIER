import puppeteer from "puppeteer";
const b = await puppeteer.launch({ headless:"new", args:["--no-sandbox","--use-gl=swiftshader","--enable-unsafe-swiftshader"] });
const p = await b.newPage(); await p.setViewport({width:1300,height:850,deviceScaleFactor:2});
const logs=[]; p.on("pageerror",e=>logs.push(e.message));
await p.goto("http://localhost:5174/",{waitUntil:"networkidle0",timeout:20000}).catch(()=>{});
await new Promise(r=>setTimeout(r,800));
const info = await p.evaluate(()=>({
  toolsPanel: !!document.querySelector(".tools-panel"),
  toolRows: document.querySelectorAll(".tools-panel .tool-row").length,
  activeTab: [...document.querySelectorAll(".tab")].find(t=>t.classList.contains("active"))?.textContent?.trim() ?? null,
}));
// Wand-Werkzeug im Panel klicken → wallType-Dropdown sollte erscheinen.
await p.evaluate(()=>{ const r=[...document.querySelectorAll(".tools-panel .tool-row")].find(x=>/Wand/.test(x.textContent)); r?.click(); });
await new Promise(r=>setTimeout(r,200));
const afterWall = await p.evaluate(()=>({ active: [...document.querySelectorAll(".tool-row.active")].map(x=>x.textContent.trim()), hasWallTypeSelect: !!document.querySelector(".tools-panel select") }));
await p.screenshot({ path:"scripts/probe-tools-panel.png" });
console.log("info:", JSON.stringify(info), "afterWall:", JSON.stringify(afterWall), logs.length?logs.join("|"):"(no err)");
await b.close();
