import sys, os; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import _shell
_shell.project("conflicts", "conflicts")

CSS = """
#wrap{position:absolute;inset:0;padding:36px 54px}
#hd{display:flex;align-items:center;margin-bottom:26px}
#hd h2{font-size:32px;font-weight:500}
#scan{margin-left:auto}
#empty{font-size:21px;color:#6b6560;margin-top:40px}
#groups{display:flex;flex-direction:column;gap:16px;margin-top:4px}
.grp{background:#fff;border:1px solid #e4ddd0;border-radius:10px;padding:20px 24px;opacity:0;
 display:flex;align-items:center;gap:18px}
.grp .tag{font-family:'RobotoMono',monospace;font-size:14px;letter-spacing:.08em;text-transform:uppercase;
 background:#efece4;color:#55504a;border-radius:5px;padding:5px 10px;white-space:nowrap}
.grp .tag.c{background:#fde9cf;color:#8a5516}
.grp .t{flex:1;font-size:21px}
.grp .n{font-family:'RobotoMono',monospace;font-size:16px;color:#6b6560}
#detail{position:absolute;left:54px;right:54px;top:120px;background:#fff;border:1px solid #e4ddd0;
 border-radius:10px;padding:28px 32px;opacity:0;box-shadow:0 18px 44px rgba(36,31,26,.10)}
#detail .tag{font-family:'RobotoMono',monospace;font-size:14px;letter-spacing:.08em;text-transform:uppercase;
 background:#fde9cf;color:#8a5516;border-radius:5px;padding:5px 10px;display:inline-block}
#pair{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:22px 0 24px}
.card{border:1px solid #e4ddd0;border-radius:9px;padding:18px 20px;background:#fbfaf7}
.card .w{font-size:20px;line-height:1.4}
.card .m{margin-top:12px;font-family:'RobotoMono',monospace;font-size:15px;color:#6b6560}
#acts{display:flex;gap:12px}
#merged{margin-top:22px;border:1px solid #6f9a37;background:#f6fbef;border-radius:9px;
 padding:18px 20px;opacity:0}
#merged .k{font-family:'RobotoMono',monospace;font-size:14px;letter-spacing:.08em;
 text-transform:uppercase;color:#4d6b26}
#merged .w{font-size:21px;line-height:1.4;margin-top:9px}
"""

STAGE = """   <div id="wrap" data-layout-allow-overlap>
    <div id="hd"><h2>Conflicts</h2><div id="scan" class="btn">Find conflicts</div></div>
    <div id="empty">No scan has been run on this base yet.</div>
    <div id="groups">
     <div class="grp" id="g0"><span class="tag c">Contradiction</span>
      <span class="t">Two memories disagree on the Friday closing time</span><span class="n">2 memories</span></div>
     <div class="grp" id="g1"><span class="tag">Near-duplicate</span>
      <span class="t">Three memories say nearly the same thing about quoting currency</span><span class="n">3 memories</span></div>
     <div class="grp" id="g2"><span class="tag">Near-duplicate</span>
      <span class="t">Two memories describe the same escalation path</span><span class="n">2 memories</span></div>
    </div>
   </div>
   <div id="detail" data-layout-allow-overlap>
    <span class="tag">Contradiction</span>
    <div id="pair">
     <div class="card"><div class="w">The Zurich office closes at 16:00 on Fridays</div>
      <div class="m">saved 5 days ago · shared</div></div>
     <div class="card"><div class="w">The Zurich office closes at 17:30 on Fridays</div>
      <div class="m">saved 2 months ago · shared</div></div>
    </div>
    <div id="acts"><div class="btn ghost">Keep one</div><div class="btn" id="bmerge">Merge</div>
     <div class="btn ghost">Not a conflict</div></div>
    <div id="merged"><div class="k">Suggested merge</div>
     <div class="w">The Zurich office closes at 16:00 on Fridays (changed from 17:30)</div></div>
   </div>"""

SCRIPT = """
  /* 2.35-2.75 the empty state is explicit: nothing has been scanned */
  tl.fromTo("#hd,#empty",{y:12,opacity:0},{y:0,opacity:1,duration:.34,ease:"power2.out",stagger:.08},2.35);

  /* 2.90-3.60 cursor to Find conflicts, click */
  tl.set("#cursor",{x:1180,y:180},2.88);
  tl.to("#cursor",{opacity:1,duration:.14},2.92);
  tl.to("#cursor",{x:1452,y:112,duration:.42,ease:"power2.inOut"},2.98);
  tl.to("#scan",{backgroundColor:"#2e3d3e",duration:.12},3.4);
  tl.set("#ripple",{left:1460,top:120},3.46);
  tl.fromTo("#ripple",{scale:0,opacity:.8},{scale:1.6,opacity:0,duration:.26,ease:"power2.out"},3.48);
  tl.to("#cursor",{opacity:0,duration:.18},3.6);

  /* 3.60-4.25 the scan resolves into grouped cards */
  tl.to("#empty",{opacity:0,duration:.22,ease:"power2.in"},3.6);
  tl.fromTo("#g0,#g1,#g2",{y:14,opacity:0},
    {y:0,opacity:1,duration:.34,ease:"power2.out",stagger:.1},3.75);

  /* 4.40-5.10 breath on the groups (0.70s) */

  /* 5.10-5.80 open the contradiction */
  tl.set("#cursor",{x:700,y:330},5.05);
  tl.to("#cursor",{opacity:1,duration:.14},5.1);
  tl.to("#cursor",{x:500,y:250,duration:.38,ease:"power2.inOut"},5.15);
  tl.set("#ripple",{left:508,top:258},5.56);
  tl.fromTo("#ripple",{scale:0,opacity:.8},{scale:1.6,opacity:0,duration:.26,ease:"power2.out"},5.58);
  tl.to("#cursor",{opacity:0,duration:.18},5.72);
  tl.to("#groups",{opacity:.22,duration:.3,ease:"power2.out"},5.7);
  tl.to("#hd",{opacity:.3,duration:.3,ease:"power2.out"},5.7);
  tl.fromTo("#detail",{y:18,opacity:0},{y:0,opacity:1,duration:.4,ease:"power2.out"},5.74);

  /* 6.15-6.85 breath: the two memories sit still, visibly in tension (0.70s) */

  /* 6.85-7.60 Merge, and the suggested single memory appears */
  tl.set("#cursor",{x:700,y:600},6.8);
  tl.to("#cursor",{opacity:1,duration:.14},6.85);
  tl.to("#cursor",{x:470,y:556,duration:.36,ease:"power2.inOut"},6.9);
  tl.to("#bmerge",{backgroundColor:"#2e3d3e",duration:.12},7.26);
  tl.set("#ripple",{left:478,top:564},7.3);
  tl.fromTo("#ripple",{scale:0,opacity:.8},{scale:1.6,opacity:0,duration:.26,ease:"power2.out"},7.32);
  tl.to("#cursor",{opacity:0,duration:.18},7.46);
  tl.fromTo("#merged",{y:12,opacity:0},{y:0,opacity:1,duration:.38,ease:"power2.out"},7.5);

  /* 7.90-8.40 breath, then payoff; final 1.9s still */"""

html = _shell.page(
  title="Conflicts",
  eyebrow="Conflicts",
  headline="Two memories disagree.<br/>The agent <em>believes both</em>.",
  window_title="Memory — Alfredo — Conflicts",
  stage=STAGE, script=SCRIPT, duration=10.0,
  payoff="Keep one, merge, or dismiss — <em>the decision is recorded</em>.",
  payoff_start=8.1, extra_css=CSS)
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html"), "w", encoding="utf-8").write(html)
print("conflicts:", len(html))
