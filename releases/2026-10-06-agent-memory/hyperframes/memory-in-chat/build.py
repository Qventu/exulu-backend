"""Generates index.html. Run from this directory: python3 build.py"""
import sys, os; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import _shell

CSS = """
#chat{position:absolute;inset:0;padding:44px 300px}
.msg{display:flex;gap:16px;margin-bottom:26px;opacity:0}
.av{width:42px;height:42px;border-radius:50%;flex:0 0 42px;background:#efece4;
 display:flex;align-items:center;justify-content:center;font-size:16px;color:#55504a}
.av.me{background:#222f30;color:#f4f5f2}
.bub{font-size:24px;line-height:1.45;padding-top:7px;max-width:820px}
#card{margin-left:58px;margin-top:4px;width:720px;background:#fff;border:1px solid #e4ddd0;
 border-radius:10px;padding:22px 24px;opacity:0;box-shadow:0 2px 10px rgba(36,31,26,.05)}
#card .ch{display:flex;align-items:center;gap:10px;font-family:'RobotoMono',monospace;
 font-size:15px;letter-spacing:.1em;text-transform:uppercase;color:#6b6560}
#card .ch b{width:9px;height:9px;border-radius:50%;background:#6f9a37;display:block}
#field{margin-top:16px;border:1px solid #e4ddd0;border-radius:7px;padding:15px 17px;
 font-size:22px;line-height:1.4;background:#fbfaf7}
#caret{display:inline-block;width:2px;height:24px;background:#241f1a;vertical-align:-4px;opacity:0}
#acts{margin-top:18px;display:flex;gap:12px;align-items:center}
#saved{margin-left:58px;margin-top:14px;display:inline-flex;align-items:center;gap:10px;
 background:#cef79e;border-radius:999px;padding:10px 18px;font-size:19px;opacity:0}
"""

STAGE = """   <div id="chat">
    <div class="msg" id="m1"><div class="av me">DC</div>
     <div class="bub">Always give me the short version first, then the detail.</div></div>
    <div class="msg" id="m2"><div class="av">AI</div>
     <div class="bub">Understood — I'll lead with the summary from now on.</div></div>
    <div id="card">
     <div class="ch"><b></b>Save to memory</div>
     <div id="field"><span id="ftext">Prefers the short version first, then the detail</span><span id="caret"></span></div>
     <div id="acts"><div class="btn" id="approve">Save</div><div class="btn ghost">Not this one</div></div>
    </div>
    <div id="saved">Saved to memory</div>
   </div>"""

SCRIPT = """
  /* 2.35-3.30 the exchange lands */
  tl.fromTo("#m1",{y:12,opacity:0},{y:0,opacity:1,duration:.34,ease:"power2.out"},2.35);
  tl.fromTo("#m2",{y:12,opacity:0},{y:0,opacity:1,duration:.34,ease:"power2.out"},2.95);

  /* 3.45-3.85 the consent card IS the save step */
  tl.fromTo("#card",{y:14,opacity:0},{y:0,opacity:1,duration:.4,ease:"power2.out"},3.45);

  /* 3.90-4.60 breath: the card sits still and readable (0.70s) */

  /* 4.60-5.60 the text is edited in place - proving it is not a yes/no */
  tl.to("#field",{borderColor:"#6f9a37",duration:.2},4.6);
  tl.to("#caret",{opacity:1,duration:.08},4.62);
  tl.to("#caret",{opacity:0,duration:.08,repeat:7,yoyo:true,ease:"none"},4.72);
  tl.call(function(){document.getElementById("ftext").textContent=
    "Prefers the short version first, then the detail \\u2014 in writing";},null,5.05);
  tl.to("#caret",{opacity:0,duration:.1},5.6);
  tl.to("#field",{borderColor:"#e4ddd0",duration:.2},5.62);

  /* 5.70-6.42 cursor to Save, click */
  tl.set("#cursor",{x:700,y:560},5.65);
  tl.to("#cursor",{opacity:1,duration:.14},5.7);
  tl.to("#cursor",{x:392,y:506,duration:.45,ease:"power2.inOut"},5.75);
  tl.to("#approve",{backgroundColor:"#2e3d3e",duration:.12},6.2);
  tl.set("#ripple",{left:400,top:514},6.26);
  tl.fromTo("#ripple",{scale:0,opacity:.8},{scale:1.6,opacity:0,duration:.26,ease:"power2.out"},6.28);
  tl.to("#cursor",{opacity:0,duration:.18},6.42);

  /* 6.50-6.95 the card resolves into a saved chip */
  tl.to("#card",{opacity:0,y:-10,duration:.3,ease:"power2.in"},6.5);
  tl.fromTo("#saved",{y:10,opacity:0},{y:0,opacity:1,duration:.3,ease:"power2.out"},6.75);

  /* 7.05-7.60 breath, then payoff; final 1.9s completely still */"""

html = _shell.page(
  title="Memory, in the open",
  eyebrow="Agent memory",
  headline="Your agent remembers —<br/>and you <em>approve the words</em>.",
  window_title="Chat — Alfredo",
  stage=STAGE, script=SCRIPT, duration=9.5,
  payoff="Nothing is stored that you did not <em>see and edit</em>.",
  payoff_start=7.6, extra_css=CSS)
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html"), "w", encoding="utf-8").write(html)
print("memory-in-chat:", len(html), "bytes")
