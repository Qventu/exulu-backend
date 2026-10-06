"""Shared stage chrome for the 2026-10-06 shorts. WEBSITE CI (see plan/design.md)."""
import json, os

ROOT = os.path.dirname(os.path.abspath(__file__))
FONTS = open(os.path.join(ROOT, "../../_build/ci-video-fonts.css"), encoding="utf-8").read()

BASE_CSS = """
*{margin:0;padding:0;box-sizing:border-box}
body{width:1920px;height:1080px;overflow:hidden;background:#f8f6f1;
 font-family:'Aspekta',system-ui,sans-serif;letter-spacing:-0.025em;color:#241f1a}
#bg{position:absolute;inset:0;background:#f8f6f1}
#bg::after{content:"";position:absolute;inset:0;
 background:radial-gradient(900px 440px at 50% 0%,rgba(111,154,55,0.07),transparent 70%)}
#hook{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
#hook-inner{text-align:center}
.eyebrow{display:inline-flex;align-items:center;gap:10px;background:#fff;border:1px solid #e4ddd0;
 border-radius:999px;padding:9px 18px;font-family:'RobotoMono',monospace;font-size:17px;
 letter-spacing:0.12em;color:#55504a;text-transform:uppercase}
.eyebrow i{width:9px;height:9px;border-radius:50%;background:#6f9a37;display:block}
#hook h1{margin-top:30px;font-size:86px;font-weight:500;line-height:1.07;letter-spacing:-0.03em}
#hook em{font-style:normal;background:#cef79e;padding:0 .12em;border-radius:3px}
#app{position:absolute;left:150px;top:92px;width:1620px;height:830px;background:#fbfaf7;
 border:1px solid #e4ddd0;border-radius:10px;
 box-shadow:0 24px 60px rgba(36,31,26,.10),0 2px 8px rgba(36,31,26,.06);overflow:hidden}
.bar{height:52px;border-bottom:1px solid #efece4;display:flex;align-items:center;padding:0 20px;gap:9px}
.bar i{width:11px;height:11px;border-radius:50%;background:#e4ddd0;display:block}
.bar span{margin-left:14px;font-size:15px;color:#6b6560}
#stage{position:relative;height:778px}
#payoff{position:absolute;left:0;right:0;bottom:0;height:128px;background:#222f30;
 display:flex;align-items:center;justify-content:center}
#payoff p{font-size:37px;color:#f4f5f2;font-weight:400}
#payoff em{font-style:normal;color:#cef79e}
#cursor{position:absolute;opacity:0;pointer-events:none}
#ripple{position:absolute;width:46px;height:46px;border-radius:50%;background:#cef79e;
 opacity:0;transform:translate(-50%,-50%) scale(0)}
.btn{display:inline-flex;align-items:center;gap:9px;background:#222f30;color:#f4f5f2;
 border-radius:7px;padding:12px 20px;font-size:19px}
.btn.ghost{background:#fff;color:#241f1a;border:1px solid #e4ddd0}
"""

CURSOR = """<div id="ripple"></div>
   <svg id="cursor" width="26" height="30" viewBox="0 0 26 30">
    <path d="M2 2l20 12-9 2 5 10-4 2-5-10-7 6z" fill="#241f1a" stroke="#fff" stroke-width="1.6"/>
   </svg>"""

def page(title, eyebrow, headline, window_title, stage, script, duration,
         hook_end=2.5, app_start=1.9, payoff=None, payoff_start=None, extra_css=""):
    payoff_start = payoff_start if payoff_start is not None else duration - 2.3
    payoff_html = (f'''
 <div id="payoff" class="clip" data-start="{payoff_start}" data-duration="{duration-payoff_start:.2f}"
      data-track-index="4" data-layout-allow-overflow><p>{payoff}</p></div>''' if payoff else "")
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=1920, height=1080"/>
<title>{title}</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
{FONTS}{BASE_CSS}{extra_css}
</style>
</head>
<body>
<div data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-duration="{duration}">
 <div id="bg" class="clip" data-start="0" data-duration="{duration}" data-track-index="1"></div>
 <div id="hook" class="clip" data-start="0" data-duration="{hook_end}" data-track-index="2" data-layout-allow-overlap>
  <div id="hook-inner">
   <div class="eyebrow"><i></i>{eyebrow}</div>
   <h1>{headline}</h1>
  </div>
 </div>
 <div id="app" class="clip" data-start="{app_start}" data-duration="{duration-app_start:.2f}"
      data-track-index="3" data-layout-allow-occlusion>
  <div class="bar"><i></i><i></i><i></i><span>{window_title}</span></div>
  <div id="stage">
{stage}
   {CURSOR}
  </div>
 </div>{payoff_html}
 <script>
  window.__timelines = window.__timelines || {{}};
  const tl = gsap.timeline({{paused:true}});
  tl.fromTo("#hook .eyebrow",{{y:10,opacity:0}},{{y:0,opacity:1,duration:.32,ease:"power2.out"}},.05);
  tl.fromTo("#hook h1",{{y:16,opacity:0}},{{y:0,opacity:1,duration:.42,ease:"power2.out"}},.14);
  tl.to("#hook-inner",{{y:-16,opacity:0,duration:.3,ease:"power2.in"}},{app_start});
  tl.fromTo("#app",{{y:20,opacity:0}},{{y:0,opacity:1,duration:.42,ease:"power2.out"}},{app_start+0.06});
{script}
  {f'tl.fromTo("#payoff",{{y:130}},{{y:0,duration:.4,ease:"power2.out"}},{payoff_start});' if payoff else ''}
  window.__timelines["main"] = tl;
 </script>
</div>
</body>
</html>
"""

def project(slug, name):
    d = os.path.join(ROOT, slug)
    os.makedirs(d, exist_ok=True)
    json.dump({"name":slug,"private":True,"type":"module","scripts":{
      "dev":"npx --yes hyperframes@0.7.44 preview",
      "check":"npx --yes hyperframes@0.7.44 lint && npx --yes hyperframes@0.7.44 inspect",
      "render":"npx --yes hyperframes@0.7.44 render"}}, open(f"{d}/package.json","w"), indent=2)
    json.dump({"$schema":"https://hyperframes.heygen.com/schema/hyperframes.json",
      "registry":"https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
      "paths":{"blocks":"compositions","components":"compositions/components","assets":"assets"}},
      open(f"{d}/hyperframes.json","w"), indent=2)
    json.dump({"id":slug,"name":name,"createdAt":"2026-10-06T00:00:00.000Z"},
      open(f"{d}/meta.json","w"), indent=2)
    open(f"{d}/design.md","w",encoding="utf-8").write(
      open(os.path.join(ROOT,"../plan/design.md"), encoding="utf-8").read())
    return d
