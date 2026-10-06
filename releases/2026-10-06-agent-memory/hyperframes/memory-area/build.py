import sys, os; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import _shell
_shell.project("memory-area", "memory-area")

CSS = """
#wrap{position:absolute;inset:0;padding:40px 54px}
h2.pt{font-size:34px;font-weight:500;margin-bottom:6px}
p.sub{font-size:19px;color:#6b6560;margin-bottom:28px}
#bases{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.base{background:#fff;border:1px solid #e4ddd0;border-radius:10px;padding:22px 24px;opacity:0}
.base h3{font-size:23px;font-weight:500}
.base .n{font-family:'RobotoMono',monospace;font-size:15px;color:#6b6560;margin-top:9px}
#detail{position:absolute;inset:0;padding:40px 54px;opacity:0;background:#fbfaf7}
#strip{display:flex;gap:14px;margin:22px 0 26px}
.stat{flex:1;background:#fff;border:1px solid #e4ddd0;border-radius:10px;padding:18px 20px}
.stat .k{font-size:15px;color:#6b6560;font-family:'RobotoMono',monospace;letter-spacing:.08em;text-transform:uppercase}
.stat .v{font-size:38px;font-weight:500;margin-top:8px}
.row{display:flex;align-items:center;gap:18px;padding:17px 20px;border-bottom:1px solid #efece4;font-size:20px}
.row .tp{font-family:'RobotoMono',monospace;font-size:14px;color:#55504a;background:#efece4;
 border-radius:5px;padding:4px 9px}
.row .t{flex:1}
.row .d{color:#6b6560;font-family:'RobotoMono',monospace;font-size:16px}
#mem{position:absolute;left:54px;right:54px;top:120px;background:#fff;border:1px solid #e4ddd0;
 border-radius:10px;padding:30px 34px;opacity:0;box-shadow:0 18px 44px rgba(36,31,26,.10)}
#mem .tp{font-family:'RobotoMono',monospace;font-size:14px;color:#55504a;background:#efece4;
 border-radius:5px;padding:4px 9px;display:inline-block}
#mem h3{font-size:30px;font-weight:500;margin:16px 0 18px;line-height:1.3}
#mem dl{display:grid;grid-template-columns:auto 1fr;gap:10px 24px;font-size:18px}
#mem dt{color:#6b6560}
#mem dd{font-family:'RobotoMono',monospace}
"""

STAGE = """   <div id="wrap" data-layout-allow-overlap>
    <h2 class="pt">Memory</h2>
    <p class="sub">Every base, and what each agent has learned.</p>
    <div id="bases">
     <div class="base" id="b0"><h3>Alfredo</h3><div class="n">148 memories · 12 agents</div></div>
     <div class="base" id="b1"><h3>Service desk</h3><div class="n">96 memories · 4 agents</div></div>
     <div class="base" id="b2"><h3>Sales</h3><div class="n">41 memories · 2 agents</div></div>
    </div>
   </div>
   <div id="detail" data-layout-allow-overlap>
    <h2 class="pt">Alfredo</h2>
    <div id="strip">
     <div class="stat"><div class="k">Memories</div><div class="v">148</div></div>
     <div class="stat"><div class="k">Used this month</div><div class="v">87</div></div>
     <div class="stat"><div class="k">Never used</div><div class="v">24</div></div>
     <div class="stat"><div class="k">Conflicts</div><div class="v">3</div></div>
    </div>
    <div class="row"><span class="tp">PREFERENCE</span><span class="t">Prefers the short version first, then the detail</span><span class="d">2 days ago</span></div>
    <div class="row"><span class="tp">FACT</span><span class="t">The Zurich office closes at 16:00 on Fridays</span><span class="d">5 days ago</span></div>
    <div class="row"><span class="tp">DECISION</span><span class="t">Quotes go out in EUR unless the client asks otherwise</span><span class="d">3 weeks ago</span></div>
   </div>
   <div id="mem" data-layout-allow-overlap>
    <span class="tp">PREFERENCE</span>
    <h3>Prefers the short version first, then the detail — in writing</h3>
    <dl><dt>Saved from</dt><dd>Chat with Alfredo</dd>
        <dt>Last used</dt><dd>2 days ago</dd>
        <dt>Used</dt><dd>14 times</dd>
        <dt>Access</dt><dd>Shared</dd></dl>
   </div>"""

SCRIPT = """
  /* 2.35-3.10 the bases resolve */
  tl.fromTo("#b0,#b1,#b2",{y:14,opacity:0},
    {y:0,opacity:1,duration:.36,ease:"power2.out",stagger:.1},2.35);

  /* 3.20-3.90 breath (0.70s) */

  /* 3.90-4.55 cursor into the first base, click */
  tl.set("#cursor",{x:640,y:300},3.85);
  tl.to("#cursor",{opacity:1,duration:.14},3.9);
  tl.to("#cursor",{x:240,y:214,duration:.42,ease:"power2.inOut"},3.95);
  tl.set("#ripple",{left:248,top:222},4.4);
  tl.fromTo("#ripple",{scale:0,opacity:.8},{scale:1.6,opacity:0,duration:.26,ease:"power2.out"},4.42);
  tl.to("#cursor",{opacity:0,duration:.18},4.55);

  /* 4.55-5.05 the base page replaces it; the stats strip resolves */
  tl.to("#wrap",{opacity:0,duration:.28,ease:"power2.in"},4.52);
  tl.fromTo("#detail",{opacity:0},{opacity:1,duration:.34,ease:"power2.out"},4.66);
  tl.fromTo("#strip .stat",{y:12,opacity:0},
    {y:0,opacity:1,duration:.3,ease:"power2.out",stagger:.07},4.8);

  /* 5.25-6.00 breath on the stats (0.75s) */

  /* 6.00-6.60 open one memory in full */
  tl.set("#cursor",{x:520,y:470},5.95);
  tl.to("#cursor",{opacity:1,duration:.14},6.0);
  tl.to("#cursor",{x:430,y:432,duration:.34,ease:"power2.inOut"},6.05);
  tl.set("#ripple",{left:438,top:440},6.4);
  tl.fromTo("#ripple",{scale:0,opacity:.8},{scale:1.6,opacity:0,duration:.26,ease:"power2.out"},6.42);
  tl.to("#cursor",{opacity:0,duration:.18},6.56);
  /* the list recedes so the card reads as an overlay, not a collision */
  tl.to("#detail .row",{opacity:.25,duration:.3,ease:"power2.out"},6.56);
  tl.to("#strip",{opacity:.35,duration:.3,ease:"power2.out"},6.56);
  tl.fromTo("#mem",{y:18,opacity:0},{y:0,opacity:1,duration:.4,ease:"power2.out"},6.6);

  /* 7.00-7.60 breath, then payoff; final 1.9s still */"""

html = _shell.page(
  title="The Memory area",
  eyebrow="Memory area",
  headline="What has this agent<br/><em>actually learned</em>?",
  window_title="Build — Memory",
  stage=STAGE, script=SCRIPT, duration=9.5,
  payoff="Readable, editable, <em>access-controlled</em>.",
  payoff_start=7.6, extra_css=CSS)
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html"), "w", encoding="utf-8").write(html)
print("memory-area:", len(html))
