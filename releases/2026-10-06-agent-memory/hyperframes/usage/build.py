import sys, os; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import _shell
_shell.project("usage", "usage")

CSS = """
#wrap{position:absolute;inset:0;padding:36px 54px}
#top{display:flex;gap:14px;align-items:stretch;margin-bottom:24px}
.stat{background:#fff;border:1px solid #e4ddd0;border-radius:10px;padding:18px 22px;min-width:230px}
.stat .k{font-size:14px;color:#6b6560;font-family:'RobotoMono',monospace;letter-spacing:.08em;text-transform:uppercase}
.stat .v{font-size:40px;font-weight:500;margin-top:6px}
.stat.hl{border-color:#6f9a37;background:#f6fbef}
#filter{margin-left:auto;display:flex;align-items:center;gap:10px}
.pill{display:inline-flex;align-items:center;gap:9px;background:#fff;border:1px solid #e4ddd0;
 border-radius:999px;padding:11px 18px;font-size:18px}
#head{display:flex;gap:18px;padding:0 20px 11px;font-size:15px;color:#6b6560;
 font-family:'RobotoMono',monospace;letter-spacing:.07em;text-transform:uppercase}
#head .t{flex:1}
.row{display:flex;align-items:center;gap:18px;padding:17px 20px;border-top:1px solid #efece4;font-size:20px}
.row .cb{width:21px;height:21px;border:1.5px solid #c9c2b4;border-radius:5px;flex:0 0 21px}
.row .t{flex:1}
.row .d{color:#6b6560;font-family:'RobotoMono',monospace;font-size:17px;width:190px;text-align:right}
.row.never .d{color:#a39a88}
#bulk{position:absolute;left:54px;right:54px;bottom:30px;background:#222f30;border-radius:10px;
 padding:16px 22px;display:flex;align-items:center;gap:18px;color:#f4f5f2;font-size:20px;opacity:0}
#bulk .sp{margin-left:auto;display:flex;gap:11px}
#bulk .ba{background:#2e3d3e;border-radius:7px;padding:10px 18px;font-size:18px}
#bulk .ba.go{background:#cef79e;color:#222f30}
"""

ROWS_ALL = "".join(
  f'<div class="row{" never" if n else ""}"><span class="cb"></span>'
  f'<span class="t">{t}</span><span class="d">{d}</span></div>'
  for t,d,n in [
    ("Prefers the short version first, then the detail","2 days ago",0),
    ("The Zurich office closes at 16:00 on Fridays","5 days ago",0),
    ("Old VPN endpoint for the Basel site","never used",1),
    ("Quotes go out in EUR unless the client asks","3 weeks ago",0),
    ("Legacy ticket prefix NSD- was retired","never used",1),
    ("Former office manager's extension","never used",1),
  ])

STAGE = f"""   <div id="wrap">
    <div id="top">
     <div class="stat"><div class="k">Memories</div><div class="v">148</div></div>
     <div class="stat" id="never"><div class="k">Never used</div><div class="v">24</div></div>
     <div id="filter"><div class="pill" id="fp">Usage: all</div></div>
    </div>
    <div id="head"><span style="width:21px"></span><span class="t">Memory</span><span style="width:190px;text-align:right">Last used</span></div>
    <div id="rows">{ROWS_ALL}</div>
    <div id="bulk"><span id="bcount">3 selected</span>
     <span class="sp"><span class="ba">Set access</span><span class="ba go" id="barch">Archive</span></span></div>
   </div>"""

SCRIPT = """
  /* 2.35-3.05 the list and the Never used card resolve */
  tl.fromTo("#top .stat,#filter",{y:12,opacity:0},
    {y:0,opacity:1,duration:.32,ease:"power2.out",stagger:.08},2.35);
  tl.fromTo(".row",{opacity:0},{opacity:1,duration:.28,ease:"power2.out",stagger:.045},2.6);

  /* 3.10-3.80 breath on the number (0.70s) */

  /* 3.80-4.60 the Usage filter is applied; the list collapses to never-used */
  tl.to("#never",{borderColor:"#6f9a37",backgroundColor:"#f6fbef",duration:.25},3.8);
  tl.set("#cursor",{x:1180,y:210},3.78);
  tl.to("#cursor",{opacity:1,duration:.14},3.82);
  tl.to("#cursor",{x:1404,y:128,duration:.4,ease:"power2.inOut"},3.88);
  tl.set("#ripple",{left:1412,top:136},4.3);
  tl.fromTo("#ripple",{scale:0,opacity:.8},{scale:1.6,opacity:0,duration:.26,ease:"power2.out"},4.32);
  tl.call(function(){document.getElementById("fp").textContent="Usage: never used";},null,4.42);
  tl.to(".row:not(.never)",{height:0,paddingTop:0,paddingBottom:0,opacity:0,
    borderTopWidth:0,duration:.4,ease:"power2.inOut"},4.46);
  tl.to("#cursor",{opacity:0,duration:.18},4.6);

  /* 4.90-5.50 breath on the filtered list (0.60s) */

  /* 5.50-6.30 select them all, the bulk bar rises */
  tl.to(".row.never .cb",{backgroundColor:"#222f30",borderColor:"#222f30",
    duration:.2,ease:"power2.out",stagger:.08},5.5);
  tl.fromTo("#bulk",{y:70,opacity:0},{y:0,opacity:1,duration:.34,ease:"power2.out"},5.8);

  /* 6.30-7.00 Archive; the rows leave */
  tl.set("#cursor",{x:1300,y:660},6.25);
  tl.to("#cursor",{opacity:1,duration:.14},6.3);
  tl.to("#cursor",{x:1486,y:706,duration:.34,ease:"power2.inOut"},6.35);
  tl.set("#ripple",{left:1494,top:714},6.7);
  tl.fromTo("#ripple",{scale:0,opacity:.8},{scale:1.6,opacity:0,duration:.26,ease:"power2.out"},6.72);
  tl.to("#cursor",{opacity:0,duration:.18},6.86);
  tl.to(".row.never",{x:-40,opacity:0,duration:.34,ease:"power2.in",stagger:.07},6.86);
  tl.to("#bulk",{y:70,opacity:0,duration:.3,ease:"power2.in"},7.1);
  tl.call(function(){document.querySelector("#never .v").textContent="0";},null,7.2);

  /* 7.30-7.80 breath, then payoff; final 1.9s still */"""

html = _shell.page(
  title="What the agent actually uses",
  eyebrow="Usage",
  headline="Half a base is never read.<br/>Now you can tell <em>which half</em>.",
  window_title="Memory — Alfredo",
  stage=STAGE, script=SCRIPT, duration=9.7,
  payoff="Archived, not deleted — <em>out of recall, restorable</em>.",
  payoff_start=7.8, extra_css=CSS)
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html"), "w", encoding="utf-8").write(html)
print("usage:", len(html))
