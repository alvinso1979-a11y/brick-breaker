// BrickBreaker Classic - Game Engine
(function() {
  'use strict';

  // ============ CANVAS SETUP ============
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');

  // Polyfill for roundRect (older iOS/Safari)
  if (!ctx.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
      if (typeof r === 'number') r = [r, r, r, r];
      const [tl, tr, br, bl] = r;
      this.beginPath();
      this.moveTo(x + tl, y);
      this.lineTo(x + w - tr, y);
      this.quadraticCurveTo(x + w, y, x + w, y + tr);
      this.lineTo(x + w, y + h - br);
      this.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
      this.lineTo(x + bl, y + h);
      this.quadraticCurveTo(x, y + h, x, y + h - bl);
      this.lineTo(x, y + tl);
      this.quadraticCurveTo(x, y, x + tl, y);
      this.closePath();
      return this;
    };
  }

  const GAME_WIDTH = 390;
  const GAME_HEIGHT = 844;
  const BRICK_WIDTH = 30;
  const BRICK_HEIGHT = 16;
  const BRICK_COLS = 13;
  const PADDLE_Y = GAME_HEIGHT - 80;
  const BRICK_OFFSET_TOP = 120;
  const BRICK_OFFSET_LEFT = 0;

  function resizeCanvas() {
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const scale = Math.min(windowWidth / GAME_WIDTH, (windowHeight - 50) / GAME_HEIGHT);
    canvas.width = GAME_WIDTH;
    canvas.height = GAME_HEIGHT;
    canvas.style.width = (GAME_WIDTH * scale) + 'px';
    canvas.style.height = (GAME_HEIGHT * scale) + 'px';
    canvas.style.marginTop = '0px';
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // ============ GAME STATE ============
  const STATE = { MENU: 0, PLAYING: 1, PAUSED: 2, GAME_OVER: 3, LEVEL_CLEAR: 4, VICTORY: 5 };
  let state = STATE.MENU;
  let score = 0;
  let lives = 3;
  let level = 1;
  let bricks = [];
  let balls = [];
  let powerups = [];
  let effects = [];
  let effectTimeouts = {}; // Track active timeouts for powerup effects
  let paddle = { x: GAME_WIDTH / 2, y: PADDLE_Y, width: 120, height: 14, baseWidth: 120 };

  // ============ SPATIAL GRID (collision optimization) ============
  const GRID_CELL = 60; // Grid cell size in pixels
  let spatialGrid = {}; // gridKey -> [brickIndices]

  function buildSpatialGrid() {
    spatialGrid = {};
    for (let i = 0; i < bricks.length; i++) {
      const b = bricks[i];
      if (!b.alive) continue;
      const cellX = Math.floor(b.x / GRID_CELL);
      const cellY = Math.floor(b.y / GRID_CELL);
      const key = cellX + ',' + cellY;
      if (!spatialGrid[key]) spatialGrid[key] = [];
      spatialGrid[key].push(i);
      // Also add to neighboring cells for edge cases
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const nk = (cellX + dx) + ',' + (cellY + dy);
          if (!spatialGrid[nk]) spatialGrid[nk] = [];
          if (!spatialGrid[nk].includes(i)) spatialGrid[nk].push(i);
        }
      }
    }
  }

  function getPotentialCollisions(ball) {
    const cellX = Math.floor(ball.x / GRID_CELL);
    const cellY = Math.floor(ball.y / GRID_CELL);
    const seen = new Set();
    const candidates = [];
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const k = (cellX + dx) + ',' + (cellY + dy);
        if (spatialGrid[k]) {
          for (const idx of spatialGrid[k]) {
            if (!seen.has(idx)) { seen.add(idx); candidates.push(idx); }
          }
        }
      }
    }
    return candidates;
  }

  let lastTime = 0;
  let touchX = null;
  let highScore = parseInt(localStorage.getItem('bb_highscore') || '0');
  let levelClearTimer = 0;
  let gameOverTimer = 0;
  let menuSelection = 0; // 0=Start, 1=Continue

  // ============ AUDIO ============
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let audioCtx = null;

  function initAudio() {
    if (!audioCtx) audioCtx = new AudioCtx();
  }

  function playTone(freq, duration, type='square', volume=0.1) {
    if (!audioCtx) return;
    try {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = freq;
      osc.type = type;
      gain.gain.setValueAtTime(volume, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch(e) {}
  }

  function playBrickHit(type) {
    if (type === 3) { playTone(880, 0.1, 'sine', 0.15); playTone(1100, 0.1, 'sine', 0.1); }
    else if (type === 2) { playTone(440, 0.1, 'triangle', 0.12); }
    else { playTone(330, 0.08, 'square', 0.08); }
  }

  function playPaddleHit() { playTone(260, 0.1, 'sine', 0.12); }
  function playWallHit() { playTone(200, 0.05, 'sine', 0.05); }
  function playLifeLost() { playTone(150, 0.3, 'sawtooth', 0.15); }
  function playLevelClear() {
    [523, 659, 784, 1047].forEach((f, i) => {
      setTimeout(() => playTone(f, 0.2, 'sine', 0.15), i * 100);
    });
  }
  function playPowerup() { playTone(660, 0.15, 'sine', 0.15); playTone(880, 0.15, 'sine', 0.1); }
  function playGameOver() {
    [400, 350, 300, 200].forEach((f, i) => {
      setTimeout(() => playTone(f, 0.3, 'sawtooth', 0.12), i * 150);
    });
  }

  // ============ INPUT ============
  function getCanvasX(clientX) {
    const rect = canvas.getBoundingClientRect();
    return (clientX - rect.left) * (GAME_WIDTH / rect.width);
  }

  canvas.addEventListener('touchstart', function(e) {
    e.preventDefault();
    initAudio();
    const tx = getCanvasX(e.touches[0].clientX);
    touchX = tx;
    handleTap(tx, e.touches[0].clientY);
  }, { passive: false });

  canvas.addEventListener('touchmove', function(e) {
    e.preventDefault();
    touchX = getCanvasX(e.touches[0].clientX);
  }, { passive: false });

  canvas.addEventListener('touchend', function(e) {
    e.preventDefault();
    touchX = null;
  }, { passive: false });

  canvas.addEventListener('mousemove', function(e) {
    if (state === STATE.PLAYING) {
      touchX = getCanvasX(e.clientX);
    }
  });

  canvas.addEventListener('click', function(e) {
    initAudio();
    const tx = getCanvasX(e.clientX);
    handleTap(tx, e.clientY);
  });

  function handleTap(tx, ty) {
    if (state === STATE.MENU) {
      // Check if tap is on the START button area
      const btnY = GAME_HEIGHT * 0.55;
      const btnX = GAME_WIDTH / 2 - 80;
      const btnW = 160;
      const btnH = 50;
      if (tx >= btnX && tx <= btnX + btnW && ty >= btnY - 10 && ty <= btnY + btnH + 10) {
        startGame();
      }
    } else if (state === STATE.GAME_OVER) {
      if (gameOverTimer <= 0) {
        state = STATE.MENU;
      }
    } else if (state === STATE.LEVEL_CLEAR) {
      if (levelClearTimer <= 0) {
        nextLevel();
      }
    } else if (state === STATE.VICTORY) {
      state = STATE.MENU;
    } else if (state === STATE.PAUSED) {
      // Tap center to resume
      state = STATE.PLAYING;
    }
  }

  // ============ GAME LIFECYCLE ============
  function startGame() {
    score = 0;
    lives = 3;
    level = 1;
    effects = [];
    paddle.width = paddle.baseWidth;
    paddle.x = GAME_WIDTH / 2;
    loadLevel(level);
    state = STATE.PLAYING;
  }

  function loadLevel(lv) {
    bricks = [];
    balls = [];
    powerups = [];
    effects = [];
    // Clear all effect timeouts so they don't fire in wrong level
    Object.keys(effectTimeouts).forEach(k => { clearTimeout(effectTimeouts[k]); });
    effectTimeouts = {};

    const lvl = LEVELS[lv - 1];
    if (!lvl) { state = STATE.VICTORY; return; }

    paddle.width = lvl.paddleWidth || paddle.baseWidth;

    const rows = lvl.rows;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const rowPixels = row.length * BRICK_WIDTH;
      const offsetX = (GAME_WIDTH - rowPixels) / 2;
      for (let c = 0; c < row.length; c++) {
        const type = row[c];
        if (type === 0) continue;
        bricks.push({
          x: offsetX + c * BRICK_WIDTH,
          y: BRICK_OFFSET_TOP + r * BRICK_HEIGHT,
          w: BRICK_WIDTH,
          h: BRICK_HEIGHT,
          type: type,
          hp: type === 2 ? 2 : (type === 3 ? 1 : 1),
          maxHp: type === 2 ? 2 : 1,
          alive: true
        });
      }
    }

    // Spawn initial ball
    spawnBall(lvl.ballSpeed || 4);
  }

  function spawnBall(speed) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 0.6;
    balls.push({
      x: paddle.x,
      y: paddle.y - 10,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: 6,
      speed: speed,
      fire: false,
      multi: false
    });
  }

  function nextLevel() {
    level++;
    if (level > 50) { state = STATE.VICTORY; return; }
    // Every 5 levels show interstitial ad
    if (level % 5 === 1 && level > 1) {
      AdMob.showInterstitial(function() {});
    }
    loadLevel(level);
    state = STATE.PLAYING;
  }

  function loseLife() {
    lives--;
    playLifeLost();
    if (lives <= 0) {
      playGameOver();
      if (score > highScore) {
        highScore = score;
        localStorage.setItem('bb_highscore', highScore);
      }
      state = STATE.GAME_OVER;
      gameOverTimer = 2.0;
      AdMob.showRewarded(function(watched) {
        if (watched) { lives = 1; state = STATE.PLAYING; }
      });
    } else {
      // Reset ball
      balls = [];
      const lvl = LEVELS[level - 1];
      spawnBall(lvl ? lvl.ballSpeed : 4);
    }
  }

  // ============ POWERUP SYSTEM ============
  const POWERUP_TYPES = ['expand', 'shrink', 'multi', 'fire', 'slow'];

  function maybeDropPowerup(brick) {
    if (brick.type !== 3) return;
    if (level < 4) return; // Powerups unlock at level 4
    if (Math.random() < 0.15) {
      const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
      powerups.push({
        x: brick.x + brick.w / 2,
        y: brick.y + brick.h / 2,
        type: type,
        vy: 2,
        radius: 10,
        timer: 3
      });
    }
  }

  function applyPowerup(type) {
    playPowerup();
    const existing = effects.find(e => e.type === type);
    if (existing) existing.timeLeft = getPowerupDuration(type);

    switch(type) {
      case 'expand':
        effects.push({ type: 'expand', timeLeft: 15 });
        paddle.width = Math.min(paddle.baseWidth * 1.5, paddle.width * 1.5);
        scheduleEffect('expand', 15, function() {
          paddle.width = paddle.baseWidth;
        });
        break;
      case 'shrink':
        effects.push({ type: 'shrink', timeLeft: 10 });
        paddle.width = Math.max(paddle.baseWidth * 0.5, paddle.width * 0.7);
        scheduleEffect('shrink', 10, function() {
          paddle.width = paddle.baseWidth;
        });
        break;
      case 'multi':
        effects.push({ type: 'multi', timeLeft: -1 });
        if (balls.length < 3) {
          const b = balls[0];
          if (b) {
            balls.push({ x: b.x, y: b.y, vx: b.vx * 0.9, vy: b.vy * 0.9, radius: b.radius, speed: b.speed, fire: b.fire, multi: true });
            balls.push({ x: b.x, y: b.y, vx: -b.vx * 0.9, vy: b.vy * 0.9, radius: b.radius, speed: b.speed, fire: b.fire, multi: true });
          }
        }
        break;
      case 'fire':
        effects.push({ type: 'fire', timeLeft: 8 });
        balls.forEach(b => b.fire = true);
        scheduleEffect('fire', 8, function() {
          balls.forEach(b => b.fire = false);
        });
        break;
      case 'slow':
        effects.push({ type: 'slow', timeLeft: 10 });
        balls.forEach(b => { b.vx *= 0.6; b.vy *= 0.6; });
        scheduleEffect('slow', 10, function() {
          balls.forEach(b => { b.vx /= 0.6; b.vy /= 0.6; });
        });
        break;
    }
  }

  function getPowerupDuration(type) {
    switch(type) { case 'expand': return 15; case 'shrink': return 10; case 'fire': return 8; case 'slow': return 10; default: return -1; }
  }

  function scheduleEffect(type, seconds, fn) {
    // Clear existing timeout if any (prevents stacking)
    if (effectTimeouts[type]) {
      clearTimeout(effectTimeouts[type]);
      delete effectTimeouts[type];
    }
    effectTimeouts[type] = setTimeout(function() {
      const idx = effects.findIndex(e => e.type === type);
      if (idx >= 0) effects.splice(idx, 1);
      delete effectTimeouts[type];
      fn();
    }, seconds * 1000);
  }

  // ============ COLLISION ============
  function rectCircleCollision(rect, circle) {
    const closestX = Math.max(rect.x, Math.min(circle.x, rect.x + rect.w));
    const closestY = Math.max(rect.y, Math.min(circle.y, rect.y + rect.h));
    const dx = circle.x - closestX;
    const dy = circle.y - closestY;
    return (dx * dx + dy * dy) < (circle.radius * circle.radius);
  }

  function handleBrickCollision(brick, ball) {
    // Fire ball passes through bricks without bouncing
    if (ball.fire) {
      brick.hp--;
      playBrickHit(brick.type);
      if (brick.hp <= 0) {
        brick.alive = false;
        score += brick.type === 2 ? 20 : (brick.type === 3 ? 30 : 10);
        maybeDropPowerup(brick);
      }
      return;
    }

    // Normal bounce logic
    const bx = ball.x, by = ball.y, br = ball.radius;
    const bLeft = brick.x, bRight = brick.x + brick.w;
    const bTop = brick.y, bBottom = brick.y + brick.h;

    // Determine collision side
    const overlapLeft = (bx + br) - bLeft;
    const overlapRight = bRight - (bx - br);
    const overlapTop = (by + br) - bTop;
    const overlapBottom = bBottom - (by - br);

    const minOverlapX = Math.min(overlapLeft, overlapRight);
    const minOverlapY = Math.min(overlapTop, overlapBottom);

    if (minOverlapX < minOverlapY) {
      ball.vx = -ball.vx;
    } else {
      ball.vy = -ball.vy;
    }

    brick.hp--;
    playBrickHit(brick.type);

    if (brick.hp <= 0) {
      brick.alive = false;
      score += brick.type === 2 ? 20 : (brick.type === 3 ? 30 : 10);
      maybeDropPowerup(brick);
    }
  }

  // ============ UPDATE ============
  function update(dt) {
    if (state === STATE.GAME_OVER) {
      gameOverTimer -= dt;
      return;
    }
    if (state === STATE.LEVEL_CLEAR) {
      levelClearTimer -= dt;
      return;
    }
    if (state !== STATE.PLAYING) return;

    // Update effects timers
    effects = effects.filter(e => {
      if (e.timeLeft > 0) e.timeLeft -= dt;
      return e.timeLeft !== 0;
    });

    // Move paddle
    if (touchX !== null) {
      paddle.x += (touchX - paddle.x) * 0.3;
    }
    paddle.x = Math.max(paddle.width / 2, Math.min(GAME_WIDTH - paddle.width / 2, paddle.x));

    // Update balls
    // Build spatial grid ONCE before all ball processing
    if (balls.length > 0 && bricks.length > 10) buildSpatialGrid();
    // Clamp angle to prevent horizontal stuck ball
    const MIN_VY_RATIO = 0.25;
    for (let i = balls.length - 1; i >= 0; i--) {
      const ball = balls[i];
      ball.x += ball.vx;
      ball.y += ball.vy;

      // Ensure ball doesn't go nearly horizontal (stuck ball prevention)
      const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
      if (Math.abs(ball.vy) < speed * MIN_VY_RATIO && speed > 0) {
        const sign = ball.vy >= 0 ? 1 : -1;
        ball.vy = sign * speed * MIN_VY_RATIO;
        const remaining = Math.sqrt(speed * speed - ball.vy * ball.vy);
        ball.vx = ball.vx >= 0 ? remaining : -remaining;
      }

      // Wall collisions
      if (ball.x - ball.radius < 0) { ball.x = ball.radius; ball.vx = Math.abs(ball.vx); playWallHit(); }
      if (ball.x + ball.radius > GAME_WIDTH) { ball.x = GAME_WIDTH - ball.radius; ball.vx = -Math.abs(ball.vx); playWallHit(); }
      if (ball.y - ball.radius < 0) { ball.y = ball.radius; ball.vy = Math.abs(ball.vy); playWallHit(); }

      // Bottom - lose ball
      if (ball.y + ball.radius > GAME_HEIGHT) {
        balls.splice(i, 1);
        if (balls.length === 0) {
          loseLife();
        }
        continue;
      }

      // Paddle collision
      const pLeft = paddle.x - paddle.width / 2;
      const pRight = paddle.x + paddle.width / 2;
      const pTop = paddle.y - paddle.height / 2;

      if (ball.vy > 0 &&
          ball.y + ball.radius >= pTop &&
          ball.y - ball.radius <= paddle.y + paddle.height / 2 &&
          ball.x >= pLeft &&
          ball.x <= pRight) {
        const hitPos = (ball.x - paddle.x) / (paddle.width / 2); // -1 to 1
        const angle = hitPos * (Math.PI / 3); // -60 to +60 degrees
        const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
        ball.vx = Math.sin(angle) * speed;
        ball.vy = -Math.abs(Math.cos(angle) * speed);
        ball.y = pTop - ball.radius;
        playPaddleHit();
      }

      // Brick collisions - spatial grid built once before ball loop (see above)
      // Find candidate brick indices for current ball
      let candidates;
      if (balls.length > 0 && bricks.length > 10) {
        candidates = getPotentialCollisions(ball);
      } else {
        candidates = bricks.map((_, idx) => idx);
      }
      for (const j of candidates) {
        const brick = bricks[j];
        if (!brick || !brick.alive) continue;
        if (rectCircleCollision(brick, ball)) {
          handleBrickCollision(brick, ball);
          if (!ball.fire) break;
        }
      }
    }
    // Remove dead bricks after ALL ball processing (single pass, avoids index corruption)
    for (let j = bricks.length - 1; j >= 0; j--) {
      if (bricks[j] && !bricks[j].alive) bricks.splice(j, 1);
    }

    // Update powerups
    for (let i = powerups.length - 1; i >= 0; i--) {
      const pu = powerups[i];
      pu.y += pu.vy;
      pu.timer -= dt;

      if (pu.timer <= 0) {
        powerups.splice(i, 1);
        continue;
      }

      // Collect powerup
      const pLeft = paddle.x - paddle.width / 2;
      const pRight = paddle.x + paddle.width / 2;
      if (pu.y + pu.radius >= paddle.y - paddle.height / 2 &&
          pu.y - pu.radius <= paddle.y + paddle.height / 2 &&
          pu.x >= pLeft && pu.x <= pRight) {
        applyPowerup(pu.type);
        powerups.splice(i, 1);
      } else if (pu.y > GAME_HEIGHT) {
        powerups.splice(i, 1);
      }
    }

    // Check level clear
    const aliveBricks = bricks.filter(b => b.alive);
    if (aliveBricks.length === 0) {
      state = STATE.LEVEL_CLEAR;
      levelClearTimer = 2.5;
      playLevelClear();
      if (score > highScore) {
        highScore = score;
        localStorage.setItem('bb_highscore', highScore);
      }
    }
  }

  // ============ RENDER ============
  function drawBrick(brick) {
    const colors = {
      1: { fill: '#e74c3c', stroke: '#c0392b' },
      2: { fill: '#3498db', stroke: '#2980b9' },
      3: { fill: '#f39c12', stroke: '#d68910' }
    };
    const c = colors[brick.type] || colors[1];

    ctx.fillStyle = c.fill;
    ctx.fillRect(brick.x, brick.y, brick.w, brick.h);

    // HP indicator for reinforced
    if (brick.type === 2 && brick.hp < brick.maxHp) {
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(brick.x + brick.w * 0.3, brick.y + brick.h * 0.3, brick.w * 0.4, brick.h * 0.4);
    }

    // Shine
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(brick.x, brick.y, brick.w, brick.h * 0.3);

    ctx.strokeStyle = c.stroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(brick.x + 0.5, brick.y + 0.5, brick.w - 1, brick.h - 1);
  }

  function drawPaddle() {
    const x = paddle.x - paddle.width / 2;
    const y = paddle.y - paddle.height / 2;
    const gradient = ctx.createLinearGradient(x, y, x, y + paddle.height);
    gradient.addColorStop(0, '#8e44ad');
    gradient.addColorStop(1, '#6c3483');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(x, y, paddle.width, paddle.height, 6);
    ctx.fill();

    // Highlight
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath();
    ctx.roundRect(x + 4, y + 2, paddle.width - 8, paddle.height * 0.4, 3);
    ctx.fill();
  }

  function drawBall(ball) {
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
    if (ball.fire) {
      const grad = ctx.createRadialGradient(ball.x, ball.y, 0, ball.x, ball.y, ball.radius);
      grad.addColorStop(0, '#fff');
      grad.addColorStop(0.3, '#ff6600');
      grad.addColorStop(1, '#ff0000');
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = '#ecf0f1';
    }
    ctx.fill();

    // Glow
    ctx.shadowColor = ball.fire ? '#ff6600' : '#3498db';
    ctx.shadowBlur = ball.fire ? 15 : 8;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
  }

  function drawPowerup(pu) {
    const colors = { expand: '#27ae60', shrink: '#e74c3c', multi: '#3498db', fire: '#e67e22', slow: '#9b59b6' };
    ctx.beginPath();
    ctx.arc(pu.x, pu.y, pu.radius, 0, Math.PI * 2);
    ctx.fillStyle = colors[pu.type] || '#fff';
    ctx.fill();

    // Pulse effect
    ctx.globalAlpha = 0.3 + Math.sin(Date.now() / 150) * 0.2;
    ctx.beginPath();
    ctx.arc(pu.x, pu.y, pu.radius + 4, 0, Math.PI * 2);
    ctx.fillStyle = colors[pu.type] || '#fff';
    ctx.fill();
    ctx.globalAlpha = 1;

    // Icon
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const icons = { expand: '+', shrink: '-', multi: '*', fire: 'F', slow: 'S' };
    ctx.fillText(icons[pu.type] || '?', pu.x, pu.y);
  }

  function drawHUD() {
    // Score
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Score: ' + score, 12, 30);

    // High score
    ctx.fillStyle = '#888';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.fillText('Best: ' + highScore, 12, 48);

    // Level
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Level ' + level, GAME_WIDTH / 2, 30);

    // Level name
    const lvlData = LEVELS[level - 1];
    if (lvlData && lvlData.name) {
      ctx.fillStyle = '#aaa';
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillText(lvlData.name, GAME_WIDTH / 2, 46);
    }

    // Lives
    ctx.textAlign = 'right';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px -apple-system, sans-serif';
    ctx.fillText('❤'.repeat(lives), GAME_WIDTH - 12, 30);

    // Effects indicator
    let effY = 65;
    effects.forEach(eff => {
      if (eff.timeLeft <= 0) return;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(GAME_WIDTH - 90, effY, 80, 16);
      ctx.fillStyle = '#fff';
      ctx.font = '10px -apple-system, sans-serif';
      ctx.textAlign = 'right';
      const labels = { expand: 'Expand', shrink: 'Shrink', fire: 'Fire', slow: 'Slow', multi: 'Multi' };
      ctx.fillText(labels[eff.type] + ' ' + Math.ceil(eff.timeLeft) + 's', GAME_WIDTH - 15, effY + 12);
      effY += 20;
    });
  }

  function drawMenu() {
    // Background
    ctx.fillStyle = '#0a0a1a';
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    // Title
    ctx.fillStyle = '#e74c3c';
    ctx.font = 'bold 42px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('BRICK', GAME_WIDTH / 2, GAME_HEIGHT * 0.28);
    ctx.fillStyle = '#3498db';
    ctx.fillText('BREAKER', GAME_WIDTH / 2, GAME_HEIGHT * 0.28 + 48);

    // Subtitle
    ctx.fillStyle = '#888';
    ctx.font = '14px -apple-system, sans-serif';
    ctx.fillText('Classic', GAME_WIDTH / 2, GAME_HEIGHT * 0.28 + 80);

    // Start button
    const btnY = GAME_HEIGHT * 0.55;
    const bounce = Math.sin(Date.now() / 400) * 3;
    ctx.fillStyle = '#27ae60';
    ctx.beginPath();
    ctx.roundRect(GAME_WIDTH / 2 - 80, btnY + bounce, 160, 50, 12);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px -apple-system, sans-serif';
    ctx.fillText('START', GAME_WIDTH / 2, btnY + bounce + 32);

    // High score
    ctx.fillStyle = '#f39c12';
    ctx.font = '16px -apple-system, sans-serif';
    ctx.fillText('Best: ' + highScore, GAME_WIDTH / 2, GAME_HEIGHT * 0.72);

    // Level count
    ctx.fillStyle = '#555';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.fillText('50 Levels • Power-ups • AdMob Ready', GAME_WIDTH / 2, GAME_HEIGHT * 0.78);

    // Tap hint
    ctx.fillStyle = '#444';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.fillText('Tap to start', GAME_WIDTH / 2, GAME_HEIGHT * 0.88);
  }

  function drawPaused() {
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 36px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('PAUSED', GAME_WIDTH / 2, GAME_HEIGHT / 2 - 20);
    ctx.font = '16px -apple-system, sans-serif';
    ctx.fillStyle = '#aaa';
    ctx.fillText('Tap center to resume', GAME_WIDTH / 2, GAME_HEIGHT / 2 + 20);
  }

  function drawGameOver() {
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    ctx.fillStyle = '#e74c3c';
    ctx.font = 'bold 40px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('GAME OVER', GAME_WIDTH / 2, GAME_HEIGHT * 0.35);
    ctx.fillStyle = '#fff';
    ctx.font = '24px -apple-system, sans-serif';
    ctx.fillText('Score: ' + score, GAME_WIDTH / 2, GAME_HEIGHT * 0.48);
    if (score >= highScore && score > 0) {
      ctx.fillStyle = '#f39c12';
      ctx.font = 'bold 18px -apple-system, sans-serif';
      ctx.fillText('NEW BEST!', GAME_WIDTH / 2, GAME_HEIGHT * 0.56);
    }
    ctx.fillStyle = '#aaa';
    ctx.font = '14px -apple-system, sans-serif';
    if (gameOverTimer <= 0) {
      ctx.fillText('Tap to return to menu', GAME_WIDTH / 2, GAME_HEIGHT * 0.66);
    }
  }

  function drawLevelClear() {
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    ctx.fillStyle = '#2ecc71';
    ctx.font = 'bold 32px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('LEVEL CLEAR!', GAME_WIDTH / 2, GAME_HEIGHT * 0.4);
    ctx.fillStyle = '#fff';
    ctx.font = '20px -apple-system, sans-serif';
    ctx.fillText('Score: ' + score, GAME_WIDTH / 2, GAME_HEIGHT * 0.52);
    if (levelClearTimer <= 0) {
      ctx.fillStyle = '#aaa';
      ctx.font = '14px -apple-system, sans-serif';
      ctx.fillText('Tap to continue', GAME_WIDTH / 2, GAME_HEIGHT * 0.64);
    }
  }

  function drawVictory() {
    ctx.fillStyle = '#0a0a1a';
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    ctx.fillStyle = '#f39c12';
    ctx.font = 'bold 36px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🎉 VICTORY! 🎉', GAME_WIDTH / 2, GAME_HEIGHT * 0.35);
    ctx.fillStyle = '#fff';
    ctx.font = '22px -apple-system, sans-serif';
    ctx.fillText('All 50 Levels Complete!', GAME_WIDTH / 2, GAME_HEIGHT * 0.48);
    ctx.font = '20px -apple-system, sans-serif';
    ctx.fillText('Final Score: ' + score, GAME_WIDTH / 2, GAME_HEIGHT * 0.58);
    ctx.fillStyle = '#aaa';
    ctx.font = '14px -apple-system, sans-serif';
    ctx.fillText('Tap to return', GAME_WIDTH / 2, GAME_HEIGHT * 0.72);
  }

  function drawBackground() {
    ctx.fillStyle = '#0a0a1a';
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    // Subtle grid
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let x = 0; x < GAME_WIDTH; x += 30) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, GAME_HEIGHT); ctx.stroke();
    }
    for (let y = 0; y < GAME_HEIGHT; y += 30) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(GAME_WIDTH, y); ctx.stroke();
    }
  }

  function render() {
    if (state === STATE.MENU) {
      drawMenu();
      return;
    }

    drawBackground();

    // Bricks (with offscreen culling)
    for (let i = 0; i < bricks.length; i++) {
      const brick = bricks[i];
      if (!brick.alive) continue;
      // Only draw if visible in canvas area
      if (brick.x + brick.w < 0 || brick.x > GAME_WIDTH ||
          brick.y + brick.h < 0 || brick.y > GAME_HEIGHT) continue;
      drawBrick(brick);
    }

    // Powerups
    powerups.forEach(pu => drawPowerup(pu));

    // Paddle
    drawPaddle();

    // Balls
    balls.forEach(ball => drawBall(ball));

    // HUD
    drawHUD();

    // Overlays
    if (state === STATE.PAUSED) drawPaused();
    if (state === STATE.GAME_OVER) drawGameOver();
    if (state === STATE.LEVEL_CLEAR) drawLevelClear();
    if (state === STATE.VICTORY) drawVictory();
  }

  // ============ GAME LOOP ============
  function gameLoop(timestamp) {
    const dt = Math.min((timestamp - lastTime) / 1000, 0.033);
    lastTime = timestamp;

    update(dt);
    render();

    requestAnimationFrame(gameLoop);
  }

  // ============ KEYBOARD (debug) ============
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
      if (state === STATE.PLAYING) state = STATE.PAUSED;
      else if (state === STATE.PAUSED) state = STATE.PLAYING;
    }
    if (e.key === 'r' || e.key === 'R') {
      if (state === STATE.GAME_OVER || state === STATE.VICTORY) {
        state = STATE.MENU;
      }
    }
  });

  // ============ VISIBILITY HANDLER ============
  document.addEventListener('visibilitychange', function() {
    if (document.hidden && state === STATE.PLAYING) {
      state = STATE.PAUSED;
    }
  });

  // ============ START ============
  requestAnimationFrame(gameLoop);

  // Expose for debug
  window.BrickBreaker = { state, score, level, lives, loadLevel, startGame };

})();
