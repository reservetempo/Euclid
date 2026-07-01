// A tiny dependency-free confetti burst: spawns coloured DOM pieces that fly out
// and fall, then cleans itself up. Used to celebrate saving a sound.

const COLORS = [
  "#ff3b30", "#ff9f0a", "#ffd60a", "#34c759", "#00ffc8",
  "#0a84ff", "#6c5cff", "#bf5af2", "#ff6482", "#64d2ff",
];

export function burstConfetti(count = 90): void {
  const container = document.createElement("div");
  container.className = "confetti";

  for (let i = 0; i < count; i++) {
    const p = document.createElement("div");
    p.className = "confetti-piece";
    p.style.background = COLORS[(Math.random() * COLORS.length) | 0];

    const angle = Math.random() * Math.PI * 2;
    const dist = 120 + Math.random() * 260;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist - (140 + Math.random() * 160); // bias upward
    p.style.setProperty("--dx", `${dx.toFixed(0)}px`);
    p.style.setProperty("--dy", `${dy.toFixed(0)}px`);
    p.style.setProperty("--rot", `${((Math.random() * 720 - 360) | 0)}deg`);
    p.style.animationDelay = `${(Math.random() * 80) | 0}ms`;
    container.append(p);
  }

  document.body.append(container);
  setTimeout(() => container.remove(), 1700);
}
