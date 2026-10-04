export function createOrb(canvas) {
  const ctx = canvas.getContext("2d");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let level = 0,
    phase = "idle",
    tick = 0;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = 520 * dpr;
  canvas.height = 520 * dpr;
  ctx.scale(dpr, dpr);
  function draw() {
    tick += reduced ? 0 : 0.012;
    ctx.clearRect(0, 0, 520, 520);
    const moving = ["speaking", "hearing"].includes(phase) ? 0.035 : 0.008;
    const r = 177 * (1 + Math.sin(tick * 1.7) * moving + level * 0.035);
    ctx.save();
    ctx.translate(260, 244);
    const glow = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, r * 1.35);
    glow.addColorStop(0, "#bdb6e938");
    glow.addColorStop(0.65, "#bdb6e919");
    glow.addColorStop(1, "#bdb6e900");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.clip();
    const fill = ctx.createRadialGradient(
      -r * 0.38,
      -r * 0.45,
      0,
      r * 0.18,
      r * 0.3,
      r * 1.38,
    );
    fill.addColorStop(0, "#ecedf9");
    fill.addColorStop(0.26, "#cdd9f1");
    fill.addColorStop(0.52, "#b2bddf");
    fill.addColorStop(0.75, "#b4a2d3");
    fill.addColorStop(1, "#d4bee0");
    ctx.fillStyle = fill;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    for (let i = 0; i < 7; i++) {
      const y = Math.sin(tick * 0.7 + i * 2.4) * r * 0.4;
      const gradient = ctx.createRadialGradient(
        Math.cos(i + tick * 0.4) * r * 0.45,
        y,
        0,
        0,
        0,
        r * 1.3,
      );
      gradient.addColorStop(
        0,
        ["#95bdec70", "#b3e2e950", "#d2afe572", "#a9a0d970"][i % 4],
      );
      gradient.addColorStop(1, "#ddd0e500");
      ctx.fillStyle = gradient;
      ctx.fillRect(-r, -r, r * 2, r * 2);
    }
    for (let band = 0; band < 24; band++) {
      const latitude = (band / 23 - 0.5) * Math.PI;
      const radius = Math.cos(latitude) * r;
      ctx.beginPath();
      for (let j = 0; j <= 120; j++) {
        const angle = (j / 120) * Math.PI * 2;
        const x = Math.cos(angle) * radius;
        const y =
          Math.sin(latitude) * r +
          Math.sin(angle) * radius * 0.23 +
          Math.sin(angle * 3 + tick + band * 0.24) * 10;
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(245,246,255,${0.045 + Math.cos(latitude) * 0.06})`;
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
    const highlight = ctx.createRadialGradient(-70, -100, 0, -70, -100, 160);
    highlight.addColorStop(0, "#ffffff72");
    highlight.addColorStop(0.5, "#ffffff18");
    highlight.addColorStop(1, "#ffffff00");
    ctx.fillStyle = highlight;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.strokeStyle = "#ffffff6b";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
    if (!document.hidden) requestAnimationFrame(draw);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) requestAnimationFrame(draw);
  });
  requestAnimationFrame(draw);
  return {
    setPhase(value) {
      phase = value;
    },
    setLevel(value) {
      level = value;
    },
  };
}
