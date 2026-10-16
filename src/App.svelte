<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    StixGameEngine,
    CellState,
    type StixSegment,
  } from './engine/StixGameEngine';

  let canvasEl: HTMLCanvasElement;
  let stageEl: HTMLElement;

  const engine = new StixGameEngine(1.2);

  // Reactive HUD state synced from engine each frame
  let score = $state(0);
  let highScore = $state(0);
  let lives = $state(4);
  let dimension = $state(1);
  let themeName = $state(engine.getTheme().name);
  let capturedPercent = $state(0);
  let status = $state<'playing' | 'dying' | 'life_lost' | 'dimension_complete' | 'game_over'>('playing');
  let paused = $state(false);
  let statusMessage = $state('');
  let lastBonusPoints = $state(0);
  let swoopMode = $state(false);
  let isDrawing = $state(false);
  let fuseActive = $state(false);

  // Toggles & UI modals
  let slowDrawMode = $state(false);
  let soundEnabled = $state(true);
  let showSettings = $state(false);
  let showHelp = $state(false);
  let enableQuarks = $state(true);
  let enableFuse = $state(true);
  let enableEnergyDrain = $state(true);
  let unlimitedLives = $state(false);

  // Viewport pixel dimensions
  let viewW = $state(800);
  let viewH = $state(600);
  let dpr = $state(1);

  let rafId = 0;
  let lastTime = 0;
  let accumulator = 0;
  const STEP_MS = 1000 / 60;

  // Offscreen buffers for fast territory fill and static playfield layer caching
  let territoryCanvas: HTMLCanvasElement | null = null;
  let territoryCtx: CanvasRenderingContext2D | null = null;
  let territoryImgData: ImageData | null = null;

  let staticCanvas: HTMLCanvasElement | null = null;
  let staticCtx: CanvasRenderingContext2D | null = null;
  let cachedGridVersion = -1;
  let cachedStaticW = 0;
  let cachedStaticH = 0;
  let cachedStaticDpr = 0;

  function syncHudState(): void {
    score = engine.score;
    highScore = engine.highScore;
    lives = engine.lives;
    dimension = engine.dimension;
    themeName = engine.getTheme().name;
    capturedPercent = engine.capturedPercent;
    status = engine.status;
    paused = engine.paused;
    statusMessage = engine.statusMessage;
    lastBonusPoints = engine.lastBonusPoints;
    swoopMode = engine.swoopMode;
    isDrawing = engine.isDrawing;
    fuseActive = engine.fuseActive;
  }

  function getAspectRatio(): number {
    if (!stageEl) return 1.25;
    const rect = stageEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return 1.25;
    return rect.width / rect.height;
  }

  function handleResize(): void {
    if (!stageEl || !canvasEl) return;
    const rect = stageEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    viewW = Math.floor(rect.width);
    viewH = Math.floor(rect.height);
    dpr = window.devicePixelRatio || 1;

    canvasEl.width = Math.floor(viewW * dpr);
    canvasEl.height = Math.floor(viewH * dpr);

    engine.adaptToAspectRatioIfPristine(viewW / viewH, viewW, viewH);
    syncHudState();
    renderCanvas(performance.now(), 0);
  }

  function ensureTerritoryBuffer(w: number, h: number): void {
    if (!territoryCanvas || territoryCanvas.width !== w || territoryCanvas.height !== h) {
      territoryCanvas = document.createElement('canvas');
      territoryCanvas.width = w;
      territoryCanvas.height = h;
      territoryCtx = territoryCanvas.getContext('2d');
      territoryImgData = territoryCtx ? territoryCtx.createImageData(w, h) : null;
    }
  }

  function parseRgba(color: string): [number, number, number, number] {
    if (color.startsWith('#')) {
      const hex = color.slice(1);
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return [r, g, b, 255];
    }
    const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (m) {
      return [
        parseInt(m[1], 10),
        parseInt(m[2], 10),
        parseInt(m[3], 10),
        m[4] !== undefined ? Math.round(parseFloat(m[4]) * 255) : 255,
      ];
    }
    return [56, 189, 248, 255];
  }

  function ensureStaticLayer(): void {
    const targetW = Math.floor(viewW * dpr);
    const targetH = Math.floor(viewH * dpr);
    if (
      staticCanvas &&
      staticCtx &&
      cachedGridVersion === engine.gridVersion &&
      cachedStaticW === viewW &&
      cachedStaticH === viewH &&
      cachedStaticDpr === dpr
    ) {
      return;
    }

    if (!staticCanvas || staticCanvas.width !== targetW || staticCanvas.height !== targetH) {
      staticCanvas = document.createElement('canvas');
      staticCanvas.width = targetW;
      staticCanvas.height = targetH;
      staticCtx = staticCanvas.getContext('2d');
    }
    if (!staticCtx) return;

    cachedGridVersion = engine.gridVersion;
    cachedStaticW = viewW;
    cachedStaticH = viewH;
    cachedStaticDpr = dpr;

    const sctx = staticCtx;
    const gw = engine.gridW;
    const gh = engine.gridH;
    const theme = engine.getTheme();
    const scaleX = viewW / gw;
    const scaleY = viewH / gh;
    const toScreenX = (gx: number) => (gx + 0.5) * scaleX;
    const toScreenY = (gy: number) => (gy + 0.5) * scaleY;

    sctx.save();
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, targetW, targetH);
    sctx.scale(dpr, dpr);

    // 1. Background fill
    sctx.fillStyle = theme.bg;
    sctx.fillRect(0, 0, viewW, viewH);

    // 2. Render Captured Regions & Completed Walls cleanly
    ensureTerritoryBuffer(gw, gh);
    if (territoryCtx && territoryImgData) {
      const data = territoryImgData.data;
      const fastRgba = parseRgba(theme.fastFill);
      const slowRgba = parseRgba(theme.slowFill);
      const wallRgba = parseRgba(theme.wallStroke);

      for (let i = 0; i < gw * gh; i++) {
        const p = i * 4;
        const c = engine.grid[i];
        if (c === CellState.CapturedFast) {
          data[p] = fastRgba[0];
          data[p + 1] = fastRgba[1];
          data[p + 2] = fastRgba[2];
          data[p + 3] = fastRgba[3];
        } else if (c === CellState.CapturedSlow) {
          data[p] = slowRgba[0];
          data[p + 1] = slowRgba[1];
          data[p + 2] = slowRgba[2];
          data[p + 3] = slowRgba[3];
        } else if (c === CellState.Wall) {
          data[p] = wallRgba[0];
          data[p + 1] = wallRgba[1];
          data[p + 2] = wallRgba[2];
          data[p + 3] = 255;
        } else {
          data[p + 3] = 0;
        }
      }
      territoryCtx.putImageData(territoryImgData, 0, 0);
      sctx.save();
      sctx.imageSmoothingEnabled = true;
      sctx.drawImage(territoryCanvas!, 0, 0, viewW, viewH);
      sctx.restore();
    }

    // 3. Playfield grid lines aligned to engine.gridStep
    sctx.strokeStyle = theme.gridLine;
    sctx.lineWidth = 1;
    sctx.beginPath();
    const stepGrid = engine.gridStep;
    for (let x = 1; x <= gw - 2; x += stepGrid) {
      const sx = toScreenX(x);
      sctx.moveTo(sx, toScreenY(1));
      sctx.lineTo(sx, toScreenY(gh - 2));
    }
    for (let y = 1; y <= gh - 2; y += stepGrid) {
      const sy = toScreenY(y);
      sctx.moveTo(toScreenX(1), sy);
      sctx.lineTo(toScreenX(gw - 2), sy);
    }
    sctx.stroke();

    // 4. Crisp anti-aliased vector border & wall segments
    sctx.save();
    sctx.strokeStyle = theme.wallStroke;
    sctx.shadowColor = theme.wallGlow;
    sctx.shadowBlur = 8;
    sctx.lineWidth = Math.max(2, Math.min(scaleX, scaleY) * 0.95);
    sctx.lineCap = 'round';
    sctx.lineJoin = 'round';

    // Outer frame vector rectangle
    sctx.strokeRect(
      toScreenX(1),
      toScreenY(1),
      toScreenX(gw - 2) - toScreenX(1),
      toScreenY(gh - 2) - toScreenY(1)
    );

    // Draw interior wall segments as smooth anti-aliased horizontal & vertical runs
    sctx.beginPath();
    for (let y = 2; y < gh - 2; y++) {
      let runStart = -1;
      for (let x = 1; x <= gw - 2; x++) {
        const isWall = engine.grid[engine.cellIndex(x, y)] === CellState.Wall;
        if (isWall && runStart === -1) {
          runStart = x;
        } else if (!isWall && runStart !== -1) {
          if (x - 1 > runStart) {
            sctx.moveTo(toScreenX(runStart), toScreenY(y));
            sctx.lineTo(toScreenX(x - 1), toScreenY(y));
          }
          runStart = -1;
        }
      }
      if (runStart !== -1 && gw - 2 > runStart) {
        sctx.moveTo(toScreenX(runStart), toScreenY(y));
        sctx.lineTo(toScreenX(gw - 2), toScreenY(y));
      }
    }
    for (let x = 2; x < gw - 2; x++) {
      let runStart = -1;
      for (let y = 1; y <= gh - 2; y++) {
        const isWall = engine.grid[engine.cellIndex(x, y)] === CellState.Wall;
        if (isWall && runStart === -1) {
          runStart = y;
        } else if (!isWall && runStart !== -1) {
          if (y - 1 > runStart) {
            sctx.moveTo(toScreenX(x), toScreenY(runStart));
            sctx.lineTo(toScreenX(x), toScreenY(y - 1));
          }
          runStart = -1;
        }
      }
      if (runStart !== -1 && gh - 2 > runStart) {
        sctx.moveTo(toScreenX(x), toScreenY(runStart));
        sctx.lineTo(toScreenX(x), toScreenY(gh - 2));
      }
    }
    sctx.stroke();
    sctx.restore();
    sctx.restore();
  }

  function renderCanvas(now: number, frameAlpha = 0): void {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;

    const gw = engine.gridW;
    const gh = engine.gridH;
    const theme = engine.getTheme();

    // 1-4. Blit cached static playfield layer (background, territory fills, grid lines, glowing walls)
    ensureStaticLayer();

    ctx.save();
    ctx.scale(dpr, dpr);

    if (staticCanvas) {
      ctx.drawImage(staticCanvas, 0, 0, viewW, viewH);
    }

    const scaleX = viewW / gw;
    const scaleY = viewH / gh;
    const toScreenX = (gx: number) => (gx + 0.5) * scaleX;
    const toScreenY = (gy: number) => (gy + 0.5) * scaleY;
    const playerPos = engine.getRenderPlayerPos(frameAlpha);
    const isDying = engine.status === 'dying';
    const deathProgress = isDying ? engine.getDeathProgress(frameAlpha) : 0;

    // 5. Draw Active Incomplete Player Trail as anti-aliased vector polyline
    if (engine.isDrawing && engine.trail.length >= 1) {
      if (isDying) {
        // Keep full incomplete force field visible and flashing during death animation
        ctx.save();
        const flashRed = Math.floor(deathProgress * 20) % 2 === 0;
        ctx.strokeStyle = flashRed ? '#f43f5e' : '#facc15';
        ctx.shadowColor = '#ef4444';
        ctx.shadowBlur = 14;
        ctx.lineWidth = Math.max(2.2, Math.min(scaleX, scaleY) * 0.9);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(toScreenX(engine.trail[0].x), toScreenY(engine.trail[0].y));
        for (let i = 1; i < engine.trail.length; i++) {
          ctx.lineTo(toScreenX(engine.trail[i].x), toScreenY(engine.trail[i].y));
        }
        ctx.lineTo(toScreenX(playerPos.x), toScreenY(playerPos.y));
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.save();
        ctx.strokeStyle = engine.currentTrailSlow ? '#34d399' : theme.trailStroke;
        ctx.shadowColor = engine.currentTrailSlow ? '#34d399' : theme.trailStroke;
        ctx.shadowBlur = 10;
        ctx.lineWidth = Math.max(2.2, Math.min(scaleX, scaleY) * 0.9);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(toScreenX(engine.trail[0].x), toScreenY(engine.trail[0].y));
        for (let i = 1; i < engine.trail.length; i++) {
          ctx.lineTo(toScreenX(engine.trail[i].x), toScreenY(engine.trail[i].y));
        }
        ctx.lineTo(toScreenX(playerPos.x), toScreenY(playerPos.y));
        ctx.stroke();
        ctx.restore();

        // If Fuse (Stabiliser Ripple) is active, draw the burning portion & spark head
        if (engine.fuseActive && engine.fuseIndex < engine.trail.length) {
          const fPt = engine.trail[engine.fuseIndex];
          const fx = toScreenX(fPt.x);
          const fy = toScreenY(fPt.y);

          ctx.save();
          ctx.strokeStyle = '#ef4444';
          ctx.lineWidth = Math.max(2.5, Math.min(scaleX, scaleY));
          ctx.beginPath();
          ctx.moveTo(toScreenX(engine.trail[0].x), toScreenY(engine.trail[0].y));
          for (let i = 1; i <= engine.fuseIndex; i++) {
            ctx.lineTo(toScreenX(engine.trail[i].x), toScreenY(engine.trail[i].y));
          }
          ctx.stroke();

          // Spark flare at ripple head
          const r = Math.max(5, Math.min(scaleX, scaleY) * 1.6);
          ctx.fillStyle = '#fef08a';
          ctx.shadowColor = '#ef4444';
          ctx.shadowBlur = 14;
          ctx.beginPath();
          for (let a = 0; a < 8; a++) {
            const angle = (a * Math.PI) / 4 + now * 0.015;
            const rad = a % 2 === 0 ? r * 1.5 : r * 0.45;
            const px = fx + Math.cos(angle) * rad;
            const py = fy + Math.sin(angle) * rad;
            if (a === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }
    }

    // 6. Draw the STIX (8-segment ring buffer with smooth 60 FPS gradual fade-out)
    ctx.save();
    ctx.lineCap = 'round';
    const stixSegments = engine.getInterpolatedStixSegments(frameAlpha);
    for (const seg of stixSegments) {
      const age = seg.age;
      const alpha = seg.alpha ** 1.25;
      const strokeColor = seg.swoop ? theme.stixSwoop : theme.stixPrimary;
      ctx.strokeStyle = strokeColor;
      ctx.globalAlpha = alpha;
      ctx.shadowColor = strokeColor;
      ctx.shadowBlur = age === 7 ? 14 : 6;
      ctx.lineWidth = age === 7 ? Math.max(2.6, Math.min(scaleX, scaleY) * 1.1) : Math.max(1.6, Math.min(scaleX, scaleY) * 0.75);

      ctx.beginPath();
      ctx.moveTo(toScreenX(seg.x1), toScreenY(seg.y1));
      ctx.lineTo(toScreenX(seg.x2), toScreenY(seg.y2));
      ctx.stroke();

      // Highlight newest segment endpoints
      if (age === 7) {
        ctx.fillStyle = '#ffffff';
        const epRadius = Math.max(2, Math.min(scaleX, scaleY) * 0.55);
        ctx.beginPath();
        ctx.arc(toScreenX(seg.x1), toScreenY(seg.y1), epRadius, 0, Math.PI * 2);
        ctx.arc(toScreenX(seg.x2), toScreenY(seg.y2), epRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // 7. Draw Quark & Anti-Quark patrolling the innermost boundary at 60 FPS
    if (engine.enableQuarks) {
      const renderQuarks = engine.getInterpolatedQuarks(frameAlpha);
      for (const q of renderQuarks) {
        const qx = toScreenX(q.x);
        const qy = toScreenY(q.y);
        const r = Math.max(4.5, Math.min(scaleX, scaleY) * 1.25);

        ctx.save();
        ctx.translate(qx, qy);
        ctx.rotate((now * 0.008) * (q.anti ? 1 : -1));
        ctx.strokeStyle = q.anti ? '#f43f5e' : '#38bdf8';
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = q.anti ? '#f43f5e' : '#38bdf8';
        ctx.shadowBlur = 10;
        ctx.lineWidth = 1.8;

        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const ang = (i * Math.PI) / 3;
          const rad = i % 2 === 0 ? r * 1.35 : r * 0.55;
          const vx = Math.cos(ang) * rad;
          const vy = Math.sin(ang) * rad;
          if (i === 0) ctx.moveTo(vx, vy);
          else ctx.lineTo(vx, vy);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }

    // 8. Pointer direction guide line (when pointer control is active)
    if (engine.pointerActive && engine.pointerTarget) {
      const px = toScreenX(playerPos.x);
      const py = toScreenY(playerPos.y);
      const tx = toScreenX(engine.pointerTarget.x);
      const ty = toScreenY(engine.pointerTarget.y);
      const dx = engine.pointerTarget.x - playerPos.x;
      const dy = engine.pointerTarget.y - playerPos.y;

      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, py);
      // Show the instantaneous horizontal or vertical leg chosen by the algorithm
      if (Math.abs(dx) >= Math.abs(dy)) {
        ctx.lineTo(tx, py);
      } else {
        ctx.lineTo(px, ty);
      }
      ctx.stroke();

      // Pointer target ring
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.beginPath();
      ctx.arc(tx, ty, 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 9. Draw Player ("Field Synthesiser") diamond cursor or 1s Death Animation
    const px = toScreenX(playerPos.x);
    const py = toScreenY(playerPos.y);
    const pr = Math.max(5.5, Math.min(scaleX, scaleY) * 1.45);

    if (isDying) {
      const easeOut = 1 - (1 - deathProgress) ** 2.2;
      const maxBlastRadius = Math.max(36, Math.min(viewW, viewH) * 0.11);

      ctx.save();
      ctx.translate(px, py);

      // Primary expanding shockwave ring
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - deathProgress);
      ctx.strokeStyle = '#f43f5e';
      ctx.shadowColor = '#f43f5e';
      ctx.shadowBlur = 16;
      ctx.lineWidth = Math.max(1.5, 3.5 * (1 - deathProgress * 0.7));
      ctx.beginPath();
      ctx.arc(0, 0, pr + easeOut * maxBlastRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Secondary delayed shockwave ring
      if (deathProgress > 0.15) {
        const p2 = (deathProgress - 0.15) / 0.85;
        const ease2 = 1 - (1 - p2) ** 2;
        ctx.save();
        ctx.globalAlpha = Math.max(0, (1 - p2) * 0.85);
        ctx.strokeStyle = '#facc15';
        ctx.shadowColor = '#facc15';
        ctx.shadowBlur = 12;
        ctx.lineWidth = Math.max(1, 2.5 * (1 - p2 * 0.6));
        ctx.beginPath();
        ctx.arc(0, 0, pr * 0.6 + ease2 * maxBlastRadius * 0.72, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // 16 radial vector shards & sparks flying outward
      const shardColors = ['#ffffff', '#f43f5e', '#facc15', theme.wallStroke];
      const shardCount = 16;
      for (let i = 0; i < shardCount; i++) {
        const baseAngle = (i * Math.PI * 2) / shardCount + (i % 2 === 0 ? 0.12 : -0.08);
        const speedMult = i % 3 === 0 ? 1.15 : i % 2 === 0 ? 0.85 : 0.6;
        const dist = easeOut * maxBlastRadius * speedMult;
        const sx = Math.cos(baseAngle) * dist;
        const sy = Math.sin(baseAngle) * dist;
        const shardScale = Math.max(0, 1 - deathProgress * 0.9);
        const color = shardColors[i % shardColors.length];

        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(baseAngle + deathProgress * (i % 2 === 0 ? 7 : -7));
        ctx.globalAlpha = Math.max(0, 1 - deathProgress ** 1.4);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;

        if (i % 2 === 0) {
          // Spinning diamond fragment
          const sr = pr * 0.48 * shardScale;
          ctx.beginPath();
          ctx.moveTo(0, -sr);
          ctx.lineTo(sr * 0.7, 0);
          ctx.lineTo(0, sr);
          ctx.lineTo(-sr * 0.7, 0);
          ctx.closePath();
          ctx.fill();
        } else {
          // Vector streak spark
          const len = pr * 1.15 * shardScale;
          ctx.lineWidth = 2;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(-len * 0.5, 0);
          ctx.lineTo(len * 0.5, 0);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Central synthesiser core rapidly spinning, flashing & collapsing
      if (deathProgress < 0.85) {
        const coreProgress = deathProgress / 0.85;
        const coreRadius = pr * (1 + Math.sin(coreProgress * Math.PI) * 0.5) * (1 - coreProgress * 0.85);
        const flashIdx = Math.floor(deathProgress * 30) % 3;
        const coreColor = flashIdx === 0 ? '#ffffff' : flashIdx === 1 ? '#f43f5e' : '#facc15';

        ctx.save();
        ctx.rotate(deathProgress * Math.PI * 6);
        ctx.globalAlpha = Math.max(0, 1 - coreProgress);
        ctx.fillStyle = coreColor;
        ctx.strokeStyle = '#ffffff';
        ctx.shadowColor = '#f43f5e';
        ctx.shadowBlur = 18;
        ctx.lineWidth = 2;

        ctx.beginPath();
        ctx.moveTo(0, -coreRadius);
        ctx.lineTo(coreRadius, 0);
        ctx.lineTo(0, coreRadius);
        ctx.lineTo(-coreRadius, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      ctx.restore();
    } else {
      // Faint energy arc around the synthesiser: full ring at 100%, shrinking symmetrically
      // from the top so the remaining arc is anchored at the bottom.
      const energyFrac = Math.max(0, Math.min(1, engine.energy / 100));
      if (energyFrac > 0) {
        const halfSpan = energyFrac * Math.PI;
        ctx.save();
        ctx.translate(px, py);
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = engine.energy < 25 ? '#f87171' : theme.wallStroke;
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(0, 0, pr * 1.9, Math.PI / 2 - halfSpan, Math.PI / 2 + halfSpan);
        ctx.stroke();
        ctx.restore();
      }

      const blink = engine.invulnerableFrames > 0 && Math.floor(engine.invulnerableFrames / 3) % 2 === 1;

      if (!blink) {
        ctx.save();
        ctx.translate(px, py);
        ctx.fillStyle = theme.playerColor;
        ctx.strokeStyle = engine.isDrawing
          ? engine.currentTrailSlow
            ? '#34d399'
            : theme.trailStroke
          : theme.wallStroke;
        ctx.shadowColor = ctx.strokeStyle;
        ctx.shadowBlur = 12;
        ctx.lineWidth = 2.2;

        ctx.beginPath();
        ctx.moveTo(0, -pr);
        ctx.lineTo(pr, 0);
        ctx.lineTo(0, pr);
        ctx.lineTo(-pr, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Inner core dot
        ctx.fillStyle = '#090b12';
        ctx.beginPath();
        ctx.arc(0, 0, pr * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    ctx.restore();
  }

  function loop(now: number): void {
    if (!lastTime) lastTime = now;
    const rawDelta = Math.min(100, now - lastTime);
    lastTime = now;

    if (engine.paused) {
      accumulator = 0;
    } else if (Math.abs(rawDelta - STEP_MS) < 2.5 && accumulator < STEP_MS * 0.5) {
      // Snap near-60Hz VSync intervals (59.94Hz / 60Hz jitter) cleanly to 1 tick per frame
      accumulator = 0;
      engine.tick();
    } else {
      accumulator += rawDelta;
      while (accumulator >= STEP_MS) {
        accumulator -= STEP_MS;
        engine.tick();
      }
    }

    const frameAlpha = engine.paused ? 0 : accumulator / STEP_MS;
    syncHudState();
    renderCanvas(now, frameAlpha);
    rafId = requestAnimationFrame(loop);
  }

  // Pointer Events: convert client coordinates to logical grid coordinates
  function updatePointerLocation(e: PointerEvent): void {
    if (!canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    const normX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const normY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    engine.pointerTarget = {
      x: Math.max(1, Math.min(engine.gridW - 2, normX * engine.gridW - 0.5)),
      y: Math.max(1, Math.min(engine.gridH - 2, normY * engine.gridH - 0.5)),
    };
  }

  function onPointerDown(e: PointerEvent): void {
    if (engine.status !== 'playing' || engine.paused) return;
    canvasEl.setPointerCapture(e.pointerId);
    engine.pointerActive = true;
    updatePointerLocation(e);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!engine.pointerActive) return;
    updatePointerLocation(e);
  }

  function onPointerUp(e: PointerEvent): void {
    if (canvasEl && canvasEl.hasPointerCapture(e.pointerId)) {
      canvasEl.releasePointerCapture(e.pointerId);
    }
    engine.pointerActive = false;
  }

  function togglePause(): void {
    if (engine.status !== 'playing') return;
    engine.togglePause();
    syncHudState();
  }

  function onWindowBlur(): void {
    if (engine.status === 'playing' && !engine.paused) {
      engine.setPaused(true);
      syncHudState();
    }
  }

  function onVisibilityChange(): void {
    if (document.hidden && engine.status === 'playing' && !engine.paused) {
      engine.setPaused(true);
      syncHudState();
    }
  }

  // Keyboard Events
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (showHelp) {
        showHelp = false;
      } else if (engine.status === 'playing') {
        engine.togglePause();
        syncHudState();
      }
      e.preventDefault();
      return;
    }

    if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
      engine.setDirectionKey('up', true, e.repeat);
      e.preventDefault();
    } else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
      engine.setDirectionKey('down', true, e.repeat);
      e.preventDefault();
    } else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
      engine.setDirectionKey('left', true, e.repeat);
      e.preventDefault();
    } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
      engine.setDirectionKey('right', true, e.repeat);
      e.preventDefault();
    } else if (e.key === 'Shift') {
      if (!engine.paused) engine.keysHeld.slow = true;
    } else if (e.key === ' ') {
      if (engine.status === 'playing' && engine.paused) {
        engine.setPaused(false);
        syncHudState();
      } else {
        engine.keysHeld.fast = true;
        if (engine.status === 'life_lost') {
          engine.respawnAfterLifeLost();
        } else if (engine.status === 'dimension_complete') {
          engine.nextDimension(getAspectRatio(), viewW, viewH);
        } else if (engine.status === 'game_over') {
          engine.startNewGame(getAspectRatio(), viewW, viewH);
        }
      }
      e.preventDefault();
    } else if (e.key === 'Enter') {
      if (engine.status === 'playing' && engine.paused) {
        engine.setPaused(false);
        syncHudState();
      } else if (engine.status === 'life_lost') {
        engine.respawnAfterLifeLost();
      } else if (engine.status === 'dimension_complete') {
        engine.nextDimension(getAspectRatio(), viewW, viewH);
      } else if (engine.status === 'game_over') {
        engine.startNewGame(getAspectRatio(), viewW, viewH);
      }
    } else if (e.key === 'F5') {
      e.preventDefault();
      engine.startNewGame(getAspectRatio(), viewW, viewH);
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
      engine.setDirectionKey('up', false);
    } else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
      engine.setDirectionKey('down', false);
    } else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
      engine.setDirectionKey('left', false);
    } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
      engine.setDirectionKey('right', false);
    } else if (e.key === 'Shift') {
      engine.keysHeld.slow = false;
    } else if (e.key === ' ') {
      engine.keysHeld.fast = false;
    }
  }

  function toggleSlowMode(): void {
    slowDrawMode = !slowDrawMode;
    engine.slowDrawMode = slowDrawMode;
  }

  function toggleSound(): void {
    soundEnabled = !soundEnabled;
    engine.sound.enabled = soundEnabled;
    if (!soundEnabled) engine.sound.stopFuse();
  }

  function applySettings(): void {
    engine.enableQuarks = enableQuarks;
    engine.enableFuse = enableFuse;
    engine.enableEnergyDrain = enableEnergyDrain;
    engine.unlimitedLives = unlimitedLives;
  }

  let resizeObserver: ResizeObserver | null = null;

  onMount(() => {
    handleResize();
    engine.initDimension(getAspectRatio(), true, viewW, viewH);
    syncHudState();

    resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    if (stageEl) resizeObserver.observe(stageEl);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    rafId = requestAnimationFrame(loop);
  });

  onDestroy(() => {
    if (rafId) cancelAnimationFrame(rafId);
    if (resizeObserver) resizeObserver.disconnect();
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onWindowBlur);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    engine.sound.stopFuse();
  });
</script>

<div class="app-shell">
  <!-- TOP HTML HUD -->
  <header class="hud-bar">
    <div class="brand">
      <span class="logo">STIX</span>
      <span class="dim-pill">{themeName}</span>
    </div>

    <div class="metrics">
      <div class="metric-card">
        <span class="metric-label">SCORE</span>
        <span class="metric-value">{String(score).padStart(6, '0')}</span>
      </div>

      <div class="metric-card">
        <span class="metric-label">HIGH</span>
        <span class="metric-value muted">{String(highScore).padStart(6, '0')}</span>
      </div>

      <div class="metric-card wide captured-card">
        <div class="bar-header">
          <span class="metric-label">CAPTURED</span>
          <span class="metric-value small">{capturedPercent}% <span class="target">/ 75%</span></span>
        </div>
        <div class="progress-track">
          <div
            class="progress-fill"
            style="width: {Math.min(100, (capturedPercent / 75) * 100)}%"
          ></div>
        </div>
      </div>

      <div class="metric-card">
        <span class="metric-label">SYNTHESISERS</span>
        <div class="lives-row" title="{lives} remaining">
          {#if unlimitedLives}
            <span class="inf-badge">∞</span>
          {:else}
            {#each Array.from({ length: Math.max(0, lives) }) as _}
              <span class="life-diamond"></span>
            {/each}
          {/if}
        </div>
      </div>
    </div>

    <div class="actions">
      <button
        class="btn-toggle"
        class:active={paused}
        onclick={togglePause}
        disabled={status !== 'playing'}
        title="Pause / Resume Game (Esc)"
      >
        {paused ? '▶ Resume' : '⏸ Pause'}
      </button>
      <button
        class="btn-toggle"
        class:active={slowDrawMode}
        onclick={toggleSlowMode}
        title="Toggle drawing speed: Slow awards 20 pts/%, Fast awards 2 pts/% (or hold Shift)"
      >
        {slowDrawMode ? 'Slow Draw (20×)' : 'Fast Draw (2×)'}
      </button>
      <button class="btn-icon" onclick={toggleSound} title="Toggle Sound">
        {soundEnabled ? '🔊' : '🔇'}
      </button>
      <button class="btn-icon" onclick={() => (showSettings = !showSettings)} title="Trainer & Options">
        ⚙️
      </button>
      <button class="btn-icon" onclick={() => (showHelp = !showHelp)} title="Instructions">
        ?
      </button>
    </div>
  </header>

  <!-- TRAINER / OPTIONS DRAWER -->
  {#if showSettings}
    <div class="drawer">
      <div class="drawer-inner">
        <strong>STIX +5 Trainer &amp; Options:</strong>
        <label>
          <input type="checkbox" bind:checked={enableQuarks} onchange={applySettings} />
          Quark &amp; Anti-Quark
        </label>
        <label>
          <input type="checkbox" bind:checked={enableFuse} onchange={applySettings} />
          Stabiliser Ripple (Fuse)
        </label>
        <label>
          <input type="checkbox" bind:checked={enableEnergyDrain} onchange={applySettings} />
          Energy Cell Drain
        </label>
        <label>
          <input type="checkbox" bind:checked={unlimitedLives} onchange={applySettings} />
          Unlimited Synthesisers
        </label>
        <button class="btn-small" onclick={() => engine.nextDimension(getAspectRatio(), viewW, viewH)}>
          Skip Dimension &rarr;
        </button>
      </div>
    </div>
  {/if}

  <!-- ADAPTIVE GAME STAGE -->
  <main class="stage-container" bind:this={stageEl}>
    <canvas
      bind:this={canvasEl}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
    ></canvas>

    <!-- STATUS PILL OVERLAY -->
    <div class="corner-status">
      {#if swoopMode}
        <span class="status-badge swoop">STIX SWOOPING</span>
      {/if}
      {#if fuseActive}
        <span class="status-badge fuse">STABILISER RIPPLE!</span>
      {/if}
    </div>

    <!-- MODAL OVERLAYS (HTML) -->
    {#if status === 'life_lost'}
      <div class="overlay">
        <div class="modal">
          <h2>Synthesiser Disintegrated</h2>
          <p>{statusMessage}</p>
          <p class="sub">
            Remaining Field Synthesisers: <strong>{unlimitedLives ? '∞' : lives}</strong>
          </p>
          <button class="btn-primary" onclick={() => engine.respawnAfterLifeLost()}>
            Continue (Space / Enter)
          </button>
        </div>
      </div>
    {:else if status === 'dimension_complete'}
      <div class="overlay">
        <div class="modal success">
          <h2>{statusMessage}</h2>
          <p>
            Hypersquare threshold (75%) exceeded!
            {#if lastBonusPoints > 0}
              <br />Bonus awarded: <strong>+{lastBonusPoints} pts</strong> (100 pts per 1% over 75%)
            {/if}
          </p>
          <button class="btn-primary" onclick={() => engine.nextDimension(getAspectRatio(), viewW, viewH)}>
            Enter Dimension {dimension + 1} (Space / Enter)
          </button>
        </div>
      </div>
    {:else if status === 'game_over'}
      <div class="overlay">
        <div class="modal danger">
          <h2>Game Over</h2>
          <p>{statusMessage}</p>
          <p class="sub">
            Final Score: <strong>{score}</strong> &middot; Reached Dimension <strong>{dimension}</strong>
          </p>
          <button class="btn-primary" onclick={() => engine.startNewGame(getAspectRatio(), viewW, viewH)}>
            Play Again (Space / Enter)
          </button>
        </div>
      </div>
    {:else if paused && status === 'playing'}
      <div class="overlay">
        <div class="modal">
          <h2>Game Paused</h2>
          <p class="sub">
            Press <strong>Esc</strong>, <strong>Space</strong>, or <strong>Enter</strong> to resume.
          </p>
          <button class="btn-primary" onclick={togglePause}>
            Resume (Esc)
          </button>
        </div>
      </div>
    {/if}

    {#if showHelp}
      <div class="overlay fullscreen">
        <div class="modal help-modal">
          <h2>How to Play STIX</h2>
          <ul>
            <li>
              <strong>Goal:</strong> Split the Hypersquare by constructing force fields to trap the
              <strong>Stix</strong> into smaller and smaller spaces. Capture <strong>75%</strong> of the
              space to advance to the next Dimension.
            </li>
            <li>
              <strong>Keyboard Controls:</strong> Use <strong>Arrow Keys</strong> (or <strong>WASD</strong>)
              to move along the grid lines and cut across open space. A single press moves visibly to the next
              grid line; hold to continue across grid lines. Hold <strong>Shift</strong> (or toggle
              <em>Slow Draw</em>) to build high-density fields worth <strong>20 pts per 1%</strong> (vs.
              <strong>2 pts per 1%</strong> at fast speed). Press <strong>Esc</strong> to pause/resume.
            </li>
            <li>
              <strong>Pointer / Touch Controls:</strong> Press and drag anywhere on the playfield. The
              synthesiser moves strictly along grid lines toward your pointer at the authentic capped speed.
            </li>
            <li>
              <strong>Hazards:</strong>
              <ul>
                <li>If the <strong>Stix</strong> touches your incomplete force field, your synthesiser disintegrates.</li>
                <li>Pausing while drawing disengages the field stabiliser, sending a lethal <strong>ripple</strong> down your trail.</li>
                <li>A <strong>Quark</strong> and <strong>Anti-Quark</strong> patrol the innermost boundary in opposite directions.</li>
              </ul>
            </li>
          </ul>
          <button class="btn-primary" onclick={() => (showHelp = false)}>Got It</button>
        </div>
      </div>
    {/if}
  </main>

  <footer class="footer-bar">
    <span>
      <strong>Controls:</strong> Arrow Keys / WASD (Hold <kbd>Shift</kbd> for 20× Slow Draw, <kbd>Esc</kbd> Pause) &middot; or Click/Touch &amp; Drag
    </span>
  </footer>
</div>

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #07090f;
    color: #e2e8f0;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    user-select: none;
    -webkit-user-select: none;
  }

  .app-shell {
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
  }

  .hud-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.55rem 1rem;
    background: #0f1320;
    border-bottom: 1px solid #1e293b;
    flex-wrap: wrap;
    z-index: 10;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.65rem;
  }

  .logo {
    font-size: 1.35rem;
    font-weight: 800;
    letter-spacing: 0.12em;
    background: linear-gradient(135deg, #38bdf8, #4ade80);
    background-clip: text;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .dim-pill {
    font-size: 0.78rem;
    color: #94a3b8;
    background: #181f32;
    border: 1px solid #28324e;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    white-space: nowrap;
  }

  .metrics {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    flex-wrap: wrap;
  }

  .metric-card {
    display: flex;
    flex-direction: column;
    background: #141929;
    border: 1px solid #232d45;
    border-radius: 6px;
    padding: 0.25rem 0.65rem;
    min-width: 84px;
  }

  .metric-card.wide {
    min-width: 138px;
  }

  .bar-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.4rem;
  }

  .metric-label {
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: #64748b;
  }

  .metric-value {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.98rem;
    font-weight: 700;
    color: #f8fafc;
  }

  .metric-value.muted {
    color: #94a3b8;
  }

  .metric-value.small {
    font-size: 0.82rem;
  }

  .target {
    color: #64748b;
    font-weight: 500;
  }

  .progress-track {
    width: 100%;
    height: 6px;
    background: #090c15;
    border-radius: 999px;
    overflow: hidden;
    margin-top: 0.2rem;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #38bdf8, #4ade80);
    transition: width 0.15s ease-out;
  }

  .lives-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    height: 1.2rem;
  }

  .life-diamond {
    width: 9px;
    height: 9px;
    background: #f8fafc;
    border: 1.5px solid #38bdf8;
    transform: rotate(45deg);
    box-shadow: 0 0 6px rgba(56, 189, 248, 0.7);
  }

  .inf-badge {
    font-size: 1rem;
    font-weight: 700;
    color: #4ade80;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }

  button {
    font-family: inherit;
    font-size: 0.82rem;
    font-weight: 600;
    border-radius: 6px;
    border: 1px solid #2d3a58;
    background: #182034;
    color: #e2e8f0;
    padding: 0.4rem 0.7rem;
    cursor: pointer;
    transition: all 0.15s;
  }

  button:hover {
    border-color: #38bdf8;
    color: #ffffff;
  }

  .btn-toggle.active {
    background: rgba(52, 211, 153, 0.18);
    border-color: #34d399;
    color: #34d399;
  }

  .btn-icon {
    padding: 0.4rem 0.55rem;
  }

  .drawer {
    background: #131826;
    border-bottom: 1px solid #26314d;
    padding: 0.5rem 1rem;
    font-size: 0.84rem;
  }

  .drawer-inner {
    display: flex;
    align-items: center;
    gap: 1.2rem;
    flex-wrap: wrap;
  }

  .drawer label {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    cursor: pointer;
    color: #cbd5e1;
  }

  .btn-small {
    padding: 0.25rem 0.6rem;
    font-size: 0.78rem;
  }

  .stage-container {
    position: relative;
    flex: 1;
    width: 100%;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #07090f;
  }

  canvas {
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none;
    cursor: crosshair;
  }

  .corner-status {
    position: absolute;
    top: 0.75rem;
    left: 1rem;
    display: flex;
    gap: 0.5rem;
    pointer-events: none;
  }

  .status-badge {
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    padding: 0.25rem 0.6rem;
    border-radius: 4px;
  }

  .status-badge.swoop {
    background: rgba(244, 63, 94, 0.2);
    color: #fda4af;
    border: 1px solid rgba(244, 63, 94, 0.5);
  }

  .status-badge.fuse {
    background: rgba(239, 68, 68, 0.25);
    color: #fef08a;
    border: 1px solid #ef4444;
  }

  .overlay {
    position: absolute;
    inset: 0;
    background: rgba(7, 9, 15, 0.76);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    z-index: 20;
  }

  .overlay.fullscreen {
    position: fixed;
    z-index: 100;
  }

  .modal {
    background: #121726;
    border: 1px solid #2e3b5e;
    border-radius: 12px;
    padding: 1.75rem 2rem;
    max-width: 480px;
    width: 100%;
    text-align: center;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.65);
  }

  .modal.success {
    border-color: #34d399;
  }

  .modal.danger {
    border-color: #f87171;
  }

  .modal.help-modal {
    max-width: 580px;
    max-height: 100%;
    overflow-y: auto;
    box-sizing: border-box;
    text-align: left;
  }

  .modal h2 {
    margin: 0 0 0.6rem;
    font-size: 1.45rem;
    color: #ffffff;
  }

  .modal p {
    color: #cbd5e1;
    line-height: 1.55;
    margin: 0.5rem 0;
  }

  .modal .sub {
    font-size: 0.92rem;
    color: #94a3b8;
    margin-bottom: 1.25rem;
  }

  .modal ul {
    color: #cbd5e1;
    font-size: 0.92rem;
    line-height: 1.55;
    padding-left: 1.25rem;
  }

  .modal li {
    margin-bottom: 0.45rem;
  }

  .btn-primary {
    background: linear-gradient(135deg, #0284c7, #2563eb);
    border-color: #38bdf8;
    color: #ffffff;
    padding: 0.6rem 1.25rem;
    font-size: 0.92rem;
    margin-top: 0.5rem;
  }

  .btn-primary:hover {
    filter: brightness(1.12);
  }

  .footer-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.35rem 1rem;
    background: #0b0e18;
    border-top: 1px solid #1e293b;
    font-size: 0.78rem;
    color: #64748b;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  @media (max-width: 768px), (orientation: landscape) and (max-height: 500px) {
    .footer-bar,
    .captured-card {
      display: none;
    }
  }

  kbd {
    background: #1e293b;
    color: #cbd5e1;
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    font-size: 0.74rem;
  }
</style>

