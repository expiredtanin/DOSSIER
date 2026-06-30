import puppeteer from "puppeteer";
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox","--use-gl=swiftshader","--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
const logs=[]; page.on("pageerror",e=>logs.push("[PAGEERROR] "+e.message)); page.on("console",m=>logs.push("[console] "+m.text()));
try { await page.goto("http://localhost:5173/", { waitUntil:"networkidle0", timeout:8000 }); } catch(e){ logs.push("[goto] "+e.message); }
await page.evaluate(()=>{ try{localStorage.removeItem("cad.layout");}catch{} });
await page.reload({waitUntil:"domcontentloaded"}).catch(()=>{});
await page.waitForSelector(".plan-svg polygon",{timeout:20000});
await new Promise(r=>setTimeout(r,800));
const dom = await page.evaluate(()=>({
  docks: [...document.querySelectorAll(".dock")].map(d=>d.className),
  hasLeft: !!document.querySelector(".dock-left"),
  hasRight: !!document.querySelector(".dock-right"),
  resTriggerActive: document.querySelector(".res-trigger")?.classList.contains("active") ?? null,
  layout: (()=>{try{return JSON.parse(localStorage.getItem("cad.layout"));}catch{return "ERR";}})(),
  bodyChildren: [...(document.querySelector(".body")?.children||[])].map(c=>c.className),
}));
console.log(JSON.stringify(dom,null,2));
console.log("LOGS:\n"+logs.join("\n"));
await browser.close();
