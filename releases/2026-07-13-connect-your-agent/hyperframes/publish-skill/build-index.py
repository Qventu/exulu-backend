#!/usr/bin/env python3
"""Generate index.html with CI fonts inlined."""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
FONTS = pathlib.Path(
    "/Users/daniel.claessen/Desktop/Projects/exulu/backend/releases/_build/ci-video-fonts.css"
).read_text()

CSS = """
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1920px; height: 1080px; overflow: hidden; background: #f8f6f1; }
      body { font-family: 'Aspekta', system-ui, sans-serif; letter-spacing: -0.025em; color: #241f1a; }
      #root { position: relative; width: 1920px; height: 1080px; overflow: hidden; }
      .clip { position: absolute; inset: 0; }

      #bg-wash {
        position: absolute; inset: 0;
        background:
          radial-gradient(900px 500px at 50% -10%, rgba(111, 154, 55, 0.07), transparent 70%),
          #f8f6f1;
      }

      /* --------------------------------- hook --------------------------------- */
      #hook { display: grid; place-items: center; }
      #hook-inner { text-align: center; }
      .pill {
        display: inline-block; padding: 10px 22px; border-radius: 0;
        background: #efece4; color: #4d5757; font-size: 26px; font-weight: 500; letter-spacing: 0;
      }
      #hook h1 {
        margin: 30px auto 0; max-width: 1480px;
        font-size: 96px; font-weight: 500; letter-spacing: -0.025em; line-height: 1.06;
      }
      #hook h1 em { font-style: normal; color: #6f9a37; }

      /* ------------------------------- terminal -------------------------------- */
      #term {
        position: absolute; left: 50%; top: 122px; margin-left: -560px; width: 1120px;
        background: #222f30; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 0;
        font-family: 'RobotoMono', monospace; letter-spacing: 0;
        opacity: 0;
      }
      #term-header {
        height: 54px; display: flex; align-items: center; gap: 9px; padding: 0 22px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }
      .tdot { width: 11px; height: 11px; border-radius: 50%; background: rgba(255, 255, 255, 0.16); flex: none; }
      #term-title { margin-left: 12px; font-size: 16px; color: #9aa2a0; }
      #term-body { padding: 30px 36px 34px; font-size: 21px; line-height: 1.5; }

      .trow { display: flex; align-items: flex-start; gap: 14px; opacity: 0; }
      .caret { color: #cef79e; flex: none; }
      .ptext { color: #f4f5f2; }
      .adot {
        width: 12px; height: 12px; border-radius: 50%; background: #6f9a37;
        flex: none; margin-top: 10px;
      }
      .atext { color: #f4f5f2; }
      .rtext { color: #f4f5f2; }
      .rtext .lime { color: #cef79e; }
      .tsub { margin-left: 26px; margin-top: 8px; color: #9aa2a0; opacity: 0; }
      .tsub2 { margin-left: 76px; margin-top: 6px; }
      #act1 { margin-top: 30px; }
      #act2 { margin-top: 28px; }
      #result { margin-top: 32px; }

      /* ---------------------------- library echo card --------------------------- */
      #lib {
        position: absolute; left: 50%; top: 646px; margin-left: -560px; width: 1120px;
        background: #ffffff; border: 1px solid #e4ddd0; border-radius: 0;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
        opacity: 0;
      }
      #lib-head {
        padding: 16px 26px 0; font-family: 'RobotoMono', monospace;
        font-size: 14px; letter-spacing: 0.09em; color: #6b6560; text-transform: uppercase;
      }
      #lib-row { display: flex; align-items: center; gap: 16px; padding: 14px 26px 20px; }
      #lib-name { font-family: 'RobotoMono', monospace; font-size: 22px; color: #241f1a; letter-spacing: 0; }
      .chip {
        font-family: 'RobotoMono', monospace; font-size: 16px; letter-spacing: 0;
        padding: 4px 12px; background: #efece4; border: 1px solid #e4ddd0; border-radius: 0;
        color: #241f1a; flex: none;
      }
      #lib-spacer { flex: 1; }
      .fresh-dot { width: 9px; height: 9px; border-radius: 50%; background: #6f9a37; flex: none; }
      #lib-time { font-size: 18px; color: #55504a; }

      /* -------------------------------- payoff --------------------------------- */
      #payoff { display: grid; place-items: end center; }
      #payoff-line {
        margin-bottom: 148px; font-size: 44px; font-weight: 500; color: #241f1a;
        letter-spacing: -0.025em; opacity: 0;
      }
"""

BODY = """
    <div
      id="root"
      data-composition-id="main"
      data-start="0"
      data-width="1920"
      data-height="1080"
      data-duration="8.9"
    >
      <div id="bg" class="clip" data-start="0" data-duration="8.9" data-track-index="1">
        <div id="bg-wash"></div>
      </div>

      <div id="hook" class="clip" data-start="0" data-duration="2.0" data-track-index="2">
        <div id="hook-inner">
          <span class="pill">Skill library</span>
          <h1>Publish <em>your own</em> skills back.</h1>
        </div>
      </div>

      <div id="stage" class="clip" data-start="1.5" data-duration="7.4" data-track-index="3">
        <!-- dark agent-chat terminal -->
        <div id="term">
          <div id="term-header">
            <span class="tdot"></span><span class="tdot"></span><span class="tdot"></span>
            <span id="term-title">exulu agent &mdash; chat</span>
          </div>
          <div id="term-body">
            <div class="trow" id="line-prompt">
              <span class="caret">&#10095;</span>
              <span class="ptext">Publish my grill-me skill to the exulu library</span>
            </div>
            <div class="trow" id="act1">
              <span class="adot"></span>
              <span class="atext">Skill(exulu-skills)</span>
            </div>
            <div class="tsub" id="act1-sub">&#9083;&nbsp; Successfully loaded skill</div>
            <div class="trow" id="act2">
              <span class="adot"></span>
              <span class="atext">Ran 2 shell commands</span>
            </div>
            <div class="tsub" id="out1">&#9083;&nbsp; zipping ./skills/grill-me &hellip; 14 files</div>
            <div class="tsub tsub2" id="out2">POST /skills/registry/grill-me</div>
            <div class="trow" id="result">
              <span class="adot"></span>
              <span class="rtext">Published grill-me &mdash; <span class="lime">version 2</span> (you own this skill, so the version was bumped).</span>
            </div>
          </div>
        </div>

        <!-- light library echo card -->
        <div id="lib">
          <div id="lib-head">Exulu library</div>
          <div id="lib-row">
            <span id="lib-name">grill-me</span>
            <span class="chip">v2</span>
            <span id="lib-spacer"></span>
            <span class="fresh-dot"></span>
            <span id="lib-time">just now</span>
          </div>
        </div>
      </div>

      <div id="payoff" class="clip" data-start="7.1" data-duration="1.8" data-track-index="4">
        <div id="payoff-line">Build once. Version it. Share it.</div>
      </div>
    </div>

    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });

      /* 0.00-0.40 hook enters (fade + 12px rise); holds static until 1.55 */
      tl.fromTo("#hook-inner", { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: "power2.out" }, 0.05);

      /* 1.55-2.00 hook exits; dark terminal crossfades in */
      tl.to("#hook-inner", { y: -14, opacity: 0, duration: 0.3, ease: "power2.in" }, 1.55);
      tl.fromTo("#term", { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: "power2.out" }, 1.6);

      /* 2.15-2.45 user prompt line enters; holds 600ms before agent activity */
      tl.fromTo("#line-prompt", { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3, ease: "power2.out" }, 2.15);

      /* 3.05-4.75 agent activity lines stagger in (muted, calm) */
      tl.fromTo("#act1", { y: 6, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3, ease: "power2.out" }, 3.05);
      tl.fromTo("#act1-sub", { y: 6, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3, ease: "power2.out" }, 3.25);
      tl.fromTo("#act2", { y: 6, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3, ease: "power2.out" }, 3.65);
      tl.fromTo("#out1", { y: 6, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3, ease: "power2.out" }, 4.05);
      tl.fromTo("#out2", { y: 6, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3, ease: "power2.out" }, 4.45);

      /* 4.75-5.35 terminal holds still */

      /* 5.35-5.75 result bullet enters ("version 2" in lime); holds 600ms */
      tl.fromTo("#result", { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: "power2.out" }, 5.35);

      /* 6.35-6.80 library echo card slides up; stays through the end (2.1s) */
      tl.fromTo("#lib", { y: 26, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: "power3.out" }, 6.35);

      /* 7.25-7.65 payoff caption enters; holds 1.25s = loop resting frame */
      tl.fromTo("#payoff-line", { y: 22, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: "power2.out" }, 7.25);

      window.__timelines["main"] = tl;
    </script>
"""

html = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>Publish skill &mdash; publish your own skills back to the library</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
{FONTS}
{CSS}
    </style>
  </head>
  <body>
{BODY}
  </body>
</html>
"""

(ROOT / "index.html").write_text(html)
print("wrote", ROOT / "index.html", len(html), "chars")
