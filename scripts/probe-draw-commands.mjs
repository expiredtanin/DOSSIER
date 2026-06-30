import puppeteer from "puppeteer";
const URL=process.env.PROBE_URL||"http://localhost:5173/";
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox","--use-gl=swiftshader","--enable-unsafe-swiftshader"]});
const p=await b.newPage(); await p.setViewport({width:1280,height:820,deviceScaleFactor:1});
const errs=[]; p.on("pageerror",e=>errs.push(e.message));
await p.goto(URL,{waitUntil:"networkidle0",timeout:20000}).catch(()=>{});
await new Promise(r=>setTimeout(r,700));
const lineCount=()=>p.$$eval(".plan-svg line",ls=>ls.length).catch(()=>-1);
const focusCmd=async()=>{ await p.mouse.click(640,760); await p.keyboard.press("Tab"); await new Promise(r=>setTimeout(r,80)); };
const typeLine=async t=>{ await p.type(".cmdline-input",t,{delay:8}); await p.keyboard.press("Enter"); await new Promise(r=>setTimeout(r,90)); };
const prompt=()=>p.evaluate(()=>document.querySelector(".cmdline-prompt")?.textContent||"");

const l0=await lineCount();
// Polyline (offener Zug, Enter beendet)
await focusCmd(); await typeLine("polyline");
const pp=await prompt();
await typeLine("1,1"); await typeLine("r2,0"); await typeLine("r0,1.5");
await p.keyboard.press("Enter"); await new Promise(r=>setTimeout(r,120)); // beenden
const l1=await lineCount();
// Rectangle
await focusCmd(); await typeLine("rect");
const rp=await prompt();
await typeLine("0.5,3"); await typeLine("r3,1.5");
const l2=await lineCount();
// Circle (Radius getippt)
await focusCmd(); await typeLine("circle");
const cp=await prompt();
await typeLine("4,4"); await typeLine("0.8");
const l3=await lineCount();
await p.screenshot({path:"scripts/probe-draw-commands.png"});
console.log(JSON.stringify({
  polyPrompt:pp, rectPrompt:rp, circPrompt:cp,
  lines_start:l0, after_polyline:l1, after_rect:l2, after_circle:l3,
  polyAdded:l1-l0, rectAdded:l2-l1, circleAdded:l3-l2, errs
},null,2));
await b.close();
