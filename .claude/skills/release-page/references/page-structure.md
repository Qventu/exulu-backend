# Release page HTML structure

This is the template for the assembled `index.html` in Step 7. It's a single static HTML file that opens directly in a browser — no build step, no server. It references the rendered MP4s by relative path.

## Overall anatomy

```
<header>     ← release date pill, headline, one-paragraph summary
<main>
  <section.feature> × N
    <header>     ← feature name + one-line benefit
    <slice> × M  ← one or more slices per feature (see below)
      <video>    ← autoplay loop muted playsinline — 4–10s short, one idea
      <prose>    ← 2–3 short paragraphs, what + why for this slice
      <code>     ← optional snippet (skip for pure-UI slices)
<footer>     ← docs link, CTA, release date repeated
```

**A "slice" is one short video covering one part of the feature.** Most features are one slice. A feature with multiple notable parts (UI toggle *and* a new SDK call, say) becomes multiple slices stacked inside the same `.feature` section, each with its own video and prose. Same brand chrome, no extra section header — the feature header at the top is enough.

Aim for **dense vertical rhythm**, not generous SaaS marketing whitespace. This is a product release for users who already know the product — they're scanning for what's new.

## Brand tokens to use

Extract from `frontend/app/globals.css` (the `:root` block) every run — they change. The mapping below is the May 2026 snapshot and is illustrative only.

| CSS var | What it's for | Example (May 2026) |
|---|---|---|
| `--background` | Page background | `hsl(0 0% 99.2%)` |
| `--foreground` | Body text | `hsl(0 0% 0%)` |
| `--primary` | Headlines, accents, primary buttons | `hsl(257.94 100% 60%)` |
| `--accent` | Soft tinted backgrounds (callout blocks) | `hsl(221.4 100% 94.3%)` |
| `--muted-foreground` | Secondary text, captions | `hsl(0 0% 32.2%)` |
| `--border` | Card borders, dividers | `hsl(240 17% 92%)` |
| `--card` | Section card backgrounds | `hsl(0 0% 99.2%)` |
| `--radius` | All border-radius | `0.4rem` |
| `--font-sans` | Body, headings | `'Inter', system-ui, sans-serif` |
| `--font-mono` | Code | `'JetBrains Mono', monospace` |

Load Inter and JetBrains Mono from Google Fonts at the top of the page so the page renders correctly even when opened standalone.

## Template

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Exulu — Release &lt;DATE&gt;</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    :root {
      /* PASTE the fresh values from globals.css here */
      --background: 0 0% 99.2157%;
      --foreground: 0 0% 0%;
      --primary: 257.9412 100% 60%;
      --primary-foreground: 0 0% 100%;
      --accent: 221.3793 100% 94.3137%;
      --accent-foreground: 216.3158 76% 49.0196%;
      --muted-foreground: 0 0% 32.1569%;
      --border: 240 17.0732% 91.9608%;
      --card: 0 0% 99.2157%;
      --radius: 0.4rem;
      --tracking-tight: -0.025em;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      font-family: 'Inter', system-ui, sans-serif;
      background: hsl(var(--background));
      color: hsl(var(--foreground));
      letter-spacing: var(--tracking-tight);
      line-height: 1.5;
    }
    .wrap { max-width: 880px; margin: 0 auto; padding: 80px 24px 120px; }
    .pill {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      background: hsl(var(--accent));
      color: hsl(var(--accent-foreground));
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0;
    }
    h1.hero {
      font-size: 56px;
      font-weight: 700;
      line-height: 1.05;
      margin: 24px 0 16px;
      letter-spacing: -0.04em;
    }
    h1.hero em {
      font-style: normal;
      color: hsl(var(--primary));
    }
    .lede {
      font-size: 20px;
      color: hsl(var(--muted-foreground));
      max-width: 640px;
    }
    .feature {
      margin-top: 96px;
      padding-top: 48px;
      border-top: 1px solid hsl(var(--border));
    }
    .feature h2 {
      font-size: 32px;
      font-weight: 700;
      margin: 0 0 8px;
      letter-spacing: -0.02em;
    }
    .feature .one-liner {
      color: hsl(var(--muted-foreground));
      font-size: 18px;
      margin: 0 0 32px;
    }
    .slice { margin-top: 24px; }
    .slice + .slice { margin-top: 56px; }
    .slice video {
      width: 100%;
      border-radius: var(--radius);
      border: 1px solid hsl(var(--border));
      background: hsl(var(--accent));
      display: block;
      margin: 0 0 24px;
    }
    .slice p { margin: 0 0 16px; font-size: 16px; }
    .feature pre {
      font-family: 'JetBrains Mono', monospace;
      font-size: 13.5px;
      background: hsl(0 0% 4%);
      color: hsl(0 0% 96%);
      padding: 20px 24px;
      border-radius: var(--radius);
      overflow-x: auto;
      margin: 24px 0 0;
      line-height: 1.55;
    }
    .feature .snippet-label {
      font-size: 12px;
      font-weight: 600;
      color: hsl(var(--muted-foreground));
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin: 32px 0 8px;
    }
    footer {
      margin-top: 120px;
      padding-top: 32px;
      border-top: 1px solid hsl(var(--border));
      font-size: 14px;
      color: hsl(var(--muted-foreground));
      display: flex;
      justify-content: space-between;
    }
    footer a {
      color: hsl(var(--primary));
      text-decoration: none;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <span class="pill">Release · <!-- DATE --></span>
      <h1 class="hero">What's new in <em>Exulu</em>.</h1>
      <p class="lede"><!-- ONE-PARAGRAPH SUMMARY of the release theme (2 sentences max). --></p>
    </header>

    <main>
      <!-- Repeat the .feature block for each feature, in priority order.
           Each feature has one or more .slice blocks, one per short video. -->
      <section class="feature" id="feature-slug">
        <h2><!-- Feature name --></h2>
        <p class="one-liner"><!-- One-line benefit, the hook --></p>

        <!-- Slice 1: the headline demo for this feature -->
        <div class="slice">
          <video src="./shorts/feature-slug-1.mp4" autoplay loop muted playsinline></video>
          <p><!-- 2–3 sentences: what this slice shows, what changes for the user --></p>

          <!-- Only include the snippet block if it earns its place. -->
          <div class="snippet-label">From the SDK</div>
          <pre><code>const audio = await exulu.speech.create({
  message: "Hello from Exulu",
  voice: "alloy",
});
await audio.play();</code></pre>
        </div>

        <!-- Optional second slice for another part of the same feature.
             Most features only need one. Drop this block if not needed. -->
        <div class="slice">
          <video src="./shorts/feature-slug-2.mp4" autoplay loop muted playsinline></video>
          <p><!-- 2–3 sentences about the second slice --></p>
        </div>
      </section>
    </main>

    <footer>
      <span>Released <!-- DATE --></span>
      <a href="https://docs.exulu.com">Read the docs →</a>
    </footer>
  </div>
</body>
</html>
```

## Notes

- **One file, no build.** The user can open `index.html` directly in a browser. Don't introduce a bundler.
- **Inline the snippet language label.** Reader scans `From the SDK` / `REST` / `GraphQL` and knows which one to copy.
- **Video poster frames.** If a feature's video has a strong opening frame, generate a poster with `npx hyperframes render --image --frame 0` and add `poster="./shorts/feature-slug.jpg"` to the `<video>` so the page doesn't flash a black frame on first paint.
- **Order features by impact, not by spec date.** Lead with the most exciting change. The marquee feature gets the top slot.
- **Don't use a max-width wider than ~880px.** Long-line marketing pages feel cheap. Keep the column tight; let the videos breathe.
- **Avoid hero animations on the page itself** — the embedded videos are the motion. The page chrome should sit still so the videos do the talking.
