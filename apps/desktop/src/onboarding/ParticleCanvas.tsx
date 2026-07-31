import { useEffect, useRef } from 'react';

interface Particle {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  baseAlpha: number;
  phase: number;
}

const COUNT = 46;

/**
 * ParticleCanvas — a very quiet field of drifting motes behind the
 * onboarding content. Canvas-based (not one DOM node per particle) so it
 * stays cheap regardless of window size. Fully static — a single faint
 * frame, no animation loop — under prefers-reduced-motion.
 */
export function ParticleCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let particles: Particle[] = [];
    let width = 0;
    let height = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    function seed() {
      particles = Array.from({ length: COUNT }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.6 + 0.4,
        vx: (Math.random() - 0.5) * 0.06,
        vy: -(Math.random() * 0.09 + 0.02),
        baseAlpha: Math.random() * 0.35 + 0.12,
        phase: Math.random() * Math.PI * 2,
      }));
    }

    function resize() {
      width = canvas!.clientWidth;
      height = canvas!.clientHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    }

    function drawStatic() {
      ctx!.clearRect(0, 0, width, height);
      for (const p of particles) {
        ctx!.beginPath();
        ctx!.fillStyle = `rgba(210,225,255,${p.baseAlpha * 0.6})`;
        ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx!.fill();
      }
    }

    let t = 0;
    function tick() {
      t += 1;
      ctx!.clearRect(0, 0, width, height);
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.y < -4) { p.y = height + 4; p.x = Math.random() * width; }
        if (p.x < -4) p.x = width + 4;
        if (p.x > width + 4) p.x = -4;
        const twinkle = 0.75 + 0.25 * Math.sin(t * 0.02 + p.phase);
        ctx!.beginPath();
        ctx!.fillStyle = `rgba(210,225,255,${p.baseAlpha * twinkle})`;
        ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx!.fill();
      }
      raf = requestAnimationFrame(tick);
    }

    resize();
    window.addEventListener('resize', resize);
    if (reduce) drawStatic();
    else raf = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('resize', resize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 -z-[9] h-full w-full" />;
}
