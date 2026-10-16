import { SoundEngine } from './sound';

export const enum CellState {
  Empty = 0,
  Stix = 1,
  Trail = 2,
  Wall = 3,
  CapturedFast = 4,
  CapturedSlow = 5,
}

export interface Point {
  x: number;
  y: number;
}

export interface StixSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  points: Point[];
  swoop: boolean;
}

export interface DimensionTheme {
  name: string;
  bg: string;
  gridLine: string;
  wallStroke: string;
  wallGlow: string;
  fastFill: string;
  slowFill: string;
  trailStroke: string;
  stixPrimary: string;
  stixSwoop: string;
  playerColor: string;
}

/** Inspired by the 8 dimension color tables at $7012..$7049 in C64 Stix */
export const DIMENSION_THEMES: DimensionTheme[] = [
  {
    name: 'Dimension I — Alpha Sector',
    bg: '#090b12',
    gridLine: 'rgba(56, 189, 248, 0.16)',
    wallStroke: '#38bdf8',
    wallGlow: 'rgba(56, 189, 248, 0.45)',
    fastFill: 'rgba(30, 64, 175, 0.52)',
    slowFill: 'rgba(16, 185, 129, 0.55)',
    trailStroke: '#facc15',
    stixPrimary: '#4ade80',
    stixSwoop: '#f43f5e',
    playerColor: '#ffffff',
  },
  {
    name: 'Dimension II — Crimson Void',
    bg: '#12080e',
    gridLine: 'rgba(244, 63, 94, 0.16)',
    wallStroke: '#fb7185',
    wallGlow: 'rgba(251, 113, 133, 0.45)',
    fastFill: 'rgba(136, 19, 55, 0.55)',
    slowFill: 'rgba(217, 119, 6, 0.55)',
    trailStroke: '#38bdf8',
    stixPrimary: '#fbbf24',
    stixSwoop: '#c084fc',
    playerColor: '#ffffff',
  },
  {
    name: 'Dimension III — Emerald Matrix',
    bg: '#06110e',
    gridLine: 'rgba(52, 211, 153, 0.16)',
    wallStroke: '#34d399',
    wallGlow: 'rgba(52, 211, 153, 0.45)',
    fastFill: 'rgba(6, 95, 70, 0.55)',
    slowFill: 'rgba(124, 58, 237, 0.55)',
    trailStroke: '#fb923c',
    stixPrimary: '#38bdf8',
    stixSwoop: '#f43f5e',
    playerColor: '#ffffff',
  },
  {
    name: 'Dimension IV — Ultraviolet Warp',
    bg: '#0d0816',
    gridLine: 'rgba(167, 139, 250, 0.16)',
    wallStroke: '#a78bfa',
    wallGlow: 'rgba(167, 139, 250, 0.45)',
    fastFill: 'rgba(76, 29, 149, 0.55)',
    slowFill: 'rgba(14, 165, 233, 0.55)',
    trailStroke: '#4ade80',
    stixPrimary: '#f472b6',
    stixSwoop: '#facc15',
    playerColor: '#ffffff',
  },
  {
    name: 'Dimension V — Solar Horizon',
    bg: '#130d06',
    gridLine: 'rgba(251, 191, 36, 0.16)',
    wallStroke: '#fbbf24',
    wallGlow: 'rgba(251, 191, 36, 0.45)',
    fastFill: 'rgba(146, 64, 14, 0.55)',
    slowFill: 'rgba(225, 29, 72, 0.55)',
    trailStroke: '#2dd4bf',
    stixPrimary: '#60a5fa',
    stixSwoop: '#f87171',
    playerColor: '#ffffff',
  },
];

export interface QuarkParticle {
  x: number;
  y: number;
  prevX?: number;
  prevY?: number;
  dir: number; // 0=Up, 1=Right, 2=Down, 3=Left
  anti: boolean;
}

export interface RenderedStixSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  swoop: boolean;
  age: number;
  alpha: number;
}

export type DirectionKey = 'up' | 'down' | 'left' | 'right';

export class StixGameEngine {
  /**
   * Logical sub-cell grid dimensions and grid line interval (`gridStep`).
   * The synthesizer moves visibly 1 logical unit per step between grid lines
   * spaced `gridStep` units apart (at coordinates 1 + k * gridStep).
   */
  public readonly gridStep = 8;
  public gridW = 163;
  public gridH = 179;
  public grid = new Uint8Array(163 * 179);
  /** Incremented whenever static grid cells (Wall / Captured regions) or dimensions change */
  public gridVersion = 0;

  // Player ("Field Synthesiser") state
  public playerX = 81;
  public playerY = 177;
  public playerPrevX = 81;
  public playerPrevY = 177;
  public launchX = 81;
  public launchY = 177;
  public isDrawing = false;
  public currentTrailSlow = false; // True if entire trail drawn in slow (20 pts/%) mode
  public trail: Point[] = [];
  private slowToggle = false;

  // Grid-locked movement state: once moving between grid lines, direction cannot change
  public activeMove: { dx: number; dy: number } | null = null;
  private pendingKeyMove: { dx: number; dy: number } | null = null;
  private lastDirectionPressed: DirectionKey | null = null;
  private holdFrames = 0;
  private readonly minHoldFrames = 11;

  // Fuse ("Field Stabiliser Ripple") state ($6C0B..$6C95)
  public fuseDelayCounter = 30; // $4B3E = $1E (30 frames = 0.5s pause before ripple starts)
  public fuseActive = false;
  public fuseIndex = 0;

  // Stix state ($4B12..$4B2C)
  public stixCoords = [100, 112, 110, 110]; // [X1, X2, Y1, Y2]
  public ringIndex = 0;
  public stixHistory: (StixSegment | null)[] = Array.from({ length: 8 }, () => null);
  public stixPrevOldest: StixSegment | null = null;
  public swoopMode = false;
  public swoopSpeed = 0;
  public swoopIndex = 0;
  public swoopTarget: Point | null = null;
  private swoopPath1: Point[] = [];
  private swoopPath2: Point[] = [];
  private stixTickAccumulator = 0;
  private frameCounter = 0;

  // Quark & Anti-Quark state ($7183..$739D)
  public quarks: QuarkParticle[] = [];
  private quarkToggle = false;

  // Game progression & scoring ($4B20..$4B45)
  public score = 0;
  public highScore = 0;
  public lives = 4; // Original starts with 4 synthesisers
  public dimension = 1;
  public capturedPercent = 0;
  public totalInteriorCells = 1;
  public capturedCells = 0;
  public energy = 100; // 0..100% synthesiser energy bar ($4B41)
  private energyTickCounter = 0;

  // Game lifecycle flags
  public status: 'playing' | 'dying' | 'life_lost' | 'dimension_complete' | 'game_over' = 'playing';
  public paused = false;
  public statusMessage = '';
  public lastBonusPoints = 0;
  public invulnerableFrames = 0;
  public readonly deathDurationFrames = 60; // 1.0 second at 60Hz
  public deathTimer = 0;
  private pendingDeathStatus: 'life_lost' | 'game_over' = 'life_lost';

  // Options / Trainer toggles (inspired by STIX+5 /REM trainer)
  public enableQuarks = true;
  public enableFuse = true;
  public enableEnergyDrain = true;
  public unlimitedLives = false;
  public slowDrawMode = false; // False = Fast (2 pts/%), True = Slow (20 pts/%)
  public allowAutoLaunch = true; // Allow arrow keys to enter empty space without holding Space

  // Input state
  public keysHeld = {
    up: false,
    down: false,
    left: false,
    right: false,
    slow: false, // Shift
    fast: false, // Space
  };
  public pointerActive = false;
  public pointerTarget: Point | null = null;

  public sound = new SoundEngine();

  constructor(aspectRatio = 1, viewW?: number, viewH?: number) {
    try {
      const saved = localStorage.getItem('stix_high_score');
      if (saved) this.highScore = parseInt(saved, 10) || 0;
    } catch {
      // ignore storage errors
    }
    this.initDimension(aspectRatio, true, viewW, viewH);
  }

  public getTheme(): DimensionTheme {
    return DIMENSION_THEMES[(this.dimension - 1) % DIMENSION_THEMES.length];
  }

  public cellIndex(x: number, y: number): number {
    return y * this.gridW + x;
  }

  public inBounds(x: number, y: number): boolean {
    return x >= 1 && x <= this.gridW - 2 && y >= 1 && y <= this.gridH - 2;
  }

  public isOnGridIntersection(x = this.playerX, y = this.playerY): boolean {
    return (x - 1) % this.gridStep === 0 && (y - 1) % this.gridStep === 0;
  }

  public setPaused(paused: boolean): void {
    if (paused) {
      if (this.status !== 'playing' || this.paused) return;
      this.paused = true;
      this.keysHeld.up = false;
      this.keysHeld.down = false;
      this.keysHeld.left = false;
      this.keysHeld.right = false;
      this.keysHeld.slow = false;
      this.keysHeld.fast = false;
      this.pendingKeyMove = null;
      this.lastDirectionPressed = null;
      this.holdFrames = 0;
      this.pointerActive = false;
      this.sound.stopFuse();
    } else {
      if (!this.paused) return;
      this.paused = false;
      if (this.status === 'playing' && this.isDrawing && this.fuseActive) {
        this.sound.startFuse();
      }
    }
  }

  public togglePause(): void {
    this.setPaused(!this.paused);
  }

  public setDirectionKey(dir: DirectionKey, pressed: boolean, repeat = false): void {
    if (this.paused && pressed) return;
    const wasHeld = this.keysHeld[dir];
    this.keysHeld[dir] = pressed;

    if (pressed) {
      if (!wasHeld || !repeat) {
        const vec =
          dir === 'up'
            ? { dx: 0, dy: -1 }
            : dir === 'down'
              ? { dx: 0, dy: 1 }
              : dir === 'left'
                ? { dx: -1, dy: 0 }
                : { dx: 1, dy: 0 };
        this.pendingKeyMove = vec;
        this.lastDirectionPressed = dir;
        this.holdFrames = 0;
      }
    } else {
      if (this.lastDirectionPressed === dir) {
        const order: DirectionKey[] = ['up', 'down', 'left', 'right'];
        this.lastDirectionPressed = order.find((k) => this.keysHeld[k]) ?? null;
      }
      if (!this.keysHeld.up && !this.keysHeld.down && !this.keysHeld.left && !this.keysHeld.right) {
        this.holdFrames = 0;
      }
    }
  }

  private randByte(): number {
    return (Math.random() * 256) | 0;
  }

  /**
   * Computes adaptive logical grid dimensions aligned to `gridStep` so that
   * outer walls (1..w-2, 1..h-2) fall strictly on grid lines and there is
   * at most one grid line every 16 CSS pixels.
   */
  public computeGridDimensions(
    aspectRatio: number,
    viewW?: number,
    viewH?: number
  ): { w: number; h: number } {
    const clampedAspect = Math.max(0.45, Math.min(2.6, aspectRatio || 1));
    const targetGeomMean = 168;
    let cols = Math.max(
      8,
      Math.round((targetGeomMean * Math.sqrt(clampedAspect)) / this.gridStep)
    );
    let rows = Math.max(
      8,
      Math.round((targetGeomMean / Math.sqrt(clampedAspect)) / this.gridStep)
    );

    if (viewW && viewH && viewW > 0 && viewH > 0) {
      // Ensure at most one grid line every 16 CSS pixels:
      // gridStep * viewW / (cols * gridStep + 3) >= 16
      const maxCols = Math.max(4, Math.floor(viewW / 16 - 3 / this.gridStep));
      const maxRows = Math.max(4, Math.floor(viewH / 16 - 3 / this.gridStep));
      if (cols > maxCols || rows > maxRows) {
        const scale = Math.min(maxCols / cols, maxRows / rows);
        cols = Math.max(4, Math.floor(cols * scale));
        rows = Math.max(4, Math.floor(rows * scale));
      }
    }

    return {
      w: cols * this.gridStep + 3,
      h: rows * this.gridStep + 3,
    };
  }

  /**
   * If no territory has been captured yet and the player isn't drawing,
   * we can seamlessly re-fit the playfield grid when the window is resized.
   */
  public adaptToAspectRatioIfPristine(
    aspectRatio: number,
    viewW?: number,
    viewH?: number
  ): boolean {
    if (
      this.capturedCells === 0 &&
      !this.isDrawing &&
      this.activeMove === null &&
      this.status === 'playing'
    ) {
      const { w, h } = this.computeGridDimensions(aspectRatio, viewW, viewH);
      if (w !== this.gridW || h !== this.gridH) {
        this.initDimension(aspectRatio, false, viewW, viewH);
        return true;
      }
    }
    return false;
  }

  public startNewGame(aspectRatio: number, viewW?: number, viewH?: number): void {
    this.score = 0;
    this.lives = 4;
    this.dimension = 1;
    this.initDimension(aspectRatio, false, viewW, viewH);
  }

  public nextDimension(aspectRatio: number, viewW?: number, viewH?: number): void {
    this.dimension++;
    this.initDimension(aspectRatio, false, viewW, viewH);
  }

  public initDimension(
    aspectRatio: number,
    resetScore = false,
    viewW?: number,
    viewH?: number
  ): void {
    if (resetScore) {
      this.score = 0;
      this.lives = 4;
      this.dimension = 1;
    }

    const { w, h } = this.computeGridDimensions(aspectRatio, viewW, viewH);
    this.gridW = w;
    this.gridH = h;
    this.grid = new Uint8Array(w * h);

    // Draw outer boundary wall at x = 1..w-2, y = 1..h-2 (aligned with gridStep)
    for (let x = 1; x <= w - 2; x++) {
      this.grid[this.cellIndex(x, 1)] = CellState.Wall;
      this.grid[this.cellIndex(x, h - 2)] = CellState.Wall;
    }
    for (let y = 1; y <= h - 2; y++) {
      this.grid[this.cellIndex(1, y)] = CellState.Wall;
      this.grid[this.cellIndex(w - 2, y)] = CellState.Wall;
    }

    this.totalInteriorCells = (w - 4) * (h - 4);
    this.capturedCells = 0;
    this.capturedPercent = 0;

    // Place player at bottom boundary center on an exact grid intersection
    const cols = Math.round((w - 3) / this.gridStep);
    this.playerX = 1 + Math.floor(cols / 2) * this.gridStep;
    this.playerY = h - 2;
    this.playerPrevX = this.playerX;
    this.playerPrevY = this.playerY;
    this.launchX = this.playerX;
    this.launchY = this.playerY;
    this.isDrawing = false;
    this.trail = [];
    this.activeMove = null;
    this.pendingKeyMove = null;
    this.holdFrames = 0;
    this.slowToggle = false;
    this.fuseActive = false;
    this.fuseIndex = 0;
    this.fuseDelayCounter = 30;
    this.sound.stopFuse();

    // Initialize Stix near center-right (matching $63E6..$63F5)
    const sx = Math.floor(w * 0.55);
    const sy = Math.floor(h * 0.55);
    this.stixCoords = [sx, Math.min(w - 4, sx + 12), sy, sy];
    this.ringIndex = 0;
    this.stixHistory = Array.from({ length: 8 }, () => null);
    this.stixPrevOldest = null;
    this.stixTickAccumulator = 0;
    this.swoopMode = false;
    this.swoopTarget = null;

    // Initialize Quark & Anti-Quark at top boundary center moving in opposite directions ($644E)
    const qx = 1 + Math.floor(cols / 2) * this.gridStep;
    const qy = 1;
    this.quarkToggle = false;
    this.quarks = [
      { x: qx, y: qy, prevX: qx, prevY: qy, dir: 3, anti: false }, // Moves Left (CCW)
      { x: qx, y: qy, prevX: qx, prevY: qy, dir: 1, anti: true },  // Moves Right (CW)
    ];

    this.energy = 100;
    this.energyTickCounter = 0;
    this.invulnerableFrames = 30;
    this.deathTimer = 0;
    this.paused = false;
    this.status = 'playing';
    this.statusMessage = '';
    this.gridVersion++;
  }

  /** C64 $6D8B: Bresenham line algorithm */
  public bresenhamLine(x0: number, y0: number, x1: number, y1: number): Point[] {
    const pts: Point[] = [];
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let x = x0;
    let y = y0;

    if (dx >= dy) {
      let err = (dx - (dy >> 1)) >> 1;
      for (let i = 0; i <= dx; i++) {
        pts.push({ x, y });
        err -= dy;
        if (err < 0) {
          err += dx;
          y += sy;
        }
        x += sx;
      }
    } else {
      let err = (dy - (dx >> 1)) >> 1;
      for (let i = 0; i <= dy; i++) {
        pts.push({ x, y });
        err -= dx;
        if (err < 0) {
          err += dy;
          x += sx;
        }
        y += sy;
      }
    }
    return pts;
  }

  /**
   * Main 60Hz frame update matching the C64 IRQ ($66B8) and main loop ($6077).
   */
  public tick(): void {
    if (this.status === 'dying') {
      this.deathTimer--;
      if (this.deathTimer <= 0) {
        this.deathTimer = 0;
        this.status = this.pendingDeathStatus;
      }
      return;
    }
    if (this.status !== 'playing' || this.paused) return;

    this.frameCounter = (this.frameCounter + 1) & 0xff;
    if (this.invulnerableFrames > 0) {
      this.invulnerableFrames--;
    }

    if (this.keysHeld.up || this.keysHeld.down || this.keysHeld.left || this.keysHeld.right) {
      this.holdFrames++;
    } else {
      this.holdFrames = 0;
    }

    // 1. Step Player movement (Keyboard or Pointer)
    this.stepPlayer();
    if (this.status !== 'playing') return;

    // 2. Step Fuse / Stabiliser Ripple ($6C41)
    if (this.enableFuse && this.isDrawing) {
      this.stepFuse();
      if (this.status !== 'playing') return;
    }

    // 3. Step Quark & Anti-Quark ($7183)
    if (this.enableQuarks) {
      this.stepQuarks();
      if (this.status !== 'playing') return;
    }

    // 4. Step Synthesiser Energy Drain ($7479)
    if (this.enableEnergyDrain) {
      this.energyTickCounter++;
      if (this.energyTickCounter >= 32) {
        this.energyTickCounter = 0;
        this.energy = Math.max(0, this.energy - 1);
        if (this.energy <= 0) {
          this.killPlayer('Synthesiser energy cells depleted!', true);
          return;
        }
      }
    }

    // 5. Step Stix ($6703) at speed proportional to dimension ($4B2C = 3 -> 2 -> 1)
    // In Dimension 1, Stix updates ~24 times/sec; Dimension 2 ~32/sec; Dimension 3+ ~42/sec
    const stixRate = this.dimension === 1 ? 0.42 : this.dimension === 2 ? 0.55 : 0.7;
    this.stixTickAccumulator += stixRate;
    while (this.stixTickAccumulator >= 1) {
      this.stixTickAccumulator -= 1;
      this.stepStix();
      if (this.status !== 'playing') return;
    }
  }

  /**
   * Determines desired orthogonal grid-line step (dx, dy) when the synthesizer is at
   * a grid intersection. Single key presses are buffered via `pendingKeyMove` so every
   * press advances at least to the next grid line, and held keys continue across grid lines.
   */
  private getCandidateMoves(): { dx: number; dy: number; allowLaunch: boolean; slow: boolean }[] {
    const slow = this.slowDrawMode || this.keysHeld.slow;
    const allowLaunchKey = this.allowAutoLaunch || this.keysHeld.fast || this.keysHeld.slow;
    const candidates: { dx: number; dy: number; allowLaunch: boolean; slow: boolean }[] = [];

    const pushUnique = (dx: number, dy: number, allowLaunch: boolean) => {
      if (!candidates.some((c) => c.dx === dx && c.dy === dy)) {
        candidates.push({ dx, dy, allowLaunch, slow });
      }
    };

    // 1. Unconsumed discrete key press takes priority so a single press always moves to the next grid line
    if (this.pendingKeyMove) {
      pushUnique(this.pendingKeyMove.dx, this.pendingKeyMove.dy, allowLaunchKey);
      this.pendingKeyMove = null;
    }

    // 2. Continuously held direction keys (once held past single-tap threshold)
    if (this.holdFrames >= this.minHoldFrames) {
      const dirOrder: DirectionKey[] = ['up', 'down', 'left', 'right'];
      if (this.lastDirectionPressed) {
        const idx = dirOrder.indexOf(this.lastDirectionPressed);
        if (idx > 0) {
          dirOrder.splice(idx, 1);
          dirOrder.unshift(this.lastDirectionPressed);
        }
      }
      for (const dir of dirOrder) {
        if (!this.keysHeld[dir]) continue;
        if (dir === 'up') pushUnique(0, -1, allowLaunchKey);
        else if (dir === 'down') pushUnique(0, 1, allowLaunchKey);
        else if (dir === 'left') pushUnique(-1, 0, allowLaunchKey);
        else if (dir === 'right') pushUnique(1, 0, allowLaunchKey);
      }
    }

    if (candidates.length > 0) {
      return candidates;
    }

    // 3. Pointer input: compare location of synthesizer vs pointer target at grid intersections
    if (this.pointerActive && this.pointerTarget) {
      const diffX = this.pointerTarget.x - this.playerX;
      const diffY = this.pointerTarget.y - this.playerY;
      const deadzone = this.gridStep * 0.5;

      if (Math.abs(diffX) < deadzone && Math.abs(diffY) < deadzone) {
        return [];
      }

      if (Math.abs(diffX) >= Math.abs(diffY)) {
        if (Math.abs(diffX) >= deadzone) {
          pushUnique(Math.sign(diffX), 0, true);
        }
        if (Math.abs(diffY) >= deadzone) {
          pushUnique(0, Math.sign(diffY), true);
        }
      } else {
        if (Math.abs(diffY) >= deadzone) {
          pushUnique(0, Math.sign(diffY), true);
        }
        if (Math.abs(diffX) >= deadzone) {
          pushUnique(Math.sign(diffX), 0, true);
        }
      }
      return candidates;
    }

    return [];
  }

  /**
   * Grid-locked player movement and trail construction.
   * Direction can only be chosen or changed on grid intersections (`isOnGridIntersection()`).
   * Between grid lines, the synthesizer moves visibly step-by-step until it reaches the next grid line.
   */
  private stepPlayer(): void {
    // Only select a new movement direction when stationary at a grid intersection
    if (this.activeMove === null) {
      const candidates = this.getCandidateMoves();
      for (const move of candidates) {
        const nx = this.playerX + move.dx;
        const ny = this.playerY + move.dy;
        const targetX = this.playerX + move.dx * this.gridStep;
        const targetY = this.playerY + move.dy * this.gridStep;
        if (!this.inBounds(nx, ny) || !this.inBounds(targetX, targetY)) continue;

        const nextCell = this.grid[this.cellIndex(nx, ny)];
        const endCell = this.grid[this.cellIndex(targetX, targetY)];

        if (nextCell === CellState.Wall) {
          if (this.isDrawing && nx === this.launchX && ny === this.launchY && this.trail.length <= 1) {
            continue;
          }
          this.activeMove = { dx: move.dx, dy: move.dy };
          break;
        } else if (nextCell === CellState.Empty || nextCell === CellState.Stix) {
          if (!this.isDrawing && !move.allowLaunch) {
            continue;
          }
          // Prevent steering into a segment whose destination grid intersection is already our own Trail
          if (endCell === CellState.Trail) {
            continue;
          }
          this.activeMove = { dx: move.dx, dy: move.dy };
          break;
        }
      }
    }

    if (this.activeMove === null) {
      this.slowToggle = false;
      this.playerPrevX = this.playerX;
      this.playerPrevY = this.playerY;
      // Player is stationary at a grid intersection; if drawing a trail, trigger fuse countdown ($6AF4 -> $6C0B)
      if (this.isDrawing && this.enableFuse && !this.fuseActive) {
        this.fuseDelayCounter--;
        if (this.fuseDelayCounter <= 0) {
          this.fuseActive = true;
          this.fuseIndex = 0;
          this.sound.startFuse();
        }
      }
      return;
    }

    // Advance visibly by 1 unit along the locked grid direction toward the next grid line
    const move = this.activeMove;
    const slow = this.slowDrawMode || this.keysHeld.slow;
    const nx = this.playerX + move.dx;
    const ny = this.playerY + move.dy;

    if (!this.inBounds(nx, ny)) {
      this.activeMove = null;
      this.slowToggle = false;
      return;
    }

    const targetCell = this.grid[this.cellIndex(nx, ny)];

    // Case 1: Moving onto an existing Wall ($6B10: BEQ $6B27)
    if (targetCell === CellState.Wall) {
      if (!this.isDrawing) {
        this.playerPrevX = this.playerX;
        this.playerPrevY = this.playerY;
        this.playerX = nx;
        this.playerY = ny;
        this.launchX = nx;
        this.launchY = ny;
        this.slowToggle = false;
        if (this.isOnGridIntersection()) {
          this.activeMove = null;
        }
        return;
      } else {
        if (slow) {
          this.slowToggle = !this.slowToggle;
          if (this.slowToggle) {
            return;
          }
        }
        this.playerPrevX = this.playerX;
        this.playerPrevY = this.playerY;
        this.playerX = nx;
        this.playerY = ny;
        this.activeMove = null;
        this.slowToggle = false;
        this.completeForceField();
        return;
      }
    }

    // Case 2: Moving into Empty Space or Stix pixel ($6B0B / $6B12)
    if (targetCell === CellState.Empty || targetCell === CellState.Stix) {
      if (targetCell === CellState.Stix) {
        if (!this.isDrawing) {
          this.isDrawing = true;
          this.currentTrailSlow = slow;
          this.launchX = this.playerX;
          this.launchY = this.playerY;
          this.trail = [{ x: this.launchX, y: this.launchY }];
        }
        this.playerPrevX = this.playerX;
        this.playerPrevY = this.playerY;
        this.playerX = nx;
        this.playerY = ny;
        this.trail.push({ x: nx, y: ny });
        this.activeMove = null;
        this.slowToggle = false;
        this.killPlayer('Your synthesiser collided directly with the Stix!');
        return;
      }

      if (!this.isDrawing) {
        this.isDrawing = true;
        this.currentTrailSlow = slow;
        this.launchX = this.playerX;
        this.launchY = this.playerY;
        this.trail = [{ x: this.launchX, y: this.launchY }];
        this.fuseActive = false;
        this.fuseIndex = 0;
        this.fuseDelayCounter = 30;
      } else {
        if (!slow) {
          // If player switches to fast mode mid-line, line scores fast rate (2 pts/%)
          this.currentTrailSlow = false;
        }
        this.fuseDelayCounter = 30;
      }

      // In Slow Draw mode ($6B64..$6B71), logical movement speed is halved (30 cells/sec),
      // while visual rendering interpolates the half-cell step on the intermediate 60Hz tick.
      if (slow) {
        this.slowToggle = !this.slowToggle;
        if (this.slowToggle) {
          return;
        }
      } else {
        this.slowToggle = false;
      }

      this.playerPrevX = this.playerX;
      this.playerPrevY = this.playerY;
      this.playerX = nx;
      this.playerY = ny;
      this.grid[this.cellIndex(nx, ny)] = CellState.Trail;
      this.trail.push({ x: nx, y: ny });

      if (this.isOnGridIntersection()) {
        this.activeMove = null;
        this.slowToggle = false;
      }
      return;
    }

    // Fallback if blocked unexpectedly
    this.activeMove = null;
    this.slowToggle = false;
  }

  /**
   * C64 $6C41..$6C95: Advances the Field Stabiliser Ripple along the incomplete trail.
   */
  private stepFuse(): void {
    if (!this.fuseActive) return;

    this.fuseIndex++;
    if (this.fuseIndex >= this.trail.length) {
      this.killPlayer('The field stabiliser ripple caught up with your synthesiser!');
    }
  }

  /**
   * C64 $7183..$739D: Moves the Quark and Anti-Quark strictly along the innermost boundary surface.
   *
   * In the original 6502 routine:
   * - Quark 1 ($719D..$71F0, CCW) checks Left turn ($72F4) then Right turn ($7316):
   *   if the turned-to cell (nx, ny) is a Wall AND the diagonal cell behind the turn
   *   (nx - dir.dx, ny - dir.dy) is open interior ($735A: Visible == 00), it takes that turn
   *   onto the inner wall. Otherwise ($71D4) it tries Straight ($7338), Left ($72F4), Right ($7316).
   * - Quark 2 ($7201..$7254, CW) runs the identical check with Right ($7316) and Left ($72F4) swapped.
   */
  private stepQuarks(): void {
    // In dimensions 1..4, Quarks move every 2nd frame; in dimension 5+, every frame ($7188)
    if (this.dimension < 5) {
      this.quarkToggle = !this.quarkToggle;
      if (this.quarkToggle) return;
    } else {
      this.quarkToggle = false;
    }

    const dirs = [
      { dx: 0, dy: -1 }, // 0: Up
      { dx: 1, dy: 0 },  // 1: Right
      { dx: 0, dy: 1 },  // 2: Down
      { dx: -1, dy: 0 }, // 3: Left
    ];

    for (const q of this.quarks) {
      q.prevX = q.x;
      q.prevY = q.y;

      const leftDir = (q.dir + 3) & 3;
      const rightDir = (q.dir + 1) & 3;
      const backDir = (q.dir + 2) & 3;

      const sideTurns = q.anti ? [rightDir, leftDir] : [leftDir, rightDir];
      let moved = false;

      // Step 1 ($71A2..$71D3 / $7206..$7237): Check perpendicular turns into an inner wall
      // where the diagonal cell behind the turn (nx - dir.dx, ny - dir.dy) is open interior ($735A).
      for (const turnDir of sideTurns) {
        const nx = q.x + dirs[turnDir].dx;
        const ny = q.y + dirs[turnDir].dy;
        const diagX = nx - dirs[q.dir].dx;
        const diagY = ny - dirs[q.dir].dy;

        if (
          this.inBounds(nx, ny) &&
          this.grid[this.cellIndex(nx, ny)] === CellState.Wall &&
          this.isOpenInterior(diagX, diagY)
        ) {
          q.x = nx;
          q.y = ny;
          q.dir = turnDir;
          moved = true;
          break;
        }
      }

      // Step 2 ($71D4..$71EA / $7238..$724E): Straight ahead, then inward turn, then outward turn
      // along any Wall cell ($7338, $72F4, $7316).
      if (!moved) {
        const fallbackOrder = [q.dir, sideTurns[0], sideTurns[1], backDir];
        for (const d of fallbackOrder) {
          const nx = q.x + dirs[d].dx;
          const ny = q.y + dirs[d].dy;
          if (
            this.inBounds(nx, ny) &&
            this.grid[this.cellIndex(nx, ny)] === CellState.Wall
          ) {
            q.x = nx;
            q.y = ny;
            q.dir = d;
            moved = true;
            break;
          }
        }
      }

      // Check collision with player ($73EC)
      if (
        this.invulnerableFrames === 0 &&
        !this.isDrawing &&
        Math.abs(q.x - this.playerX) <= 1 &&
        Math.abs(q.y - this.playerY) <= 1
      ) {
        // Respawn at the grid intersection the synthesiser was just leaving
        const departed = this.getDepartedGridIntersection();
        this.launchX = departed.x;
        this.launchY = departed.y;
        this.killPlayer(
          q.anti
            ? 'An Anti-Quark collided with your field synthesiser!'
            : 'A Quark collided with your field synthesiser!'
        );
        return;
      }
    }
  }

  /**
   * Returns the grid intersection the synthesiser most recently departed from.
   * If it is currently on an intersection, that intersection is returned; otherwise
   * the position is snapped backwards along the current movement direction.
   */
  private getDepartedGridIntersection(): Point {
    const x = this.playerX;
    const y = this.playerY;
    if (this.isOnGridIntersection(x, y)) return { x, y };

    const step = this.gridStep;
    const dx = this.activeMove?.dx ?? Math.sign(this.playerX - this.playerPrevX);
    const dy = this.activeMove?.dy ?? Math.sign(this.playerY - this.playerPrevY);
    const snap = (v: number, d: number): number => {
      const offset = (((v - 1) % step) + step) % step;
      if (offset === 0) return v;
      if (d > 0) return v - offset;
      if (d < 0) return v + (step - offset);
      // Unknown direction: snap to nearest grid line
      return offset < step / 2 ? v - offset : v + (step - offset);
    };
    return { x: snap(x, dx), y: snap(y, dy) };
  }

  private isOpenInterior(x: number, y: number): boolean {
    if (x < 0 || x >= this.gridW || y < 0 || y >= this.gridH) return false;
    const c = this.grid[this.cellIndex(x, y)];
    return c === CellState.Empty || c === CellState.Stix || c === CellState.Trail;
  }

  /**
   * C64 $6703..$6927: Exact Stix movement algorithm adapted to (gridW, gridH).
   */
  public stepStix(): void {
    const minBounds = [2, 2, 2, 2];
    const maxBounds = [this.gridW - 2, this.gridW - 2, this.gridH - 2, this.gridH - 2];

    if (this.swoopMode) {
      // $6804..$6853: Mode 1 — Advance along precomputed converging Bresenham paths
      for (let s = 0; s < this.swoopSpeed; s++) {
        this.swoopIndex++;
        const p1 = this.swoopPath1[this.swoopIndex];
        const p2 = this.swoopPath2[this.swoopIndex];
        if (!p1 || !p2) {
          this.swoopMode = false;
          this.swoopTarget = null;
          this.stepStix();
          return;
        }
        const c1 = this.grid[this.cellIndex(p1.x, p1.y)];
        if (c1 !== CellState.Empty && c1 !== CellState.Stix && c1 !== CellState.Trail) {
          this.swoopMode = false;
          this.swoopTarget = null;
          this.stepStix();
          return;
        }
        const c2 = this.grid[this.cellIndex(p2.x, p2.y)];
        if (c1 === CellState.Trail || c2 === CellState.Trail) {
          break;
        }
      }
      if (this.swoopSpeed === 0) {
        this.swoopMode = false;
        this.swoopTarget = null;
        this.stepStix();
        return;
      }
      const p1 = this.swoopPath1[this.swoopIndex];
      const p2 = this.swoopPath2[this.swoopIndex];
      this.stixCoords[0] = p1.x;
      this.stixCoords[1] = p2.x;
      this.stixCoords[2] = p1.y;
      this.stixCoords[3] = p2.y;
    } else {
      // $670D: 16/256 (6.25%) chance to trigger Mode 1 (Targeted Swoop)
      if (this.randByte() >= 0xf0) {
        const tx = 3 + Math.floor(Math.random() * (this.gridW - 6));
        const ty = 3 + Math.floor(Math.random() * (this.gridH - 6));
        const targetCell = this.grid[this.cellIndex(tx, ty)];
        if (targetCell === CellState.Empty || targetCell === CellState.Stix) {
          this.swoopTarget = { x: tx, y: ty };
          this.swoopPath1 = this.bresenhamLine(tx, ty, this.stixCoords[0], this.stixCoords[2]).reverse();
          this.swoopPath2 = this.bresenhamLine(tx, ty, this.stixCoords[1], this.stixCoords[3]).reverse();
          this.swoopIndex = 0;
          this.swoopSpeed = [2, 4, 6][(Math.random() * 3) | 0];
          this.swoopMode = true;
          this.sound.playSwoop(this.swoopSpeed);
          this.stepStix();
          return;
        }
      }

      const epStruckTrail = [false, false];

      // $6781..$6801: Mode 0 — Independent Random Endpoint Walk on Y2, Y1, X2, X1
      for (let c = 3; c >= 0; c--) {
        const ep = c & 1; // 0 for (X1, Y1), 1 for (X2, Y2)
        if (epStruckTrail[ep]) continue;

        const r = this.randByte();
        const steps = (r & 0x07) + 1; // 1..8 units
        const dir = (r & 0x80) === 0 ? 1 : -1;

        for (let s = 0; s < steps; s++) {
          this.stixCoords[c] += dir;
          if (dir > 0 && this.stixCoords[c] >= maxBounds[c]) {
            this.stixCoords[c]--;
            break;
          }
          if (dir < 0 && this.stixCoords[c] < minBounds[c]) {
            this.stixCoords[c]++;
            break;
          }

          const ex = this.stixCoords[ep];
          const ey = this.stixCoords[ep + 2];
          const cell = this.grid[this.cellIndex(ex, ey)];

          if (cell === CellState.Empty || cell === CellState.Stix) {
            continue;
          } else if (cell === CellState.Trail) {
            // Stop this endpoint directly on the trail so the drawn Stix visibly hits it
            epStruckTrail[ep] = true;
            break;
          } else {
            // Blocked by Wall or Captured region: undo 1-unit step and stop moving this coordinate
            this.stixCoords[c] -= dir;
            break;
          }
        }
      }
    }

    // $6862..$6927: Rasterize line, erase oldest segment, clip at walls, and snap endpoints
    const candidate = this.bresenhamLine(
      this.stixCoords[0],
      this.stixCoords[2],
      this.stixCoords[1],
      this.stixCoords[3]
    );

    const oldSeg = this.stixHistory[this.ringIndex];
    this.stixPrevOldest = oldSeg;
    if (oldSeg) {
      for (const pt of oldSeg.points) {
        const idx = this.cellIndex(pt.x, pt.y);
        if (this.grid[idx] === CellState.Stix) {
          this.grid[idx] = CellState.Empty;
        }
      }
    }

    const drawn: Point[] = [];
    let hitTrail = false;
    for (const pt of candidate) {
      const idx = this.cellIndex(pt.x, pt.y);
      const cell = this.grid[idx];
      if (cell === CellState.Empty) {
        this.grid[idx] = CellState.Stix;
        drawn.push(pt);
      } else if (cell === CellState.Stix) {
        drawn.push(pt);
      } else if (cell === CellState.Trail) {
        hitTrail = true;
        drawn.push(pt);
      } else {
        // Hit a Wall or Captured cell: truncate the Stix segment right before the wall!
        break;
      }
    }

    // $68F7..$6914: Self-shortening endpoint snap
    if (drawn.length >= 2) {
      this.stixCoords[0] = drawn[0].x;
      this.stixCoords[2] = drawn[0].y;
      const last = drawn[drawn.length - 1];
      this.stixCoords[1] = last.x;
      this.stixCoords[3] = last.y;
    } else if (drawn.length === 1) {
      this.stixCoords[0] = drawn[0].x;
      this.stixCoords[2] = drawn[0].y;
      this.stixCoords[1] = drawn[0].x;
      this.stixCoords[3] = drawn[0].y;
    }

    this.stixHistory[this.ringIndex] =
      drawn.length > 0
        ? {
            x1: this.stixCoords[0],
            y1: this.stixCoords[2],
            x2: this.stixCoords[1],
            y2: this.stixCoords[3],
            points: drawn,
            swoop: this.swoopMode,
          }
        : null;

    this.ringIndex = (this.ringIndex + 1) & 0x07;

    if (hitTrail) {
      const struckByEndpoint =
        this.grid[this.cellIndex(this.stixCoords[0], this.stixCoords[2])] === CellState.Trail ||
        this.grid[this.cellIndex(this.stixCoords[1], this.stixCoords[3])] === CellState.Trail;
      this.killPlayer(
        struckByEndpoint
          ? 'The Stix struck your incomplete force field!'
          : 'The Stix cut through your incomplete force field!'
      );
    }
  }

  /**
   * Returns the Stix step rate per 60Hz tick for the current dimension.
   */
  public getStixRate(): number {
    return this.dimension === 1 ? 0.42 : this.dimension === 2 ? 0.55 : 0.7;
  }

  /**
   * Returns the smooth 60 FPS visual position of the player synthesiser,
   * interpolating the half-step on intermediate Slow Draw ticks and sub-frames.
   */
  public getRenderPlayerPos(frameAlpha = 0): Point {
    const clampedAlpha = this.paused ? 0 : Math.max(0, Math.min(1, frameAlpha));
    if (this.status !== 'playing' || !this.activeMove) {
      return { x: this.playerX, y: this.playerY };
    }

    const slow = this.isDrawing && (this.slowDrawMode || this.keysHeld.slow);
    if (slow && this.slowToggle) {
      // Halfway through a 2-tick slow step toward (playerX + dx, playerY + dy)
      const stepFrac = 0.5 + clampedAlpha * 0.5;
      return {
        x: this.playerX + this.activeMove.dx * stepFrac,
        y: this.playerY + this.activeMove.dy * stepFrac,
      };
    }

    return { x: this.playerX, y: this.playerY };
  }

  /**
   * Returns the 8 Stix ribbon segments at their drawn positions with smooth
   * 60 FPS gradual fade-out across fractional `stixTickAccumulator` progress.
   */
  public getInterpolatedStixSegments(frameAlpha = 0): RenderedStixSegment[] {
    const clampedAlpha = this.paused ? 0 : Math.max(0, Math.min(1, frameAlpha));
    const t = Math.min(
      1,
      Math.max(
        0,
        this.stixTickAccumulator +
          (this.status === 'playing' ? clampedAlpha * this.getStixRate() : 0)
      )
    );

    const result: RenderedStixSegment[] = [];
    for (let age = 0; age < 8; age++) {
      const slot = (this.ringIndex + age) & 7;
      const seg = this.stixHistory[slot];
      if (!seg) continue;

      result.push({
        x1: seg.x1,
        y1: seg.y1,
        x2: seg.x2,
        y2: seg.y2,
        swoop: seg.swoop,
        age,
        alpha: Math.max(0, (age + 1 - t) / 8),
      });
    }
    return result;
  }

  /**
   * Returns the Quark and Anti-Quark positions smoothly interpolated at 60 FPS
   * along the orthogonal boundary wall segments.
   */
  public getInterpolatedQuarks(frameAlpha = 0): { x: number; y: number; anti: boolean }[] {
    const clampedAlpha = this.paused ? 0 : Math.max(0, Math.min(1, frameAlpha));
    // In dimensions 1..4, Quarks step every 2nd tick:
    // On the move tick (!quarkToggle), progress is 0.5; on the hold tick (quarkToggle), progress is 1.0.
    const t =
      this.status !== 'playing' || this.dimension >= 5
        ? 1
        : this.quarkToggle
          ? 1
          : Math.min(1, 0.5 + clampedAlpha * 0.5);

    return this.quarks.map((q) => {
      const px = q.prevX ?? q.x;
      const py = q.prevY ?? q.y;
      return {
        x: px + (q.x - px) * t,
        y: py + (q.y - py) * t,
        anti: q.anti,
      };
    });
  }

  /**
   * Converts the completed trail into a permanent wall and fills the non-Stix side(s)
   * of the split space ($60AE..$60D5, $6577, $646E).
   */
  private completeForceField(): void {
    this.sound.stopFuse();
    this.isDrawing = false;
    this.fuseActive = false;

    // 1. Convert all Trail cells to Wall
    for (const pt of this.trail) {
      this.grid[this.cellIndex(pt.x, pt.y)] = CellState.Wall;
    }
    this.trail = [];
    this.launchX = this.playerX;
    this.launchY = this.playerY;

    // 2. Flood-fill from the Stix's position to mark all cells in the Stix's enclosure
    const reachable = new Uint8Array(this.gridW * this.gridH);
    const queue = new Int32Array(this.gridW * this.gridH);
    let head = 0;
    let tail = 0;

    // Seed with Stix endpoints and any active Stix history points
    const seeds: Point[] = [
      { x: this.stixCoords[0], y: this.stixCoords[2] },
      { x: this.stixCoords[1], y: this.stixCoords[3] },
    ];
    for (const seg of this.stixHistory) {
      if (seg) {
        for (const p of seg.points) seeds.push(p);
      }
    }

    for (const s of seeds) {
      const idx = this.cellIndex(s.x, s.y);
      const cell = this.grid[idx];
      if (
        (cell === CellState.Empty || cell === CellState.Stix) &&
        reachable[idx] === 0
      ) {
        reachable[idx] = 1;
        queue[tail++] = idx;
      }
    }

    while (head < tail) {
      const curr = queue[head++];
      const cx = curr % this.gridW;
      const cy = (curr / this.gridW) | 0;

      // 4-connected flood fill
      const neighbors = [
        cx > 1 ? curr - 1 : -1,
        cx < this.gridW - 2 ? curr + 1 : -1,
        cy > 1 ? curr - this.gridW : -1,
        cy < this.gridH - 2 ? curr + this.gridW : -1,
      ];
      for (let i = 0; i < 4; i++) {
        const nIdx = neighbors[i];
        if (nIdx >= 0 && reachable[nIdx] === 0) {
          const nc = this.grid[nIdx];
          if (nc === CellState.Empty || nc === CellState.Stix) {
            reachable[nIdx] = 1;
            queue[tail++] = nIdx;
          }
        }
      }
    }

    // 3. Fill all unreachable Empty cells (the cut-off side of the split!)
    const fillType = this.currentTrailSlow ? CellState.CapturedSlow : CellState.CapturedFast;
    for (let y = 2; y <= this.gridH - 3; y++) {
      for (let x = 2; x <= this.gridW - 3; x++) {
        const idx = this.cellIndex(x, y);
        if (reachable[idx] === 0 && (this.grid[idx] === CellState.Empty || this.grid[idx] === CellState.Stix)) {
          this.grid[idx] = fillType;
        }
      }
    }

    // 4. Recount total captured interior area and award points ($653C..$6576)
    let newCaptured = 0;
    for (let y = 2; y <= this.gridH - 3; y++) {
      for (let x = 2; x <= this.gridW - 3; x++) {
        const c = this.grid[this.cellIndex(x, y)];
        if (c === CellState.Wall || c === CellState.CapturedFast || c === CellState.CapturedSlow) {
          newCaptured++;
        }
      }
    }

    const oldPercent = this.capturedPercent;
    this.capturedCells = newCaptured;
    this.capturedPercent = Math.min(99, Math.floor((newCaptured / this.totalInteriorCells) * 100));
    const pctDelta = Math.max(0, this.capturedPercent - oldPercent);

    // Original C64 scoring: 20 points per 1% for slow fill, 2 points per 1% for fast fill
    const pointsPerPct = this.currentTrailSlow ? 20 : 2;
    this.addScore( Math.max(1, pctDelta) * pointsPerPct );
    this.sound.playCapture(pctDelta, this.currentTrailSlow);
    this.gridVersion++;

    // 5. Check for Dimension Clear (>= 75% captured, $6094..$6134)
    if (this.capturedPercent >= 75) {
      const over75 = Math.max(0, this.capturedPercent - 75);
      this.lastBonusPoints = over75 * 100; // 100 bonus points per 1% above 75%
      this.addScore(this.lastBonusPoints);
      this.status = 'dimension_complete';
      this.statusMessage = `Dimension ${this.dimension} Conquered! (${this.capturedPercent}% Captured)`;
    }
  }

  private addScore(pts: number): void {
    this.score += pts;
    if (this.score > this.highScore) {
      this.highScore = this.score;
      try {
        localStorage.setItem('stix_high_score', String(this.highScore));
      } catch {
        // ignore
      }
    }
  }

  /**
   * Returns normalized 0..1 progress through the 1-second (60-frame) death animation.
   */
  public getDeathProgress(frameAlpha = 0): number {
    if (this.status !== 'dying') return 0;
    const clampedAlpha = Math.max(0, Math.min(1, frameAlpha));
    const elapsed = this.deathDurationFrames - this.deathTimer + clampedAlpha;
    return Math.max(0, Math.min(1, elapsed / this.deathDurationFrames));
  }

  /**
   * C64 $6135..$6222: Handles synthesiser destruction, triggers 1s death animation,
   * then transitions to life_lost or game_over popup.
   */
  public killPlayer(reason: string, loseAllLives = false): void {
    if (this.status === 'dying') return;

    this.sound.playExplosion();
    this.paused = false;
    this.pointerActive = false;
    this.activeMove = null;
    this.pendingKeyMove = null;
    this.holdFrames = 0;
    this.slowToggle = false;

    if (loseAllLives && !this.unlimitedLives) {
      this.lives = 0;
    } else if (!this.unlimitedLives) {
      this.lives = Math.max(0, this.lives - 1);
    }

    this.pendingDeathStatus = this.lives <= 0 ? 'game_over' : 'life_lost';
    this.deathTimer = this.deathDurationFrames;
    this.status = 'dying';
    this.statusMessage = reason;
  }

  /**
   * Continues after losing a synthesiser ($61D2..$621D):
   * Clears the incomplete trail and returns the player to (launchX, launchY).
   */
  public respawnAfterLifeLost(): void {
    for (let i = 1; i < this.trail.length; i++) {
      const pt = this.trail[i];
      const idx = this.cellIndex(pt.x, pt.y);
      if (this.grid[idx] === CellState.Trail) {
        this.grid[idx] = CellState.Empty;
      }
    }
    this.trail = [];
    this.isDrawing = false;
    this.paused = false;
    this.activeMove = null;
    this.pendingKeyMove = null;
    this.holdFrames = 0;
    this.slowToggle = false;
    this.fuseActive = false;
    this.fuseIndex = 0;
    this.fuseDelayCounter = 30;
    this.playerX = this.launchX;
    this.playerY = this.launchY;
    this.playerPrevX = this.launchX;
    this.playerPrevY = this.launchY;
    this.invulnerableFrames = 45;
    this.deathTimer = 0;
    this.status = 'playing';
    this.statusMessage = '';
  }
}

