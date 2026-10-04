const COLORS = ['#4285F4', '#EA4335', '#FBBC05', '#34A853'];

/** Drifting Google-coloured signal nodes over a dark grid. Pure canvas, no assets. */
export function startLoginArt(canvas) {
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w = 0; let h = 0; let nodes = []; let raf = 0;

  function resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.round(Math.min(46, (w * h) / 16000));
    nodes = Array.from({ length: count }, (_, i) => ({
      x: Math.random() * w, y: Math.random() * h, r: 1.5 + Math.random() * 2.5,
      vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25, c: COLORS[i % 4],
    }));
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(138,160,255,.05)'; ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 44) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += 44) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    for (const n of nodes) {
      if (!reduce) { n.x += n.vx; n.y += n.vy; if (n.x < 0 || n.x > w) n.vx *= -1; if (n.y < 0 || n.y > h) n.vy *= -1; }
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
        if (d < 130) { ctx.strokeStyle = nodes[i].c; ctx.globalAlpha = (1 - d / 130) * 0.28; ctx.beginPath(); ctx.moveTo(nodes[i].x, nodes[i].y); ctx.lineTo(nodes[j].x, nodes[j].y); ctx.stroke(); }
      }
    }
    for (const n of nodes) {
      ctx.globalAlpha = 0.9; ctx.fillStyle = n.c; ctx.shadowColor = n.c; ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    if (!reduce) raf = requestAnimationFrame(draw);
  }

  resize(); draw();
  addEventListener('resize', () => { cancelAnimationFrame(raf); resize(); draw(); });
  return () => cancelAnimationFrame(raf);
}
