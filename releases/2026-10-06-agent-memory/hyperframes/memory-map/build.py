"""Generates index.html from cloud.json. Run: python3 build.py"""
import json, math

CX, CY = 810, 389          # svg group origin inside #stage (1620x778)
APP_X, APP_Y, BAR = 150, 92, 52

cloud = json.load(open("cloud.json", encoding="utf-8"))
fonts = open("../../../_build/ci-video-fonts.css", encoding="utf-8").read()
dots, regions = cloud["dots"], cloud["regions"]

# selected dot: nearest to a clear spot left of where the panel opens
tx, ty = 120, -150
si = min(range(len(dots)), key=lambda i: (dots[i]["x"]-tx)**2 + (dots[i]["y"]-ty)**2)
sel = dots[si]
near = sorted((i for i in range(len(dots)) if i != si),
              key=lambda i: (dots[i]["x"]-sel["x"])**2 + (dots[i]["y"]-sel["y"])**2)[:5]

dots_svg = "".join(f'<circle class="dot r{d["r"]}" cx="{d["x"]}" cy="{d["y"]}" r="5" fill="{d["c"]}"/>'
                   for d in dots)
links = "".join(f'<line x1="{sel["x"]}" y1="{sel["y"]}" x2="{dots[i]["x"]}" y2="{dots[i]["y"]}"/>'
                for i in near)
# plates float just above their cluster centre
plates = "".join(
    f'<div class="plate" id="plate{i}" style="left:{CX+r["x"]:.0f}px;top:{CY+r["y"]-52:.0f}px">{r["name"]}</div>'
    for i, r in enumerate(regions) if i in (0, 1, 2))
chips = "".join(
    f'<div class="chip" id="chip{i}"><span class="sw" style="background:{r["color"]}"></span>'
    f'{r["name"]}<span class="ct">{r["count"]}</span></div>' for i, r in enumerate(regions))

# cursor/ripple in #stage pixels, on the selected dot
SX, SY = round(CX + sel["x"]), round(CY + sel["y"])
CHIP_X, CHIP_Y = 150, 712   # first chip, in #stage px

html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=1920, height=1080"/>
<title>The map — every passage, placed by meaning</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
{fonts}
*{{margin:0;padding:0;box-sizing:border-box}}
body{{width:1920px;height:1080px;overflow:hidden;background:#f8f6f1;
 font-family:'Aspekta',system-ui,sans-serif;letter-spacing:-0.025em;color:#241f1a}}
#bg{{position:absolute;inset:0;background:#f8f6f1}}
#bg::after{{content:"";position:absolute;inset:0;
 background:radial-gradient(900px 440px at 50% 0%,rgba(111,154,55,0.07),transparent 70%)}}
#hook{{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}}
#hook-inner{{text-align:center}}
.eyebrow{{display:inline-flex;align-items:center;gap:10px;background:#fff;border:1px solid #e4ddd0;
 border-radius:999px;padding:9px 18px;font-family:'RobotoMono',monospace;font-size:17px;
 letter-spacing:0.12em;color:#55504a;text-transform:uppercase}}
.eyebrow i{{width:9px;height:9px;border-radius:50%;background:#6f9a37;display:block}}
#hook h1{{margin-top:30px;font-size:88px;font-weight:500;line-height:1.06;letter-spacing:-0.03em}}
#hook em{{font-style:normal;background:#cef79e;padding:0 .12em;border-radius:3px}}
#app{{position:absolute;left:{APP_X}px;top:{APP_Y}px;width:1620px;height:830px;background:#fbfaf7;
 border:1px solid #e4ddd0;border-radius:10px;
 box-shadow:0 24px 60px rgba(36,31,26,.10),0 2px 8px rgba(36,31,26,.06);overflow:hidden}}
.bar{{height:{BAR}px;border-bottom:1px solid #efece4;display:flex;align-items:center;padding:0 20px;gap:9px}}
.bar i{{width:11px;height:11px;border-radius:50%;background:#e4ddd0;display:block}}
.bar span{{margin-left:14px;font-size:15px;color:#6b6560}}
#stage{{position:relative;height:778px}}
#cloud{{position:absolute;inset:0}}
.dot{{opacity:.74}}
.plate{{position:absolute;background:rgba(251,250,247,.93);
 border:1px solid #e4ddd0;border-radius:5px;padding:6px 13px;font-size:20px;color:#241f1a;
 white-space:nowrap;opacity:0;box-shadow:0 2px 8px rgba(36,31,26,.05)}}
#chips{{position:absolute;left:28px;right:28px;bottom:22px;display:flex;flex-wrap:wrap;gap:10px}}
.chip{{display:inline-flex;align-items:center;gap:9px;background:#fff;border:1px solid #e4ddd0;
 border-radius:999px;padding:9px 16px;font-size:18px;color:#241f1a}}
.chip .sw{{width:11px;height:11px;border-radius:50%;display:block}}
.chip .ct{{font-family:'RobotoMono',monospace;font-size:16px;color:#6b6560;margin-left:3px}}
#panel{{position:absolute;right:0;top:0;bottom:0;width:430px;background:#fbfaf7;
 border-left:1px solid #e4ddd0;padding:26px;opacity:0}}
#panel h3{{font-size:15px;font-family:'RobotoMono',monospace;letter-spacing:.1em;
 text-transform:uppercase;color:#6b6560}}
#panel h2{{font-size:26px;font-weight:500;margin-top:14px;line-height:1.22;
 overflow-wrap:anywhere;word-break:break-word}}
.meta{{margin-top:24px;display:grid;grid-template-columns:auto 1fr;gap:10px 22px;font-size:18px}}
.meta dt{{color:#6b6560}}
.meta dd{{font-family:'RobotoMono',monospace}}
#payoff{{position:absolute;left:0;right:0;bottom:0;height:128px;background:#222f30;
 display:flex;align-items:center;justify-content:center}}
#payoff p{{font-size:37px;color:#f4f5f2;font-weight:400}}
#payoff em{{font-style:normal;color:#cef79e}}
#cursor{{position:absolute;opacity:0;pointer-events:none}}
#ripple{{position:absolute;width:46px;height:46px;border-radius:50%;background:#cef79e;
 opacity:0;transform:translate(-50%,-50%) scale(0)}}
</style>
</head>
<body>
<div data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-duration="9.8">

 <div id="bg" class="clip" data-start="0" data-duration="9.8" data-track-index="1"></div>

 <div id="hook" class="clip" data-start="0" data-duration="2.5" data-track-index="2" data-layout-allow-overlap>
  <div id="hook-inner">
   <div class="eyebrow"><i></i>Knowledge map</div>
   <h1>Every passage,<br/>placed by <em>meaning</em>.</h1>
  </div>
 </div>

 <div id="app" class="clip" data-start="1.9" data-duration="7.9" data-track-index="3" data-layout-allow-occlusion>
  <div class="bar"><i></i><i></i><i></i><span>Hydraulik Steuerblöcke — Overview</span></div>
  <div id="stage">
   <svg id="cloud" viewBox="0 0 1620 778" width="1620" height="778">
    <g transform="translate({CX},{CY})">
     <g id="cloudg">
      <g id="cloudshift">
       <g id="links" opacity="0" stroke="#55504a" stroke-width="1.2" fill="none">{links}</g>
       {dots_svg}
       <circle id="sel" cx="{sel['x']}" cy="{sel['y']}" r="5" fill="#222f30" opacity="0"/>
      </g>
     </g>
    </g>
   </svg>
   {plates}
   <div id="chips">{chips}</div>
   <div id="panel">
    <h3>Item</h3>
    <h2>31220de14_Betriebsanleitung_mechanisch_geregelter_Steuerblock</h2>
    <dl class="meta">
     <dt>Passages</dt><dd>42</dd>
     <dt>Added</dt><dd>20 Jul 2026</dd>
     <dt>Source</dt><dd>import</dd>
    </dl>
   </div>
   <div id="ripple"></div>
   <svg id="cursor" width="26" height="30" viewBox="0 0 26 30">
    <path d="M2 2l20 12-9 2 5 10-4 2-5-10-7 6z" fill="#241f1a" stroke="#fff" stroke-width="1.6"/>
   </svg>
  </div>
 </div>

 <div id="payoff" class="clip" data-start="7.5" data-duration="2.3" data-track-index="4" data-layout-allow-overflow>
  <p>Named from the base's own words. <em>No model asked.</em></p>
 </div>

 <script>
  window.__timelines = window.__timelines || {{}};
  const tl = gsap.timeline({{paused:true}});

  /* 0.00-0.56 hook enters, then holds still to 1.90 (1.34s read) */
  tl.fromTo("#hook .eyebrow",{{y:10,opacity:0}},{{y:0,opacity:1,duration:.32,ease:"power2.out"}},.05);
  tl.fromTo("#hook h1",{{y:16,opacity:0}},{{y:0,opacity:1,duration:.42,ease:"power2.out"}},.14);

  /* 1.90-2.38 hook yields to the app window */
  tl.to("#hook-inner",{{y:-16,opacity:0,duration:.3,ease:"power2.in"}},1.9);
  tl.fromTo("#app",{{y:20,opacity:0}},{{y:0,opacity:1,duration:.42,ease:"power2.out"}},1.96);

  /* 2.30-3.80 the cloud settles and turns a few degrees onto its face */
  tl.fromTo(".dot",{{scale:0,transformOrigin:"center"}},
    {{scale:1,duration:.5,ease:"power2.out",stagger:{{each:.0032,from:"center"}}}},2.3);
  tl.fromTo("#cloudg",{{rotation:-7,scale:.93,transformOrigin:"center"}},
    {{rotation:0,scale:1,duration:1.5,ease:"power2.out"}},2.3);

  /* 3.15-3.65 region plates resolve */
  gsap.set(".plate",{{xPercent:-50,yPercent:-50}});
  tl.to("#plate0",{{opacity:1,duration:.3,ease:"power2.out"}},3.15);
  tl.to("#plate1",{{opacity:1,duration:.3,ease:"power2.out"}},3.28);
  tl.to("#plate2",{{opacity:1,duration:.3,ease:"power2.out"}},3.41);

  /* 3.71-4.25 breath (0.54s) */

  /* 4.25-5.08 cursor to the first chip; everything outside that region dims */
  tl.set("#cursor",{{x:330,y:660}},4.2);
  tl.to("#cursor",{{opacity:1,duration:.14}},4.25);
  tl.to("#cursor",{{x:{CHIP_X},y:{CHIP_Y},duration:.45,ease:"power2.inOut"}},4.3);
  tl.to("#chip0",{{backgroundColor:"#efece4",duration:.15}},4.78);
  tl.to(".dot:not(.r0)",{{opacity:.1,duration:.3,ease:"power2.out"}},4.84);
  tl.to("#plate1,#plate2",{{opacity:.22,duration:.3}},4.84);

  /* 5.14-5.74 breath on the dimmed state (0.60s), then release */
  tl.to(".dot",{{opacity:.74,duration:.3,ease:"power2.out"}},5.74);
  tl.to("#plate1,#plate2",{{opacity:1,duration:.3}},5.74);
  tl.to("#chip0",{{backgroundColor:"#ffffff",duration:.2}},5.74);

  /* 5.78-6.50 cursor to a dot, click, neighbour lines draw */
  tl.to("#cursor",{{x:{SX-6},y:{SY-4},duration:.5,ease:"power2.inOut"}},5.78);
  tl.set("#ripple",{{left:{SX},top:{SY}}},6.26);
  tl.fromTo("#ripple",{{scale:0,opacity:.8}},{{scale:1.6,opacity:0,duration:.26,ease:"power2.out"}},6.28);
  tl.to("#sel",{{opacity:1,attr:{{r:9}},duration:.2,ease:"power2.out"}},6.3);
  tl.to("#links",{{opacity:.45,duration:.3,ease:"power2.out"}},6.36);
  tl.to("#cursor",{{opacity:0,duration:.2}},6.5);

  /* 6.52-7.00 the panel opens; the cloud slides clear of it */
  tl.fromTo("#panel",{{x:40,opacity:0}},{{x:0,opacity:1,duration:.4,ease:"power2.out"}},6.56);
  tl.to("#cloudshift",{{x:-170,duration:.5,ease:"power2.inOut"}},6.56);
  /* the plates label the cloud, so they travel with it */
  tl.to("#plate0,#plate1,#plate2",{{x:-170,duration:.5,ease:"power2.inOut"}},6.56);

  /* 7.06-7.50 breath on the opened panel (0.44s) */

  /* 7.50-7.90 payoff rises; final 1.9s completely still */
  tl.fromTo("#payoff",{{y:130}},{{y:0,duration:.4,ease:"power2.out"}},7.5);

  window.__timelines["main"] = tl;
 </script>
</div>
</body>
</html>
"""
open("index.html", "w", encoding="utf-8").write(html)
print(f"index.html {len(html)} bytes | selected dot #{si} at stage ({SX},{SY}) | {len(near)} neighbour lines")
