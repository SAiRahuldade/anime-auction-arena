// ============================================================
// ANIME AUCTION: ARENA — Game Engine
// ============================================================

// ==================== GAME STATE ====================
const socket = typeof io !== "undefined" ? io() : null;

const GameState = {
    currentScreen: "title",
    currentMode: "friend",
    online: {
        roomCode: "",
        myPlayerIndex: null,
        connected: false,
        state: null,
    },
    players: [
        { name: "Player 1", budget: 30, team: [], score: 0 },
        { name: "Player 2", budget: 30, team: [], score: 0 },
    ],
    auction: {
        pool: [],
        currentIndex: 0,
        currentBid: 0,
        currentBidder: null,
        playerBids: [0, 0],
        timer: null,
        timeLeft: 10,
        maxTime: 10,
        passed: [false, false],
        resolving: false,
    },
    battle: {
        matchIndex: 0,
        matches: [],
        currentFighters: null,
        rosters: [[], []],
        nextFighter: [1, 1],
        turnCount: 0,
        battleOver: false,
    },
    totalAuctionRounds: 15,
    soundEnabled: true,
    powerRevealSkip: false,
    aiThinking: false,
};

const CHARACTER_THEME_MAP = {
    "Featherine Augustus Aurora": "audio/featherine.mp3",
    "Anti-Spiral": "audio/anti-spiral.mp3",
    "Anos Voldigoad": "audio/anos-voldigod.mp3",
    "Sailor Cosmos": "audio/sailor-cosmos.mp3",
    "The Truth": "audio/the truth.mp3",
    "Rimuru Tempest": "audio/rimuru.mp3",
};

const PLAYER_NAME_KEY = "aaa_player_name";
const ONLINE_PLAYER_ID_KEY = "aaa_online_player_id";
const ONLINE_ROOM_CODE_KEY = "aaa_online_room_code";
let activeCharacterTheme = null;
let activeCharacterThemeNodes = null;
let activeCharacterThemeFadeTimer = null;
let backgroundMusic = null;
let pendingRoomAction = null;
let roomRequestPending = false;
let startAuctionPending = false;
let battleSequenceId = 0;
let battleSequenceRunning = false;
let battleTurnTimeout = null;
let powerRevealSequenceId = 0;
let onlineBattleStartPending = false;

function getOnlinePlayerId() {
    let playerId = sessionStorage.getItem(ONLINE_PLAYER_ID_KEY);
    if (!playerId) {
        playerId = window.crypto?.randomUUID
            ? window.crypto.randomUUID()
            : `player-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        sessionStorage.setItem(ONLINE_PLAYER_ID_KEY, playerId);
    }
    return playerId;
}

const onlinePlayerId = getOnlinePlayerId();

function fillPlayerSetupFromSavedName() {
    const savedName = localStorage.getItem(PLAYER_NAME_KEY);
    const fallbackName = (savedName || "Player").trim() || "Player";
    const nameInput = $("player-name");
    if (nameInput) {
        nameInput.value = fallbackName;
    }
    GameState.players[0].name = fallbackName;
    $("p1-name").value = fallbackName;
    $("p1-name").placeholder = "Player 1";
}

function prepareLobbyForMode(mode) {
    GameState.currentMode = mode;
    const savedName = (localStorage.getItem(PLAYER_NAME_KEY) || "Player").trim() || "Player";
    const config = {
        ai: {
            rivalName: "Astra AI",
            editable: false,
            label: "AI Rival",
        },
        online: {
            rivalName: "Waiting for friend...",
            editable: false,
            label: "Online Rival",
        },
        friend: {
            rivalName: "Player 2",
            editable: true,
            label: "Player 2",
        },
    }[mode] || {
        rivalName: "Player 2",
        editable: true,
        label: "Player 2",
    };

    const playerOneName = savedName || "Player";
    GameState.players[0].name = playerOneName;
    GameState.players[1].name = config.rivalName;

    $("p1-name").value = playerOneName;
    $("p2-name").value = config.rivalName;
    $("p2-name").disabled = !config.editable;
    $("p2-name").placeholder = config.editable ? "Enter rival name..." : "CPU / online rival";
    $("p2-name").setAttribute("aria-disabled", String(!config.editable));

    const p2Label = $("p2-name").closest(".player-setup")?.querySelector("label");
    if (p2Label) {
        p2Label.textContent = config.label;
    }

    const onlinePanel = $("online-room-panel");
    if (onlinePanel) {
        onlinePanel.classList.toggle("hidden", mode !== "online");
    }
    updateOnlineLobbyControls();
    updateOnlineBidControls();

    showScreen("screen-lobby");
}

function updateOnlineLobbyControls(state = GameState.online.state) {
    const startButton = $("btn-start-auction");
    const createButton = $("btn-create-room");
    const joinButton = $("btn-join-room");
    const roomCodeInput = $("room-code-input");

    if (GameState.currentMode !== "online") {
        startButton.style.display = "";
        createButton.style.display = "";
        joinButton.style.display = "";
        roomCodeInput.readOnly = false;
        return;
    }

    const inRoom = !!GameState.online.roomCode;
    const allPlayersConnected = state?.players?.length === 2 &&
        state.players.every(player => player.isConnected);
    const isCreator = state?.myPlayerIndex === 0;

    createButton.style.display = inRoom ? "none" : "";
    joinButton.style.display = inRoom ? "none" : "";
    roomCodeInput.readOnly = inRoom;
    const canStart = !state?.started && allPlayersConnected && isCreator;
    startButton.style.display = canStart
        ? "inline-flex"
        : "none";
    startButton.querySelector(".btn-text").textContent = "START AUCTION →";
}

function updateOnlineBidControls() {
    const online = GameState.currentMode === "online";
    const playerIndex = GameState.online.myPlayerIndex;
    const state = GameState.online.state;
    for (const [index, controlsId] of ["p1-bid-controls", "p2-bid-controls"].entries()) {
        const controls = $(controlsId);
        controls.style.display = "";
        controls.querySelectorAll(".btn-bid, .btn-bid-pass").forEach(button => {
            const amount = Number(button.dataset.amount);
            const player = state?.players?.[index];
            const cannotAfford = amount > 0 && state?.auction &&
                state.auction.currentBid + amount > (player?.budget ?? 0);
            button.disabled = online && (
                playerIndex !== index ||
                !state?.started ||
                (amount > 0 && cannotAfford)
            );
            button.setAttribute("aria-label", online && playerIndex !== index
                ? `${button.textContent.trim()} (opponent controls, read only)`
                : button.textContent.trim());
        });
    }
}

function submitOnlineBid(amount) {
    const roomCode = GameState.online.roomCode;
    const playerIndex = GameState.online.myPlayerIndex;
    if (!socket?.connected || !roomCode || playerIndex === null) {
        $("online-room-status").textContent = "Reconnect to the game server before bidding.";
        return;
    }
    socket.emit("auction:bid", { roomCode, playerIndex, amount });
}

function stopCharacterTheme() {
    if (activeCharacterThemeFadeTimer) {
        clearTimeout(activeCharacterThemeFadeTimer);
        activeCharacterThemeFadeTimer = null;
    }
    if (activeCharacterTheme) {
        activeCharacterTheme.pause();
        activeCharacterTheme.currentTime = 0;
    }
    if (activeCharacterThemeNodes) {
        activeCharacterThemeNodes.source.disconnect();
        activeCharacterThemeNodes.boost.disconnect();
        activeCharacterThemeNodes.compressor.disconnect();
        activeCharacterThemeNodes.fade.disconnect();
        activeCharacterThemeNodes = null;
    }
    activeCharacterTheme = null;
}

function playBackgroundMusic() {
    if (!GameState.soundEnabled) return;

    if (!backgroundMusic) {
        backgroundMusic = new Audio("https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/C7M9Cd9JgJNU23FyQCUqy9yw0fAmLpNj4rl88fwj.mp3");
        backgroundMusic.loop = true;
        backgroundMusic.volume = 0.2;
        backgroundMusic.preload = "none";
    }

    backgroundMusic.play().catch((error) => {
        console.warn("Background music could not be played.", error);
    });
}

function stopBackgroundMusic() {
    if (!backgroundMusic) return;
    backgroundMusic.pause();
    backgroundMusic.currentTime = 0;
}

function playCharacterTheme(char) {
    if (!GameState.soundEnabled || !char || !char.name || char.tier !== "X") return;
    const themePath = CHARACTER_THEME_MAP[char.name];
    if (!themePath) return;

    stopCharacterTheme();

    const audio = new Audio(encodeURI(themePath));
    audio.volume = 1;
    audio.preload = "auto";
    ensureAudioReady();
    const source = audioCtx.createMediaElementSource(audio);
    const boost = audioCtx.createGain();
    const compressor = audioCtx.createDynamicsCompressor();
    const fade = audioCtx.createGain();
    boost.gain.value = 1000;
    compressor.threshold.value = -3;
    compressor.knee.value = 0;
    compressor.ratio.value = 20;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.2;
    const startTime = audioCtx.currentTime;
    fade.gain.setValueAtTime(1, startTime);
    fade.gain.setValueAtTime(1, startTime + 3);
    fade.gain.linearRampToValueAtTime(0, startTime + 7);
    source.connect(boost);
    boost.connect(compressor);
    compressor.connect(fade);
    fade.connect(audioCtx.destination);
    activeCharacterThemeNodes = { source, boost, compressor, fade };
    activeCharacterTheme = audio;
    audio.addEventListener("ended", stopCharacterTheme, { once: true });
    audio.play().catch(() => {
        stopCharacterTheme();
    });
    activeCharacterThemeFadeTimer = setTimeout(stopCharacterTheme, 7000);
}

// ==================== UTILITY FUNCTIONS ====================
function $(id) { return document.getElementById(id); }
function qs(sel) { return document.querySelector(sel); }
function qsa(sel) { return document.querySelectorAll(sel); }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function d20() { return rand(1, 20); }
function d100() { return rand(1, 100); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function teamTotalPower(player) {
    return player.team.reduce((sum, c) => sum + getCharacterPowerLevel(c), 0);
}

function formatBudget(amount) {
    if (typeof formatMoney === "function") return formatMoney(amount);
    return Number.isInteger(amount) ? `$${amount}` : `$${Number(amount).toFixed(2)}`;
}

function setCharacterAvatar(el, char, sizeClass = "char-avatar-md") {
    el.textContent = "";
    el.className = `char-avatar ${sizeClass}`;
    el.dataset.charId = String(char.id);
    el.setAttribute("aria-label", char.name);
    el.setAttribute("role", "img");
}

function characterAvatarHTML(char, sizeClass = "char-avatar-md") {
    return `<div class="char-avatar ${sizeClass}" data-char-id="${char.id}" aria-label="${char.name}" role="img"></div>`;
}

function updatePlayerBidStatus(pulsePlayer = null) {
    const leader = GameState.auction.currentBidder;
    const passed = GameState.auction.passed;

    [0, 1].forEach(i => {
        const p = i + 1;
        const playerBid = GameState.auction.playerBids[i];
        $(`pbs-p${p}-name`).textContent = GameState.players[i].name;
        $(`pbs-p${p}-amount`).textContent = `$${playerBid}`;

        const statusEl = $(`pbs-p${p}-state`);
        const blockEl = $(`p${p}-bid-status`);
        blockEl.classList.remove("leading", "passed", "idle", "bid-pulse");

        if (passed[i]) {
            statusEl.textContent = "PASSED";
            blockEl.classList.add("passed");
        } else if (leader === i) {
            statusEl.textContent = "LEADING";
            blockEl.classList.add("leading");
        } else if (playerBid > 0) {
            statusEl.textContent = "OUTBID";
            blockEl.classList.add("idle");
        } else {
            statusEl.textContent = "NO BID";
            blockEl.classList.add("idle");
        }

        if (pulsePlayer === i) {
            blockEl.classList.add("bid-pulse");
            setTimeout(() => blockEl.classList.remove("bid-pulse"), 300);
        }
    });
}

function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = rand(0, i);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function resetGameState() {
    battleSequenceId++;
    battleSequenceRunning = false;
    powerRevealSequenceId++;
    onlineBattleStartPending = false;
    clearTimeout(battleTurnTimeout);
    battleTurnTimeout = null;
    $("btn-skip-reveal").style.display = "";
    $("battle-match-intro").classList.remove("show", "is-winner");
    $("battle-match-intro").setAttribute("aria-hidden", "true");
    if (GameState.auction.timer) {
        clearInterval(GameState.auction.timer);
    }

    GameState.auction = {
        ...GameState.auction,
        pool: [],
        currentIndex: 0,
        currentBid: 0,
        currentBidder: null,
        playerBids: [0, 0],
        timer: null,
        timeLeft: 10,
        maxTime: 10,
        passed: [false, false],
        resolving: false,
    };

    GameState.battle = {
        ...GameState.battle,
        matchIndex: 0,
        matches: [],
        currentFighters: null,
        rosters: [[], []],
        nextFighter: [1, 1],
        turnCount: 0,
        battleOver: false,
    };

    GameState.powerRevealSkip = false;
    GameState.players.forEach(player => {
        player.budget = 30;
        player.team = [];
        player.score = 0;
        player.activeSynergies = [];
    });
}

// ==================== PARTICLE BACKGROUND ====================
const particleCanvas = $("particle-canvas");
const pCtx = particleCanvas.getContext("2d");
let particles = [];

function initParticles() {
    particleCanvas.width = window.innerWidth;
    particleCanvas.height = window.innerHeight;
    particles = [];
    for (let i = 0; i < 80; i++) {
        particles.push({
            x: Math.random() * particleCanvas.width,
            y: Math.random() * particleCanvas.height,
            vx: (Math.random() - 0.5) * 0.5,
            vy: (Math.random() - 0.5) * 0.5,
            size: Math.random() * 2 + 0.5,
            alpha: Math.random() * 0.5 + 0.1,
            hue: Math.random() * 60 + 260, // purple-blue range
        });
    }
}

function animateParticles() {
    pCtx.clearRect(0, 0, particleCanvas.width, particleCanvas.height);
    particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = particleCanvas.width;
        if (p.x > particleCanvas.width) p.x = 0;
        if (p.y < 0) p.y = particleCanvas.height;
        if (p.y > particleCanvas.height) p.y = 0;
        pCtx.beginPath();
        pCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        pCtx.fillStyle = `hsla(${p.hue}, 80%, 70%, ${p.alpha})`;
        pCtx.fill();
    });

    // Draw connections
    for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
            const dx = particles[i].x - particles[j].x;
            const dy = particles[i].y - particles[j].y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 120) {
                pCtx.beginPath();
                pCtx.moveTo(particles[i].x, particles[i].y);
                pCtx.lineTo(particles[j].x, particles[j].y);
                pCtx.strokeStyle = `hsla(270, 70%, 60%, ${0.15 * (1 - dist / 120)})`;
                pCtx.lineWidth = 0.5;
                pCtx.stroke();
            }
        }
    }
    requestAnimationFrame(animateParticles);
}

window.addEventListener("resize", () => {
    particleCanvas.width = window.innerWidth;
    particleCanvas.height = window.innerHeight;
});

initParticles();
animateParticles();

// ==================== SCREEN NAVIGATION ====================
function showScreen(screenId) {
    qsa(".screen").forEach(s => s.classList.remove("active"));
    $(screenId).classList.add("active");
    GameState.currentScreen = screenId;
}

// ==================== SOUND TOGGLE ====================
const soundToggleBtn = $("sound-toggle");
soundToggleBtn.addEventListener("click", () => {
    GameState.soundEnabled = !GameState.soundEnabled;
    if (!GameState.soundEnabled) {
        stopCharacterTheme();
        if (backgroundMusic) backgroundMusic.pause();
    } else {
        playBackgroundMusic();
    }
    soundToggleBtn.textContent = GameState.soundEnabled ? "🔊" : "🔇";
    soundToggleBtn.classList.toggle("muted", !GameState.soundEnabled);
    localStorage.setItem("aaa_sound", GameState.soundEnabled ? "on" : "off");
});

// Restore sound preference
if (localStorage.getItem("aaa_sound") === "off") {
    GameState.soundEnabled = false;
    soundToggleBtn.textContent = "🔇";
    soundToggleBtn.classList.add("muted");
}

// ==================== SOUND EFFECTS (Web Audio API) ====================
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx;

function initAudio() {
    if (!audioCtx) audioCtx = new AudioCtx();
}

function ensureAudioReady() {
    if (!GameState.soundEnabled) return;
    initAudio();
    if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume();
    }
}

function playTone(freq, duration, type = "sine", volume = 0.1) {
    if (!GameState.soundEnabled) return;
    ensureAudioReady();
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    gain.gain.setValueAtTime(volume, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
}

function sfxBid() { playTone(600, 0.15, "square", 0.1); }

function sfxBidAmount(amount) {
    const freqs = { 1: 520, 2: 680, 5: 880 };
    playTone(freqs[amount] || 600, 0.12, "square", 0.12);
}
function sfxPass() { playTone(200, 0.2, "sawtooth", 0.05); }
function sfxSold() {
    playTone(523, 0.1, "square", 0.1);
    setTimeout(() => playTone(659, 0.1, "square", 0.1), 100);
    setTimeout(() => playTone(784, 0.2, "square", 0.1), 200);
}
function sfxHit() { playTone(150, 0.15, "sawtooth", 0.12); }
function sfxBell() {
    playTone(880, 0.45, "sine", 0.18);
    setTimeout(() => playTone(660, 0.6, "sine", 0.16), 120);
}

const BATTLE_MOVE_INTERVAL_MS = 4000;
const BATTLE_INTRO_DURATION_MS = 1800;
const BATTLE_WINNER_DURATION_MS = 2200;
function sfxUltimate() {
    playTone(440, 0.1, "square", 0.12);
    setTimeout(() => playTone(880, 0.1, "square", 0.12), 80);
    setTimeout(() => playTone(1320, 0.3, "square", 0.12), 160);
}
function sfxVictory() {
    [523, 659, 784, 1047].forEach((f, i) => {
        setTimeout(() => playTone(f, 0.3, "square", 0.08), i * 150);
    });
}
function sfxEvent() {
    playTone(880, 0.1, "sine", 0.1);
    setTimeout(() => playTone(660, 0.15, "sine", 0.1), 100);
}

/** Loud hype sting when an X-tier character appears (auction / reveal). */
function sfxXTierReveal() {
    if (!GameState.soundEnabled) return;
    initAudio();
    if (!audioCtx) return;
    if (audioCtx.state === "suspended") {
        audioCtx.resume();
    }

    const t0 = audioCtx.currentTime;
    const master = audioCtx.createGain();
    master.gain.setValueAtTime(0.92, t0);
    master.connect(audioCtx.destination);

    function brassStab(at, freq, dur, vol) {
        const osc = audioCtx.createOscillator();
        const osc2 = audioCtx.createOscillator();
        const filter = audioCtx.createBiquadFilter();
        const g = audioCtx.createGain();
        osc.type = "sawtooth";
        osc2.type = "square";
        osc.frequency.setValueAtTime(freq, at);
        osc2.frequency.setValueAtTime(freq * 1.005, at);
        filter.type = "lowpass";
        filter.frequency.setValueAtTime(2800, at);
        filter.frequency.exponentialRampToValueAtTime(900, at + dur);
        filter.Q.setValueAtTime(2.5, at);
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(vol, at + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        osc.connect(filter);
        osc2.connect(filter);
        filter.connect(g);
        g.connect(master);
        osc.start(at);
        osc2.start(at);
        osc.stop(at + dur + 0.05);
        osc2.stop(at + dur + 0.05);
    }

    // Sub impact — stadium boom
    const sub = audioCtx.createOscillator();
    const subG = audioCtx.createGain();
    sub.type = "sine";
    sub.frequency.setValueAtTime(90, t0);
    sub.frequency.exponentialRampToValueAtTime(38, t0 + 0.42);
    subG.gain.setValueAtTime(0.0001, t0);
    subG.gain.exponentialRampToValueAtTime(0.42, t0 + 0.018);
    subG.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
    sub.connect(subG);
    subG.connect(master);
    sub.start(t0);
    sub.stop(t0 + 0.6);

    // Noise crash — cymbal / crowd-energy wash
    const noiseDur = 0.55;
    const noiseBuf = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate * noiseDur), audioCtx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = audioCtx.createBufferSource();
    noise.buffer = noiseBuf;
    const noiseFilter = audioCtx.createBiquadFilter();
    noiseFilter.type = "highpass";
    noiseFilter.frequency.setValueAtTime(1200, t0);
    const noiseG = audioCtx.createGain();
    noiseG.gain.setValueAtTime(0.0001, t0);
    noiseG.gain.exponentialRampToValueAtTime(0.22, t0 + 0.025);
    noiseG.gain.exponentialRampToValueAtTime(0.0001, t0 + noiseDur);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseG);
    noiseG.connect(master);
    noise.start(t0);

    // Rising fanfare — fast major run (match-day / promo hype)
    const run = [261.63, 329.63, 392, 493.88, 587.33, 659.25, 783.99, 987.77, 1174.66];
    run.forEach((freq, i) => {
        brassStab(t0 + 0.04 + i * 0.065, freq, 0.2, 0.11 + i * 0.008);
    });

    // Final chord stab — dopamine hit
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
        brassStab(t0 + 0.62 + i * 0.01, freq, 0.55, 0.16);
    });

    // Sparkle layer on top
    [1318.5, 1567.98, 2093].forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        osc.type = "triangle";
        const at = t0 + 0.68 + i * 0.04;
        osc.frequency.setValueAtTime(freq, at);
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
        osc.connect(g);
        g.connect(master);
        osc.start(at);
        osc.stop(at + 0.4);
    });
}

if (socket) {
    socket.on("connect", () => {
        GameState.online.connected = true;
        const status = $("online-room-status");
        if (pendingRoomAction) {
            const pending = pendingRoomAction;
            pendingRoomAction = null;
            sendOnlineRoomAction(pending.action, pending.payload);
            return;
        }

        const roomCode = GameState.online.roomCode || localStorage.getItem(ONLINE_ROOM_CODE_KEY);
        if (roomCode) {
            status.textContent = "Reconnected. Restoring your room...";
            socket.timeout(10000).emit("online:reconnect", { roomCode, playerId: onlinePlayerId }, (error, response) => {
                if (error) {
                    status.textContent = "Connected, but the room could not be restored. Create a new room or rejoin with a valid code.";
                } else if (!response?.ok) {
                    status.textContent = response?.message || "Connected, but the room could not be restored. Create a new room or rejoin.";
                }
            });
        } else if (status.textContent.includes("Can't connect") || status.textContent.includes("Disconnected")) {
            status.textContent = "Connected to the game server. You can create or join a room.";
        }
    });

    socket.on("connect_error", () => {
        GameState.online.connected = false;
        if (!socket.connected) {
            $("online-room-status").textContent = "Can't connect to the game server yet. It may be waking up; retrying...";
        }
    });

    socket.on("disconnect", () => {
        GameState.online.connected = false;
        if (GameState.currentMode === "online") {
            $("online-room-status").textContent = "Disconnected from the game server. Reconnecting...";
        }
    });

    socket.on("battle:start", ({ roomCode } = {}) => {
        if (GameState.currentMode !== "online" ||
            String(roomCode || "").toUpperCase() !== GameState.online.roomCode.toUpperCase()) {
            return;
        }
        launchTournament();
    });

    socket.on("room:state", (state) => {
        const previousState = GameState.online.state;
        const previousAuction = previousState?.auction;
        const auctionWasStarted = previousState?.started;
        GameState.online.roomCode = state.roomCode || "";
        GameState.online.myPlayerIndex = state.myPlayerIndex;
        GameState.online.state = state;
        localStorage.setItem(ONLINE_ROOM_CODE_KEY, state.roomCode || "");
        $("room-code-input").value = state.roomCode || $("room-code-input").value;
        updateOnlineLobbyControls(state);
        updateOnlineBidControls();

        if (state.started) {
            stopBackgroundMusic();
        } else if (auctionWasStarted && !state.started) {
            stopCharacterTheme();
            playBackgroundMusic();
        }

        const allPlayersConnected = state.players?.length === 2 &&
            state.players.every(player => player.isConnected);
        if (state.started && allPlayersConnected) {
            GameState.players[0].name = state.players[0]?.name || GameState.players[0].name;
            GameState.players[1].name = state.players[1]?.name || GameState.players[1].name;
            $("p1-name").value = GameState.players[0].name;
            $("p2-name").value = GameState.players[1].name;
            $("online-room-status").textContent = `Room ${state.roomCode} is live. Opening the auction...`;
        } else if (allPlayersConnected && state.myPlayerIndex === 0) {
            $("online-room-status").textContent = `Your friend joined room ${state.roomCode}. Start the auction when you're ready.`;
        } else if (allPlayersConnected) {
            $("online-room-status").textContent = "Connected. Waiting for the room creator to start the auction.";
        } else if (state.players?.some(player => !player.isConnected)) {
            $("online-room-status").textContent = `Room ${state.roomCode}: a player disconnected. Waiting for them to reconnect...`;
        } else {
            $("online-room-status").textContent = state.myPlayerIndex === 0
                ? `Room ${state.roomCode} created. Share this code and wait for your friend.`
                : `Joined room ${state.roomCode}. Waiting for the room creator.`;
        }

        if (state.auctionComplete) {
            $("online-room-status").textContent = `Auction complete in room ${state.roomCode}. Revealing both teams...`;
            if (!previousState?.auctionComplete) {
                state.players.forEach((player, index) => {
                    GameState.players[index].name = player.name;
                    GameState.players[index].budget = player.budget;
                    GameState.players[index].team = (player.team || []).map(char => ({ ...char }));
                    GameState.players[index].score = 0;
                    GameState.players[index].activeSynergies = [];
                });
                endAuction();
            }
            return;
        }

        if (state.started) {
            $("online-room-status").textContent = `Room ${state.roomCode} is live. Opening the auction...`;
            if (GameState.currentScreen !== "screen-auction") {
                showScreen("screen-auction");
            }
        }

        if (state.started && state.auction) {
            updateOnlineAuctionView(state, previousAuction);
            const p1 = state.players[0];
            const p2 = state.players[1];

            $("auction-p1-name").textContent = p1?.name || "Player 1";
            $("auction-p2-name").textContent = p2?.name || "Player 2";
            $("bid-p1-label").textContent = p1?.name || "Player 1";
            $("bid-p2-label").textContent = p2?.name || "Player 2";
            $("auction-p1-budget").textContent = formatBudget(p1?.budget ?? 30);
            $("auction-p2-budget").textContent = formatBudget(p2?.budget ?? 30);
            $("auction-p1-cards").textContent = `${p1?.teamCount ?? 0} characters`;
            $("auction-p2-cards").textContent = `${p2?.teamCount ?? 0} characters`;
            $("auction-round").textContent = `${state.auction.currentIndex + 1} / ${state.auction.poolSize}`;
            $("timer-text").textContent = state.auction.timeLeft;

            $("pbs-p1-amount").textContent = `$${state.auction.playerBids[0] || 0}`;
            $("pbs-p2-amount").textContent = `$${state.auction.playerBids[1] || 0}`;
            $("pbs-p1-state").textContent = state.auction.passed?.[0] ? "PASSED" : state.auction.currentBidder === 0 ? "LEADING" : "NO BID";
            $("pbs-p2-state").textContent = state.auction.passed?.[1] ? "PASSED" : state.auction.currentBidder === 1 ? "LEADING" : "NO BID";
        }
    });

    socket.on("room:error", ({ message }) => {
        $("online-room-status").textContent = message;
    });
}

function updateOnlineAuctionView(state, previousAuction) {
    const auction = state.auction;
    const char = auction.currentChar;
    const previousChar = previousAuction?.currentChar;
    const isNewCharacter = !!char && (
        char.id !== previousChar?.id ||
        auction.currentIndex !== previousAuction?.currentIndex
    );

    GameState.auction.timeLeft = auction.timeLeft;
    GameState.auction.maxTime = auction.maxTime || 10;
    GameState.auction.currentBid = auction.currentBid || 0;
    GameState.auction.currentBidder = auction.currentBidder;
    GameState.auction.playerBids = [...(auction.playerBids || [0, 0])];
    GameState.auction.passed = [...(auction.passed || [false, false])];
    updateTimerUI();

    if (char) {
        if (isNewCharacter) {
            const card = $("auction-card");
            card.className = `auction-card tier-${String(char.tier).toLowerCase()} card-enter`;
            card.dataset.id = char.id;
            if (["X", "SSS", "S"].includes(char.tier)) {
                card.classList.add("tier-spotlight");
                setTimeout(() => card.classList.remove("tier-spotlight"), 1400);
            }
            setTimeout(() => card.classList.remove("card-enter"), 600);
            $("card-tier").textContent = char.tier;
            setCharacterAvatar($("card-avatar"), char, "char-avatar-xl card-avatar");
            $("card-name").textContent = char.name;
            $("card-series").textContent = char.series;
            $("card-power").textContent = formatPowerLevel(getCharacterPowerLevel(char));
            $("card-battle-stats").textContent = formatBattleStats(char);
            $("card-ultimate").textContent = `ULTIMATE: ${char.ultimate}`;
            $("card-tags").innerHTML = (char.tags || []).map(tag => `<span class="tag">${tag}</span>`).join("");
            $("card-ability").textContent = char.abilityDesc ? `ABILITY: ${char.abilityDesc}` : "";
            $("card-result-overlay").classList.add("hidden");
            $("card-result-overlay").classList.remove("show");

            stopCharacterTheme();
            playCharacterTheme(char);
            if (char.tier === "SSS") {
                sfxXTierReveal();
            } else if (char.tier === "S") {
                sfxBid();
            }
        }
    } else {
        $("card-name").textContent = "Preparing next character...";
    }

    if (previousAuction) {
        const bidChanges = auction.playerBids.map((bid, index) =>
            bid - (previousAuction.playerBids?.[index] || 0)
        );
        const bidIncrease = Math.max(...bidChanges);
        if (bidIncrease > 0) {
            sfxBidAmount(bidIncrease);
        } else if ((auction.passed || []).some((passed, index) =>
            passed && !previousAuction.passed?.[index]
        )) {
            sfxPass();
        }

        if (auction.currentIndex > previousAuction.currentIndex && previousAuction.currentBidder !== null) {
            sfxSold();
        }
        if (auction.timeLeft < previousAuction.timeLeft && auction.timeLeft <= 3) {
            playTone(800 + (3 - auction.timeLeft) * 200, 0.08, "square", 0.06);
        }
    }
}

// ==================== TITLE SCREEN ====================
$("btn-start").addEventListener("click", () => {
    initAudio();
    sfxBid();
    playBackgroundMusic();
    fillPlayerSetupFromSavedName();
    showScreen("screen-name-entry");
});

$("btn-save-player-name").addEventListener("click", () => {
    const name = ($("player-name").value || "Player").trim() || "Player";
    localStorage.setItem(PLAYER_NAME_KEY, name);
    GameState.players[0].name = name;
    $("p1-name").value = name;
    showScreen("screen-mode-select");
});

$("player-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        $("btn-save-player-name").click();
    }
});

// ==================== MODE SELECT ====================
qsa(".mode-btn").forEach(button => {
    button.addEventListener("click", () => {
        const mode = button.dataset.mode;
        prepareLobbyForMode(mode);
    });
});

// ==================== LOBBY ====================
function startOnlineRoomFlow(action) {
    if (!socket) {
        $("online-room-status").textContent = "Multiplayer socket unavailable. Refresh and try again.";
        return;
    }

    const playerName = ($("p1-name").value || "Player").trim() || "Player";
    const roomCodeInput = ($("room-code-input").value || "").trim().toUpperCase();

    if (action === "join" && !roomCodeInput) {
        $("online-room-status").textContent = "Enter a room code before joining.";
        return;
    }

    const isCreating = action === "create";
    const payload = isCreating
        ? { name: playerName, playerId: onlinePlayerId }
        : { roomCode: roomCodeInput, name: playerName, playerId: onlinePlayerId };
    if (!socket.connected) {
        pendingRoomAction = { action, payload };
        $("online-room-status").textContent = "Connecting to the game server... Your room request will be sent when connected.";
        socket.connect();
        return;
    }
    sendOnlineRoomAction(action, payload);
}

function sendOnlineRoomAction(action, payload) {
    if (roomRequestPending) return;
    const isCreating = action === "create";
    const event = isCreating ? "online:createRoom" : "online:joinRoom";
    roomRequestPending = true;
    $("online-room-status").textContent = isCreating ? "Creating room..." : `Joining room ${payload.roomCode}...`;

    socket.timeout(20000).emit(event, payload, (error, response) => {
        roomRequestPending = false;
        if (error) {
            $("online-room-status").textContent = socket.connected
                ? "The server didn't respond. Please try again."
                : "Disconnected while waiting for the server. Reconnecting; try again when connected.";
            return;
        }
        if (!response?.ok) {
            $("online-room-status").textContent = response?.message || "Couldn't complete the room request. Please try again.";
            return;
        }
        if (isCreating && response.roomCode) {
            $("room-code-input").value = response.roomCode;
            GameState.online.roomCode = response.roomCode;
            localStorage.setItem(ONLINE_ROOM_CODE_KEY, response.roomCode);
            $("online-room-status").textContent = `Room ${response.roomCode} created. Share this code and wait for your friend.`;
        } else if (response.roomCode) {
            GameState.online.roomCode = response.roomCode;
            localStorage.setItem(ONLINE_ROOM_CODE_KEY, response.roomCode);
        }
    });
}

$("btn-create-room").addEventListener("click", () => {
    startOnlineRoomFlow("create");
});

$("btn-join-room").addEventListener("click", () => {
    startOnlineRoomFlow("join");
});

$("btn-start-auction").addEventListener("click", () => {
    if (GameState.currentMode === "online") {
        if (!GameState.online.roomCode || !socket?.connected) {
            $("online-room-status").textContent = "Connect to a room with both players before starting the auction.";
        } else {
            startOnlineAuction();
        }
        return;
    }

    const savedName = (localStorage.getItem(PLAYER_NAME_KEY) || "Player").trim() || "Player";
    GameState.players[0].name = ($("p1-name").value || savedName).trim() || savedName || "Player";
    GameState.players[1].name = ($("p2-name").value || (GameState.currentMode === "friend" ? "Player 2" : "Astra AI")).trim() || "Player 2";
    resetGameState();
    sfxBid();
    startAuction();
});

function startOnlineAuction() {
    if (startAuctionPending || !socket?.connected) return;
    const state = GameState.online.state;
    if (state?.myPlayerIndex !== 0 || state.players?.length !== 2 ||
        !state.players.every(player => player.isConnected)) {
        $("online-room-status").textContent = "Wait until both players are connected. Only the room creator can start.";
        return;
    }

    startAuctionPending = true;
    $("btn-start-auction").disabled = true;
    $("online-room-status").textContent = "Starting the auction for both players...";
    socket.timeout(15000).emit("online:startAuction", {
        roomCode: GameState.online.roomCode,
    }, (error, response) => {
        startAuctionPending = false;
        $("btn-start-auction").disabled = false;
        if (error) {
            $("online-room-status").textContent = "The server did not respond. Check your connection and try again.";
        } else if (!response?.ok) {
            $("online-room-status").textContent = response?.message || "The auction could not start. Please try again.";
        }
    });
}

// ==================== AUCTION ENGINE ====================
function startAuction() {
    stopBackgroundMusic();

    // Pick 15 unique characters based on tier rarity.
    const tierWeights = { "X": 7, "SSS": 12, "S": 15, "A": 18, "B": 24, "C": 28 };
    let weightedPool = [];

    // Create a bigger pool so X-tier characters appear much more often without dominating every slot.
    CHARACTER_DB.forEach(char => {
        const weight = tierWeights[char.tier] || 15;
        for (let i = 0; i < weight; i++) {
            weightedPool.push(char);
        }
    });

    const pool = [];
    for (let i = 0; i < GameState.totalAuctionRounds; i++) {
        // Pick random from weighted pool, but ensure we don't pick duplicates if possible
        let attempts = 0;
        let selectedChar = null;
        while (attempts < 50) {
            const randomIndex = Math.floor(Math.random() * weightedPool.length);
            const candidate = weightedPool[randomIndex];
            if (!pool.find(c => c.id === candidate.id)) {
                selectedChar = candidate;
                break;
            }
            attempts++;
        }
        if (!selectedChar) {
            // Fallback if we somehow can't find a unique one
            selectedChar = weightedPool[Math.floor(Math.random() * weightedPool.length)];
        }
        pool.push(selectedChar);
    }
    
    GameState.auction.pool = pool;
    GameState.auction.currentIndex = 0;
    $("auction-p1-name").textContent = GameState.players[0].name;
    $("auction-p2-name").textContent = GameState.players[1].name;
    $("bid-p1-label").textContent = GameState.players[0].name;
    $("bid-p2-label").textContent = GameState.players[1].name;

    $("auction-log").innerHTML = '<div class="log-entry log-system">⚡ Welcome to the Auction! Let the bidding begin...</div>';

    showScreen("screen-auction");
    presentCharacter();
}

function updateAuctionUI() {
    $("auction-p1-budget").textContent = formatBudget(GameState.players[0].budget);
    $("auction-p2-budget").textContent = formatBudget(GameState.players[1].budget);
    $("auction-p1-cards").textContent = `${GameState.players[0].team.length} characters`;
    $("auction-p2-cards").textContent = `${GameState.players[1].team.length} characters`;
    $("auction-round").textContent = `${GameState.auction.currentIndex + 1} / ${GameState.auction.pool.length}`;

    // Disable bid buttons if can't afford or team full
    [1, 2].forEach(p => {
        const idx = p - 1;
        const player = GameState.players[idx];
        const btns = qsa(`.p${p}-btn`);
        btns.forEach(btn => {
            const amount = parseInt(btn.dataset.amount) || 0;
            const newBid = GameState.auction.currentBid + amount;
            if (amount > 0) {
                btn.disabled = newBid > player.budget;
            } else {
                // PASS button
                btn.disabled = false;
            }
        });
    });
}

function presentCharacter() {
    const idx = GameState.auction.currentIndex;
    if (idx >= GameState.auction.pool.length) {
        endAuction();
        return;
    }

    const char = { ...GameState.auction.pool[idx] };

    // Store modified char back
    GameState.auction.pool[idx] = char;

    // Update card display
    const card = $("auction-card");
    const tierClass = `tier-${char.tier.toLowerCase()}`;
    card.className = `auction-card ${tierClass} card-enter`;
    card.dataset.id = char.id;
    if (["X", "SSS", "S"].includes(char.tier)) {
        card.classList.add("tier-spotlight");
        setTimeout(() => card.classList.remove("tier-spotlight"), 1400);
    }
    $("card-tier").textContent = char.tier;
    setCharacterAvatar($("card-avatar"), char, "char-avatar-xl card-avatar");
    $("card-name").textContent = char.name;
    $("card-series").textContent = char.series;
    $("card-power").textContent = formatPowerLevel(getCharacterPowerLevel(char));
    $("card-battle-stats").textContent = formatBattleStats(char);
    $("card-ultimate").textContent = `ULTIMATE: ${char.ultimate}`;
    $("card-tags").innerHTML = char.tags.map(t => `<span class="tag">${t}</span>`).join("");
    $("card-ability").textContent = char.abilityDesc ? `ABILITY: ${char.abilityDesc}` : "";
    playCharacterTheme(char);

    // Reset bidding (starts at $0)
    GameState.auction.currentBid = 0;
    GameState.auction.currentBidder = null;
    GameState.auction.playerBids = [0, 0];
    GameState.auction.passed = [false, false];
    GameState.auction.resolving = false;

    $("card-result-overlay").classList.add("hidden");
    $("card-result-overlay").classList.remove("show");

    updatePlayerBidStatus();
    updateAuctionUI();
    startBidTimer();
    syncAiControls();

    if (GameState.currentMode === "ai") {
        scheduleAiDecision();
    }

    if (char.tier === "SSS") {
        sfxXTierReveal();
    } else if (char.tier === "S") {
        sfxBid();
    }

    // Remove animation class after it plays
    setTimeout(() => card.classList.remove("card-enter"), 600);
}

function startBidTimer() {
    clearInterval(GameState.auction.timer);
    const maxTime = 10;
    GameState.auction.maxTime = maxTime;
    GameState.auction.timeLeft = maxTime;

    updateTimerUI();

    GameState.auction.timer = setInterval(() => {
        GameState.auction.timeLeft--;
        updateTimerUI();
        if (GameState.auction.timeLeft <= 3) {
            playTone(800 + (3 - GameState.auction.timeLeft) * 200, 0.08, "square", 0.06);
        }
        if (GameState.auction.timeLeft <= 0) {
            clearInterval(GameState.auction.timer);
            resolveBid();
        }
    }, 1000);
}

function updateTimerUI() {
    $("timer-text").textContent = GameState.auction.timeLeft;
    const progress = $("timer-progress");
    const circumference = 2 * Math.PI * 45;
    const pct = GameState.auction.timeLeft / GameState.auction.maxTime;
    progress.style.strokeDasharray = circumference;
    progress.style.strokeDashoffset = circumference * (1 - pct);

    if (pct < 0.3) {
        progress.style.stroke = "#ff4444";
    } else if (pct < 0.6) {
        progress.style.stroke = "#ffaa00";
    } else {
        progress.style.stroke = "#a855f7";
    }
}

function syncAiControls() {
    const aiMode = GameState.currentMode === "ai";
    qsa(".p2-btn, .p2-btn-pass").forEach(button => {
        button.disabled = aiMode;
        button.title = aiMode ? "AI is controlling this side" : "Bid for Player 2";
    });
}

function getAiCharacterValue(char) {
    const tierValue = { C: 5, B: 9, A: 14, S: 21, SSS: 34, X: 52 };
    const tagBoost = (char.tags || []).includes("Villain") ? 3 : 0;
    const powerBoost = Math.max(0, Math.round(getCharacterPowerLevel(char) / 180));
    return (tierValue[char.tier] || 8) + tagBoost + powerBoost;
}

function getAiBidDecision(char) {
    const aiPlayer = GameState.players[1];
    const humanPlayer = GameState.players[0];
    const currentBid = GameState.auction.currentBid || 0;
    const currentLeader = GameState.auction.currentBidder;
    const characterValue = getAiCharacterValue(char);
    const budgetComfort = Math.min(aiPlayer.budget, Math.max(8, Math.round(characterValue * 0.8)));

    if (currentBid === 0) {
        if (characterValue >= 20 && aiPlayer.budget >= 1 && Math.random() < (characterValue >= 40 ? 0.9 : 0.6)) {
            return char.tier === "X" || char.tier === "SSS" ? 5 : (characterValue >= 28 ? 2 : 1);
        }
        return 0;
    }

    if (currentLeader === 1) {
        return 0;
    }

    const isHighValue = characterValue >= 24;
    const stillWorthIt = currentBid <= budgetComfort && currentBid <= Math.max(6, characterValue * 0.8);
    const shouldPressure = currentBid < Math.max(6, characterValue * 0.55) && isHighValue && Math.random() < 0.7;
    const shouldRetreat = currentBid >= budgetComfort || currentBid > humanPlayer.budget * 0.9;

    if (shouldRetreat) return 0;
    if (stillWorthIt || shouldPressure) {
        const step = currentBid >= 10 ? 2 : currentBid >= 5 ? 2 : 1;
        const amount = Math.min(step, Math.max(1, Math.min(aiPlayer.budget - currentBid, budgetComfort - currentBid + 1, 5)));
        return amount > 0 && currentBid + amount <= aiPlayer.budget ? amount : 0;
    }

    return 0;
}

function scheduleAiDecision() {
    if (GameState.currentMode !== "ai" || GameState.currentScreen !== "screen-auction" || GameState.aiThinking || GameState.auction.resolving) {
        return;
    }
    if (GameState.auction.currentBidder === 1) {
        return;
    }

    GameState.aiThinking = true;
    const char = GameState.auction.pool[GameState.auction.currentIndex];
    const delay = 1100 + Math.random() * 900;

    setTimeout(() => {
        if (GameState.currentMode !== "ai" || GameState.currentScreen !== "screen-auction" || GameState.auction.resolving) {
            GameState.aiThinking = false;
            return;
        }

        const action = getAiBidDecision(char);
        if (action > 0) {
            handleBid(1, action);
        } else if (GameState.auction.currentBid === 0 || GameState.auction.currentBidder === 0) {
            handleBid(1, 0);
        }

        GameState.aiThinking = false;
    }, delay);
}

// ==================== BIDDING ====================
function handleBid(playerIndex, amount) {
    if (GameState.auction.resolving) return;

    const player = GameState.players[playerIndex];

    if (GameState.currentMode === "ai" && playerIndex === 1 && amount > 0) {
        const aiMax = Math.min(player.budget, 30);
        if (GameState.auction.currentBid + amount > aiMax) {
            return;
        }
    }

    if (amount === 0) {
        // PASS
        GameState.auction.passed[playerIndex] = true;
        sfxPass();
        addAuctionLog(`${player.name} passes!`, `log-p${playerIndex + 1}`);
        updatePlayerBidStatus();

        // If both pass or only one bidder passed and the other has the bid
        if (GameState.auction.passed[0] && GameState.auction.passed[1]) {
            clearInterval(GameState.auction.timer);
            resolveBid();
            return;
        }
        // If current bidder is the other player and this one passes, auto-sell
        if (GameState.auction.currentBidder !== null && GameState.auction.currentBidder !== playerIndex) {
            clearInterval(GameState.auction.timer);
            resolveBid();
            return;
        }
        return;
    }

    const newBid = GameState.auction.currentBid + amount;
    if (newBid > player.budget) return;
    GameState.auction.currentBid = newBid;
    GameState.auction.currentBidder = playerIndex;
    GameState.auction.playerBids[playerIndex] = newBid;
    GameState.auction.passed = [false, false]; // Reset passes on new bid

    sfxBidAmount(amount);

    updatePlayerBidStatus(playerIndex);
    addAuctionLog(`${player.name} bids $${newBid}!`, `log-p${playerIndex + 1}`);

    // Reset timer on bid
    GameState.auction.timeLeft = Math.min(GameState.auction.timeLeft + 3, GameState.auction.maxTime);
    updateTimerUI();
    updateAuctionUI();

    if (GameState.currentMode === "ai" && playerIndex === 0) {
        scheduleAiDecision();
    }
}

async function resolveBid() {
    if (GameState.auction.resolving) return;
    GameState.auction.resolving = true;
    clearInterval(GameState.auction.timer);

    qsa(".btn-bid, .btn-bid-pass").forEach(btn => { btn.disabled = true; });

    const char = GameState.auction.pool[GameState.auction.currentIndex];
    const overlay = $("card-result-overlay");
    const resultText = $("card-result-text");

    if (GameState.auction.currentBidder !== null) {
        const winner = GameState.players[GameState.auction.currentBidder];
        winner.budget -= GameState.auction.currentBid;
        winner.team.push({ ...char });
        sfxSold();
        resultText.textContent = `${winner.name} has won ${char.name}!`;
        resultText.className = `card-result-text winner p${GameState.auction.currentBidder + 1}-win`;
        addAuctionLog(
            `🔨 SOLD! ${char.name} goes to ${winner.name} for $${GameState.auction.currentBid}!`,
            "log-sold"
        );
    } else {
        resultText.textContent = `${char.name} goes unsold!`;
        resultText.className = "card-result-text unsold";
        addAuctionLog(`${char.name} goes unsold! No bids.`, "log-system");
    }

    overlay.classList.remove("hidden");
    overlay.classList.add("show");
    await sleep(2200);
    overlay.classList.remove("show");
    overlay.classList.add("hidden");

    GameState.auction.currentIndex++;
    updateAuctionUI();

    if (GameState.auction.currentIndex >= GameState.auction.pool.length) {
        endAuction();
    } else {
        presentCharacter();
    }
}

function addAuctionLog(message, className = "") {
    const log = $("auction-log");
    const entry = document.createElement("div");
    entry.className = `log-entry ${className}`;
    entry.textContent = message;
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
}

// Attach bid listeners
document.addEventListener("click", (e) => {
    if (e.target.classList.contains("btn-bid") || e.target.classList.contains("btn-bid-pass")) {
        const player = parseInt(e.target.dataset.player) - 1;
        const amount = parseInt(e.target.dataset.amount);
        if (!e.target.disabled) {
            if (GameState.currentMode === "online") {
                if (player !== GameState.online.myPlayerIndex) return;
                ensureAudioReady();
                submitOnlineBid(amount);
                return;
            }
            ensureAudioReady();
            handleBid(player, amount);
        }
    }
});

// Keyboard shortcuts for bidding
document.addEventListener("keydown", (e) => {
    if (GameState.currentScreen !== "screen-auction") return;

    if (GameState.currentMode === "online") {
        const key = e.key.toLowerCase();
        const playerIndex = GameState.online.myPlayerIndex;
        const shortcuts = playerIndex === 0
            ? { q: 1, w: 2, e: 5, r: 0 }
            : playerIndex === 1
                ? { u: 1, i: 2, o: 5, p: 0 }
                : {};
        if ("qweruiop".includes(key)) {
            e.preventDefault();
            if (Object.prototype.hasOwnProperty.call(shortcuts, key)) {
                ensureAudioReady();
                submitOnlineBid(shortcuts[key]);
            }
        }
        return;
    }

    // Player 1: Q/W/E = +1/+2/+5, R = Pass
    if (e.key === "q" || e.key === "Q") handleBid(0, 1);
    if (e.key === "w" || e.key === "W") handleBid(0, 2);
    if (e.key === "e" || e.key === "E") handleBid(0, 5);
    if (e.key === "r" || e.key === "R") handleBid(0, 0);

    if (GameState.currentMode === "ai") return;

    // Player 2: U/I/O = +1/+2/+5, P = Pass
    if (e.key === "u" || e.key === "U") handleBid(1, 1);
    if (e.key === "i" || e.key === "I") handleBid(1, 2);
    if (e.key === "o" || e.key === "O") handleBid(1, 5);
    if (e.key === "p" || e.key === "P") handleBid(1, 0);
});

// ==================== END AUCTION / TEAM REVIEW ====================
function endAuction() {
    playBackgroundMusic();

    const anyWon = GameState.players.some(player => player.team.length > 0);

    if (!anyWon) {
        addAuctionLog("🏁 No bids were placed, so no one receives any characters.", "log-system");
    }

    applySynergies();

    setTimeout(() => {
        showScreen("screen-power-reveal");
        startPowerRevealSequence();
    }, 1000);
}

// ==================== POWER REVEAL (post-auction) ====================
let powerRevealAbort = null;

function setPowerPhase(phaseId) {
    qsa("#screen-power-reveal .power-reveal-phase").forEach(el => el.classList.add("hidden"));
    if (phaseId) $(phaseId).classList.remove("hidden");
}

function formatPowerLevel(n) {
    return n.toLocaleString("en-US");
}

function formatBattleStats(char) {
    return `HP ${char.hp}  ·  ATK ${char.atk}  ·  DEF ${char.def}  ·  SP ${char.sp}%  ·  SPD ${char.spd}`;
}

async function flashFighter(char, duration = null) {
    const card = $("power-flash-card");
    const tierClass = `tier-${char.tier.toLowerCase()}`;
    card.className = `power-flash-card ${tierClass}`;
    card.classList.remove("flash-in");
    void card.offsetWidth;
    if (["X", "SSS", "S"].includes(char.tier)) {
        card.classList.add("tier-spotlight");
    }
    setCharacterAvatar($("power-flash-avatar"), char, "char-avatar-lg");
    $("power-flash-name").textContent = char.name;
    $("power-flash-combat-stats").textContent = formatBattleStats(char);
    $("power-flash-ultimate").textContent = `🌟 ${char.ultimate}`;
    $("power-flash-ability").textContent = char.abilityDesc ? `✨ ${char.abilityDesc}` : "";
    $("power-flash-value").textContent = formatPowerLevel(getCharacterPowerLevel(char));
    card.classList.add("flash-in");
    if (char.tier === "SSS") {
        sfxXTierReveal();
    } else if (char.tier === "X") {
        // X cards keep their custom character audio; no extra generic reveal sting here.
    } else {
        sfxBid();
    }
    await sleep(duration ?? (char.tier === "X" ? 2000 : 1400));
}

async function revealPlayerRoster(playerIndex) {
    const player = GameState.players[playerIndex];
    $("power-roster-name").textContent = player.name;
    $("power-roster-name").className = `power-roster-name ${playerIndex === 0 ? "name-red" : "name-blue"}`;
    $("power-roster-total").classList.add("hidden");
    $("power-flash-card").classList.remove("hidden");

    for (const char of player.team) {
        if (GameState.powerRevealSkip) return;
        await flashFighter(char);
    }

    $("power-flash-card").classList.add("hidden");
    $("power-roster-total-value").textContent = formatPowerLevel(teamTotalPower(player));
    $("power-roster-total").classList.remove("hidden");
    await sleep(1800);
}

function buildCompareList(container, team) {
    container.innerHTML = team.map(c => `
        <div class="power-compare-row">
            ${characterAvatarHTML(c, "char-avatar-sm")}
            <span class="pcr-name">${c.name}</span>
            <span class="pcr-pl">${formatPowerLevel(getCharacterPowerLevel(c))}</span>
        </div>
    `).join("");
}

function buildPerFighterCharts(p1Team, p2Team, maxPl) {
    const body = $("power-charts-body");
    const rows = Math.max(p1Team.length, p2Team.length);
    body.innerHTML = "";
    for (let i = 0; i < rows; i++) {
        const c1 = p1Team[i];
        const c2 = p2Team[i];
        const row = document.createElement("div");
        row.className = "power-chart-row";
        row.innerHTML = `
            <div class="pcr-slot pcr-slot-red">
                ${c1 ? `<div class="pcr-slot-label">${characterAvatarHTML(c1, "char-avatar-inline")}<span>${c1.name}</span></div>
                <div class="pcr-bar-track"><div class="pcr-bar-fill pcr-red" data-w="${getCharacterPowerLevel(c1)}"></div></div>
                <span class="pcr-slot-val">${formatPowerLevel(getCharacterPowerLevel(c1))}</span>` : ""}
            </div>
            <div class="pcr-slot pcr-slot-blue">
                ${c2 ? `<div class="pcr-slot-label">${characterAvatarHTML(c2, "char-avatar-inline")}<span>${c2.name}</span></div>
                <div class="pcr-bar-track"><div class="pcr-bar-fill pcr-blue" data-w="${getCharacterPowerLevel(c2)}"></div></div>
                <span class="pcr-slot-val">${formatPowerLevel(getCharacterPowerLevel(c2))}</span>` : ""}
            </div>
        `;
        body.appendChild(row);
    }
    requestAnimationFrame(() => {
        body.querySelectorAll(".pcr-bar-fill").forEach(bar => {
            const w = parseInt(bar.dataset.w, 10) || 0;
            bar.style.width = `${Math.max(4, (w / maxPl) * 100)}%`;
        });
    });
}

function animateTotalBars(p1Total, p2Total) {
    const maxTotal = Math.max(p1Total, p2Total, 1);
    $("ptb-p1-val").textContent = formatPowerLevel(p1Total);
    $("ptb-p2-val").textContent = formatPowerLevel(p2Total);
    $("ptb-p1-fill").style.width = "0%";
    $("ptb-p2-fill").style.width = "0%";
    requestAnimationFrame(() => {
        setTimeout(() => {
            $("ptb-p1-fill").style.width = `${(p1Total / maxTotal) * 100}%`;
            $("ptb-p2-fill").style.width = `${(p2Total / maxTotal) * 100}%`;
        }, 100);
    });
}

function announcePowerWinner(p1Total, p2Total) {
    const p1 = GameState.players[0];
    const p2 = GameState.players[1];
    const banner = $("power-winner-banner");
    let text;
    if (p1Total > p2Total) {
        text = `${p1.name} has the highest overall power level!`;
    } else if (p2Total > p1Total) {
        text = `${p2.name} has the highest overall power level!`;
    } else {
        text = "Both players have equal overall power levels.";
    }
    $("power-winner-text").textContent = text;
    banner.classList.remove("hidden");
    sfxBid();
}

async function startPowerRevealSequence() {
    const sequenceId = ++powerRevealSequenceId;
    GameState.powerRevealSkip = false;
    powerRevealAbort = { skip: false };

    const p1 = GameState.players[0];
    const p2 = GameState.players[1];
    const p1Total = teamTotalPower(p1);
    const p2Total = teamTotalPower(p2);
    const maxPl = Math.max(
        ...p1.team.map(getCharacterPowerLevel),
        ...p2.team.map(getCharacterPowerLevel),
        1
    );

    $("power-roster-total").classList.add("hidden");
    $("power-flash-card").classList.remove("hidden");
    $("power-winner-banner").classList.add("hidden");
    $("btn-power-continue").classList.add("hidden");

    setPowerPhase("power-phase-intro");
    await sleep(1500);
    if (sequenceId !== powerRevealSequenceId) return;
    if (GameState.powerRevealSkip) return finishPowerRevealSkipped(p1Total, p2Total, maxPl);

    setPowerPhase("power-phase-roster");
    await revealPlayerRoster(0);
    if (sequenceId !== powerRevealSequenceId) return;
    if (GameState.powerRevealSkip) return finishPowerRevealSkipped(p1Total, p2Total, maxPl);

    await revealPlayerRoster(1);
    if (sequenceId !== powerRevealSequenceId) return;
    if (GameState.powerRevealSkip) return finishPowerRevealSkipped(p1Total, p2Total, maxPl);

    setPowerPhase("power-phase-compare");
    $("power-compare-p1-name").textContent = p1.name;
    $("power-compare-p2-name").textContent = p2.name;
    buildCompareList($("power-compare-p1-list"), p1.team);
    buildCompareList($("power-compare-p2-list"), p2.team);
    $("power-compare-p1-sum").textContent = formatPowerLevel(p1Total);
    $("power-compare-p2-sum").textContent = formatPowerLevel(p2Total);
    await sleep(2500);
    if (sequenceId !== powerRevealSequenceId) return;
    if (GameState.powerRevealSkip) return finishPowerRevealSkipped(p1Total, p2Total, maxPl);

    setPowerPhase("power-phase-charts");
    $("power-chart-p1-label").textContent = p1.name;
    $("power-chart-p2-label").textContent = p2.name;
    $("ptb-p1-name").textContent = p1.name;
    $("ptb-p2-name").textContent = p2.name;
    buildPerFighterCharts(p1.team, p2.team, maxPl);
    animateTotalBars(p1Total, p2Total);
    await sleep(1200);
    if (sequenceId !== powerRevealSequenceId) return;
    announcePowerWinner(p1Total, p2Total);
    $("btn-power-continue").classList.remove("hidden");
}

function finishPowerRevealSkipped(p1Total, p2Total, maxPl) {
    const p1 = GameState.players[0];
    const p2 = GameState.players[1];
    setPowerPhase("power-phase-charts");
    $("power-chart-p1-label").textContent = p1.name;
    $("power-chart-p2-label").textContent = p2.name;
    $("ptb-p1-name").textContent = p1.name;
    $("ptb-p2-name").textContent = p2.name;
    buildPerFighterCharts(p1.team, p2.team, maxPl);
    animateTotalBars(p1Total, p2Total);
    announcePowerWinner(p1Total, p2Total);
    $("btn-power-continue").classList.remove("hidden");
}

$("btn-skip-reveal").addEventListener("click", () => {
    powerRevealSequenceId++;
    GameState.powerRevealSkip = true;
    const p1Total = teamTotalPower(GameState.players[0]);
    const p2Total = teamTotalPower(GameState.players[1]);
    const maxPl = Math.max(
        ...GameState.players[0].team.map(getCharacterPowerLevel),
        ...GameState.players[1].team.map(getCharacterPowerLevel),
        1
    );
    finishPowerRevealSkipped(p1Total, p2Total, maxPl);
});

$("btn-power-continue").addEventListener("click", () => {
    sfxBid();
    showTeamReview();
    showScreen("screen-teams");
});

function applySynergies() {
    GameState.players.forEach((player, pIdx) => {
        player.activeSynergies = [];
        SYNERGIES.forEach(syn => {
            const matchingChars = player.team.filter(c => c.tags.includes(syn.requiredTag));
            if (matchingChars.length >= syn.requiredCount) {
                player.activeSynergies.push(syn);
                // Apply stat bonuses to matching characters
                matchingChars.forEach(c => {
                    if (syn.bonus.atk) c.atk += syn.bonus.atk;
                    if (syn.bonus.def) c.def += syn.bonus.def;
                    if (syn.bonus.spd) c.spd += syn.bonus.spd;
                    if (syn.bonus.sp) c.sp += syn.bonus.sp;
                    if (syn.bonus.hp) c.hp += syn.bonus.hp;
                });
            }
        });
    });
}

function showTeamReview() {
    [0, 1].forEach(pIdx => {
        const player = GameState.players[pIdx];
        const p = pIdx + 1;

        $(`team-p${p}-name`).textContent = `${player.name}'s Team`;

        // Calculate team power
        const power = teamTotalPower(player);
        $(`team-p${p}-power`).textContent = formatPowerLevel(power);

        // Render cards
        const cardsDiv = $(`team-p${p}-cards`);
        cardsDiv.innerHTML = player.team.map(c => `
            <div class="team-card tier-${c.tier.toLowerCase()}${["X", "SSS", "S"].includes(c.tier) ? " tier-card-animated" : ""}">
                ${characterAvatarHTML(c, "char-avatar-md tc-avatar")}
                <div class="tc-name">${c.name}</div>
                <div class="tc-series">${c.series}</div>
                <div class="tc-stats">
                    <span>PL: ${formatPowerLevel(getCharacterPowerLevel(c))}</span>
                </div>
                <div class="tc-combat-stats">${formatBattleStats(c)}</div>
                <div class="tc-hp">HP: ${c.hp}</div>
                <div class="tc-ultimate">🌟 ${c.ultimate}</div>
                ${c.abilityDesc ? `<div class="tc-ability">✨ ${c.abilityDesc}</div>` : ""}
            </div>
        `).join("");

        // Render synergies
        const synDiv = $(`team-p${p}-synergies`);
        if (player.activeSynergies && player.activeSynergies.length > 0) {
            synDiv.innerHTML = `<h4>Active Synergies:</h4>` +
                player.activeSynergies.map(s => `
                    <div class="synergy-badge">${s.icon} ${s.name}: ${s.description}</div>
                `).join("");
        } else {
            synDiv.innerHTML = `<div class="no-synergies">No synergies activated</div>`;
        }
    });
}

// ==================== BRACKET VISUALIZATION ====================
function launchTournament() {
    if (battleSequenceRunning) return;
    const allowedScreens = ["screen-power-reveal", "screen-teams", "screen-bracket"];
    if (!allowedScreens.includes(GameState.currentScreen)) return;

    if (GameState.currentScreen === "screen-power-reveal") {
        powerRevealSequenceId++;
        GameState.powerRevealSkip = true;
        showTeamReview();
    }
    showBracket();
    void startBattle();
}

function requestTournamentStart() {
    if (battleSequenceRunning || onlineBattleStartPending) return;
    sfxBid();
    if (GameState.currentMode !== "online") {
        launchTournament();
        return;
    }
    if (!socket?.connected || !GameState.online.roomCode) {
        $("online-room-status").textContent = "Tournament start failed: reconnect to the online room and try again.";
        return;
    }

    onlineBattleStartPending = true;
    $("btn-start-battle").disabled = true;
    socket.timeout(10000).emit("online:startBattle", {
        roomCode: GameState.online.roomCode,
    }, (error, response) => {
        onlineBattleStartPending = false;
        $("btn-start-battle").disabled = false;
        if (error) {
            $("online-room-status").textContent = "Tournament start timed out. Check the room connection and try again.";
        } else if (!response?.ok) {
            $("online-room-status").textContent = response?.message || "Could not start the online tournament.";
        }
    });
}

$("btn-start-battle").addEventListener("click", requestTournamentStart);

function showBracket() {
    GameState.battle.rosters = GameState.players.map((player, owner) =>
        player.team.map(char => ({
            ...char,
            currentHp: char.hp,
            baseAtk: char.atk,
            baseDef: char.def,
            baseSpd: char.spd,
            owner,
        }))
    );
    GameState.battle.nextFighter = [1, 1];
    const [p1Roster, p2Roster] = GameState.battle.rosters;
    GameState.battle.matches = p1Roster.length && p2Roster.length
        ? [{ left: p1Roster[0], right: p2Roster[0] }]
        : [];

    const container = $("bracket-container");
    container.innerHTML = `
        <div class="bracket-match">
            <div class="bracket-round-label">TEAM GAUNTLET — WINNERS KEEP THEIR REMAINING HP</div>
            <div class="bracket-fighters">
                ${[p1Roster, p2Roster].map((roster, owner) => `
                    <div class="bracket-fighter ${owner === 0 ? "bracket-p1" : "bracket-p2"}">
                        <span class="bf-owner">${GameState.players[owner].name}'s lineup</span>
                        ${roster.length ? roster.map(char => `
                            <div class="bf-lineup-entry">
                                ${characterAvatarHTML(char, "char-avatar-sm bf-avatar")}
                                <span class="bf-name">${char.name}</span>
                                <span class="bf-power">PL: ${formatPowerLevel(getCharacterPowerLevel(char))}</span>
                            </div>
                        `).join("") : `<span class="bf-name">No fighters</span>`}
                    </div>
                `).join('<div class="bracket-vs">VS</div>')}
            </div>
            <p class="bracket-round-label">Ultimate chance follows each fighter's SP from turn 1. Survivors carry HP into the next fight.</p>
        </div>
    `;

    showScreen("screen-bracket");
}

$("btn-begin-fights").addEventListener("click", () => {
    sfxBid();
    startBattle();
});

// ==================== BATTLE ENGINE ====================
async function startBattle() {
    if (battleSequenceRunning) return;
    const matches = GameState.battle.matches;
    if (matches.length === 0) {
        GameState.players[0].score = GameState.battle.rosters[0].length ? 1 : 0;
        GameState.players[1].score = GameState.battle.rosters[1].length ? 1 : 0;
        showVictoryScreen();
        return;
    }
    const sequenceId = ++battleSequenceId;
    battleSequenceRunning = true;
    GameState.battle.matchIndex = 0;
    GameState.players[0].score = GameState.battle.rosters[0].length;
    GameState.players[1].score = GameState.battle.rosters[1].length;
    let firstFightStarted = false;
    try {
        await replayBattleRosters(sequenceId);
        if (!isBattleSequenceActive(sequenceId)) return;

        showScreen("screen-battle");
        setupMatch();
        await showMatchIntro(sequenceId);
        firstFightStarted = true;
    } finally {
        if (!firstFightStarted && sequenceId === battleSequenceId) {
            battleSequenceRunning = false;
        }
    }
}

function isBattleSequenceActive(sequenceId) {
    return battleSequenceRunning && sequenceId === battleSequenceId;
}

async function replayBattleRosters(sequenceId) {
    const skipButton = $("btn-skip-reveal");
    const previousDisplay = skipButton.style.display;
    skipButton.style.display = "none";
    setPowerPhase("power-phase-roster");
    $("power-roster-total").classList.add("hidden");
    $("power-flash-card").classList.remove("hidden");
    $("power-winner-banner").classList.add("hidden");
    $("btn-power-continue").classList.add("hidden");
    showScreen("screen-power-reveal");

    try {
        for (let playerIndex = 0; playerIndex < GameState.players.length; playerIndex++) {
            const player = GameState.players[playerIndex];
            $("power-roster-name").textContent = player.name;
            $("power-roster-name").className = `power-roster-name ${playerIndex === 0 ? "name-red" : "name-blue"}`;
            for (const char of player.team) {
                if (!isBattleSequenceActive(sequenceId)) return;
                await flashFighter(char, 1000);
            }
            $("power-flash-card").classList.add("hidden");
            $("power-roster-total-value").textContent = formatPowerLevel(teamTotalPower(player));
            $("power-roster-total").classList.remove("hidden");
            await sleep(500);
            $("power-roster-total").classList.add("hidden");
            $("power-flash-card").classList.remove("hidden");
        }
    } finally {
        skipButton.style.display = previousDisplay;
    }
}

async function showMatchIntro(sequenceId) {
    if (!isBattleSequenceActive(sequenceId)) return;
    const match = GameState.battle.currentFighters;
    const overlay = $("battle-match-intro");
    $("battle-intro-round").textContent = `ROUND ${GameState.battle.matchIndex + 1}`;
    $("battle-intro-left-owner").textContent = GameState.players[match.left.owner].name;
    $("battle-intro-right-owner").textContent = GameState.players[match.right.owner].name;
    setCharacterAvatar($("battle-intro-left-avatar"), match.left, "char-avatar-lg battle-intro-avatar-image");
    setCharacterAvatar($("battle-intro-right-avatar"), match.right, "char-avatar-lg battle-intro-avatar-image");
    $("battle-intro-left-name").textContent = match.left.name;
    $("battle-intro-right-name").textContent = match.right.name;
    $("battle-intro-call").textContent = "";
    overlay.classList.remove("is-winner");
    overlay.setAttribute("aria-hidden", "false");
    overlay.classList.add("show");
    await sleep(BATTLE_INTRO_DURATION_MS);
    if (!isBattleSequenceActive(sequenceId)) return;

    sfxBell();
    overlay.classList.remove("show");
    overlay.setAttribute("aria-hidden", "true");
    scheduleAutomaticTurn(sequenceId, 350);
}

function showRoundWinner(message) {
    const overlay = $("battle-match-intro");
    $("battle-intro-round").textContent = `ROUND ${GameState.battle.matchIndex + 1} OVER`;
    $("battle-intro-call").textContent = message;
    overlay.classList.add("is-winner", "show");
    overlay.setAttribute("aria-hidden", "false");
}

function scheduleAutomaticTurn(sequenceId, delay = BATTLE_MOVE_INTERVAL_MS) {
    clearTimeout(battleTurnTimeout);
    battleTurnTimeout = setTimeout(() => {
        battleTurnTimeout = null;
        if (isBattleSequenceActive(sequenceId) && !GameState.battle.battleOver) {
            executeTurn();
        }
    }, delay);
}

function continueAutomaticTournament(message, hasNextMatch) {
    const sequenceId = battleSequenceId;
    if (!isBattleSequenceActive(sequenceId)) return;

    showRoundWinner(message);
    battleTurnTimeout = setTimeout(() => {
        battleTurnTimeout = null;
        if (!isBattleSequenceActive(sequenceId)) return;
        if (!hasNextMatch) {
            battleSequenceRunning = false;
            $("battle-match-intro").classList.remove("show", "is-winner");
            $("battle-match-intro").setAttribute("aria-hidden", "true");
            showVictoryScreen();
            return;
        }
        $("battle-match-intro").classList.remove("show", "is-winner");
        $("battle-match-intro").setAttribute("aria-hidden", "true");
        GameState.battle.matchIndex++;
        setupMatch();
        showMatchIntro(sequenceId);
    }, BATTLE_WINNER_DURATION_MS);
}

function setupMatch() {
    const match = GameState.battle.matches[GameState.battle.matchIndex];
    resetFighterForMatch(match.left);
    resetFighterForMatch(match.right);
    GameState.battle.currentFighters = match;
    GameState.battle.turnCount = 0;
    GameState.battle.battleOver = false;

    $("battle-match-num").textContent = `FIGHT ${GameState.battle.matchIndex + 1}`;
    $("battle-p1-score").textContent = GameState.players[0].score;
    $("battle-p2-score").textContent = GameState.players[1].score;

    // Left fighter
    $("fighter-left-owner").textContent = GameState.players[match.left.owner].name;
    setCharacterAvatar($("fighter-left-emoji"), match.left, "char-avatar-lg fighter-avatar");
    $("fighter-left-name").textContent = match.left.name;
    updateBattleStats("left", match.left);
    updateHP("left", match.left);

    // Right fighter
    $("fighter-right-owner").textContent = GameState.players[match.right.owner].name;
    setCharacterAvatar($("fighter-right-emoji"), match.right, "char-avatar-lg fighter-avatar");
    $("fighter-right-name").textContent = match.right.name;
    updateBattleStats("right", match.right);
    updateHP("right", match.right);

    // Clear battle log
    $("battle-log").innerHTML = `
        <div class="blog-entry blog-announce">
            ⚔️ ${match.left.name} vs ${match.right.name}!
        </div>
    `;

    // Reset fighter positions
    $("fighter-left").classList.remove("fighter-defeated");
    $("fighter-right").classList.remove("fighter-defeated");
}

function resetFighterForMatch(fighter) {
    fighter.atk = fighter.baseAtk ?? fighter.atk;
    fighter.def = fighter.baseDef ?? fighter.def;
    fighter.spd = fighter.baseSpd ?? fighter.spd;
    fighter.abilityUsed = false;
    fighter.battleStarted = false;
    fighter.atkBuffTurns = 0;
    fighter.defBuffTurns = 0;
    fighter.burns = [];
    fighter.skipNextAttack = false;
    fighter.lastIncomingDamage = 0;
    fighter.lastDamageDealt = 0;
}

function updateHP(side, fighter) {
    const pct = Math.max(0, (fighter.currentHp / fighter.hp) * 100);
    $(`fighter-${side}-hp`).style.width = `${pct}%`;
    $(`fighter-${side}-hp-text`).textContent = `${Math.max(0, Math.round(fighter.currentHp))} HP`;

    if (pct < 25) {
        $(`fighter-${side}-hp`).classList.add("hp-critical");
    } else if (pct < 50) {
        $(`fighter-${side}-hp`).classList.add("hp-low");
        $(`fighter-${side}-hp`).classList.remove("hp-critical");
    } else {
        $(`fighter-${side}-hp`).classList.remove("hp-low", "hp-critical");
    }
}

function updateBattleStats(side, fighter) {
    const prefix = side === "left" ? "fl" : "fr";
    $(`${prefix}-atk`).textContent = `ATK: ${fighter.atk}`;
    $(`${prefix}-def`).textContent = `DEF: ${fighter.def}`;
    $(`${prefix}-spd`).textContent = `SPD: ${fighter.spd}`;
    $(`${prefix}-sp`).textContent = `SP: ${fighter.sp}%`;
}

function executeTurn() {
    if (GameState.battle.battleOver) return;

    const match = GameState.battle.currentFighters;
    GameState.battle.turnCount++;
    applyTurnStartEffects(match);

    let first, second, firstSide, secondSide;
    if (match.left.spd >= match.right.spd) {
        first = match.left; second = match.right;
        firstSide = "left"; secondSide = "right";
    } else {
        first = match.right; second = match.left;
        firstSide = "right"; secondSide = "left";
    }

    let firstSkipped = !!first.skipNextAttack;
    let secondSkipped = !!second.skipNextAttack;
    first.skipNextAttack = false;
    second.skipNextAttack = false;
    if (firstSkipped && !secondSkipped) {
        [first, second] = [second, first];
        [firstSide, secondSide] = [secondSide, firstSide];
        [firstSkipped, secondSkipped] = [secondSkipped, firstSkipped];
    }

    if (first.currentHp <= 0 || second.currentHp <= 0) {
        finishBattleTurn(first, second, firstSide, secondSide);
        return;
    }

    if (firstSkipped && secondSkipped) {
        addBattleLog("⏭️ Both fighters lose their attack this turn.", "blog-announce");
        finishBattleTurn(first, second, firstSide, secondSide);
        return;
    }

    if (firstSkipped) {
        addBattleLog(`⏭️ ${first.name} loses their attack.`, "blog-announce");
        finishBattleTurn(first, second, firstSide, secondSide);
        return;
    }

    const result1 = calculateAttack(first, second);
    resolveBattleAttack(first, second, result1, firstSide, secondSide);

    const secondWasSkipped = secondSkipped || !!second.skipNextAttack || result1.skipCounter;
    if (secondWasSkipped) {
        second.skipNextAttack = false;
        addBattleLog(`⏭️ ${second.name} loses their attack.`, "blog-announce");
    }
    const secondCanCounter = second.currentHp > 0 && !secondWasSkipped;
    if (!secondCanCounter) {
        finishBattleTurn(first, second, firstSide, secondSide);
        return;
    }

    battleTurnTimeout = setTimeout(() => {
        battleTurnTimeout = null;
        const result2 = calculateAttack(second, first);
        resolveBattleAttack(second, first, result2, secondSide, firstSide);
        finishBattleTurn(first, second, firstSide, secondSide);
    }, BATTLE_MOVE_INTERVAL_MS);
}

function calculateAttack(attacker, defender) {
    const seededRoll = (salt, max) => {
        const seedText = `${GameState.online.roomCode}:${GameState.battle.matchIndex}:${GameState.battle.turnCount}:${attacker.id}:${defender.id}:${salt}`;
        let seed = 2166136261;
        for (let index = 0; index < seedText.length; index++) {
            seed = Math.imul(seed ^ seedText.charCodeAt(index), 16777619);
        }
        return ((seed >>> 0) % max) + 1;
    };
    const roll = GameState.currentMode === "online" ? seededRoll("attack", 20) : d20();
    const ultimateRoll = GameState.currentMode === "online" ? seededRoll("ultimate", 100) : d100();
    const isUltimate = ultimateRoll <= attacker.sp;
    const defenseFactor = attacker.abilityKey === "ignore25Def"
        ? 0.75
        : attacker.abilityKey === "ignore20Def" ? 0.8 : 1;
    let baseDamage = (attacker.atk + roll) - (defender.def * defenseFactor / 2);
    baseDamage = Math.max(1, baseDamage);

    let damage = baseDamage;
    let log = "";
    let copiedDamage = false;

    if (attacker.abilityKey === "copyDamage" && attacker.lastIncomingDamage > 0) {
        damage = attacker.lastIncomingDamage;
        copiedDamage = true;
        log = `🌌 ${attacker.name} copies the enemy's last hit for ${damage} DMG!`;
    } else if (attacker.abilityKey === "repeatDamage" && attacker.lastIncomingDamage > 0 && !attacker.abilityUsed) {
        damage += attacker.lastIncomingDamage;
        attacker.abilityUsed = true;
        log = `${attacker.name} repeats the enemy's last hit for ${damage} DMG!`;
    }

    if (!copiedDamage && isUltimate) {
        damage = Math.round(baseDamage * attacker.ultimateMultiplier);
        log = `🌟 ${attacker.name} uses ${attacker.ultimate}! (Roll: ${roll}) → ${damage} DMG!`;
    } else if (!copiedDamage && !log) {
        damage = Math.round(baseDamage);
        log = `${attacker.name} attacks! (Roll: ${roll}) → ${damage} DMG`;
    }

    const dodgeRoll = GameState.currentMode === "online" ? seededRoll("dodge", 100) : d100();
    let dodgeChance = isUltimate ? 0 : Math.max(0, (defender.spd - attacker.spd) / 2);
    if (defender.abilityKey === "foresight" && GameState.battle.turnCount === 1) dodgeChance = Math.max(dodgeChance, 25);
    if (defender.abilityKey === "dodge15") dodgeChance = Math.max(dodgeChance, 15);
    if (defender.abilityKey === "dodge12") dodgeChance = Math.max(dodgeChance, 12);
    if (defender.abilityKey === "gokuDodge" && defender.currentHp < defender.hp * 0.4) dodgeChance = 100;
    if (dodgeRoll <= dodgeChance) {
        damage = 0;
        log = `💨 ${defender.name} dodges ${attacker.name}'s attack!`;
    } else if (damage > 0 && defender.abilityKey === "negateHit" && !defender.abilityUsed) {
        defender.abilityUsed = true;
        damage = 0;
        log = `🌀 ${defender.name} negates the hit with ${defender.name === "Gojo" ? "Infinity" : "Teleport Swap"}!`;
    }

    if (damage > 0) {
        if (defender.abilityKey === "halveUltimate" && isUltimate) damage = Math.ceil(damage / 2);
        if (defender.abilityKey === "reduceDamage15") damage = Math.round(damage * 0.85);
        if (defender.abilityKey === "glassCannon") damage = Math.round(damage * 1.1);
        if (attacker.abilityKey === "crit25" && (GameState.currentMode === "online" ? seededRoll("critical", 100) : d100()) <= 20) {
            damage = Math.round(damage * 1.25);
            log += " Critical hit!";
        }
        if (attacker.abilityKey === "crit50" && (GameState.currentMode === "online" ? seededRoll("critical", 100) : d100()) <= 20) {
            damage = Math.round(damage * 1.5);
            log += " Thunder critical!";
        }
        if ((attacker.abilityKey === "secondSlash" && (GameState.currentMode === "online" ? seededRoll("extra-hit", 100) : d100()) <= 20) ||
            (attacker.abilityKey === "doubleHit15" && (GameState.currentMode === "online" ? seededRoll("extra-hit", 100) : d100()) <= 15)) {
            damage += Math.round(baseDamage);
            log += " Double hit!";
        }
    }

    const skipCounter = damage > 0 && attacker.abilityKey === "skipTurn" && !attacker.abilityUsed;
    if (skipCounter) {
        attacker.abilityUsed = true;
        defender.skipNextAttack = true;
        log += ` ${attacker.name} skips ${defender.name}'s next attack!`;
    }
    const applyBurn = damage > 0 && attacker.abilityKey === "burn3";
    return { damage, log, isUltimate, applyBurn, skipCounter };
}

function resolveBattleAttack(attacker, defender, result, attackerSide, defenderSide) {
    addBattleLog(result.log, attackerSide);
    defender.currentHp = Math.max(0, defender.currentHp - result.damage);
    if (result.damage > 0) {
        attacker.lastDamageDealt = result.damage;
        defender.lastIncomingDamage = result.damage;
        if (attacker.abilityKey === "stealDef") {
            const stolen = Math.min(3, defender.def);
            defender.def -= stolen;
            attacker.def += stolen;
        }
        if (defender.abilityKey === "buffOnHit2") defender.atk += 2;
        if (defender.abilityKey === "buffDefOnHit") defender.def += 1;
        if (defender.abilityKey === "lowHpAtk6" && !defender.abilityUsed && defender.currentHp <= defender.hp * 0.35) {
            defender.atk += 6;
            defender.abilityUsed = true;
            addBattleLog(`🔥 ${defender.name} powers up below 35% HP!`, defenderSide);
        }
        if (defender.abilityKey === "undoHit" && !defender.abilityUsed) {
            defender.currentHp = Math.min(defender.hp, defender.currentHp + result.damage);
            defender.abilityUsed = true;
            addBattleLog(`⏪ ${defender.name} rewinds the damage from that hit!`, defenderSide);
        }
        if (result.applyBurn) {
            defender.burns = defender.burns || [];
            defender.burns.push({ damage: 3, turnsLeft: 3 });
            addBattleLog(`🔥 ${defender.name} is burning for 3 turns!`, attackerSide);
        }
    }
    if (defender.currentHp <= 0 && defender.abilityKey === "revive20" && !defender.abilityUsed) {
        defender.currentHp = Math.ceil(defender.hp * 0.2);
        defender.abilityUsed = true;
        addBattleLog(`🌑 ${defender.name} revives with ${defender.currentHp} HP!`, defenderSide);
    }
    updateBattleStats(attackerSide, attacker);
    updateBattleStats(defenderSide, defender);
    updateHP(defenderSide, defender);
    animateAttack(attackerSide);
    if (result.isUltimate) {
        sfxUltimate();
        showBattleEffect(attacker.ultimate + "!", attacker.color);
    } else if (result.damage > 0) {
        sfxHit();
    }
}

function applyTurnStartEffects(match) {
    const fighters = [match.left, match.right];
    const atkLosses = [0, 0];
    fighters.forEach((fighter, index) => {
        const opponent = fighters[1 - index];
        const ability = fighter.abilityKey;
        if (ability === "regen5") fighter.currentHp = Math.min(fighter.hp, fighter.currentHp + fighter.hp * 0.05);
        if (ability === "regen4") fighter.currentHp = Math.min(fighter.hp, fighter.currentHp + fighter.hp * 0.04);
        if (ability === "regen6") fighter.currentHp = Math.min(fighter.hp, fighter.currentHp + 6);
        if (ability === "growAtk2") fighter.atk += 2;
        if (ability === "growAtk1") fighter.atk += 1;
        if (ability === "lowerDef2") opponent.def = Math.max(0, opponent.def - 2);
        if (ability === "stealAtk") atkLosses[1 - index] += Math.max(1, Math.round(opponent.atk * 0.1));
        if (ability === "eightGates") {
            if (!fighter.abilityUsed) {
                fighter.atk += 6;
                fighter.abilityUsed = true;
            }
            fighter.currentHp = Math.max(0, fighter.currentHp - 5);
        }
        if (ability === "buffAtk3" && !fighter.abilityUsed) {
            fighter.atk += 5;
            fighter.abilityUsed = true;
            fighter.atkBuffTurns = 3;
        }
        if (ability === "buffDef4" && !fighter.abilityUsed) {
            fighter.def += 4;
            fighter.abilityUsed = true;
            fighter.defBuffTurns = 2;
        }
        if (!fighter.battleStarted) {
            if (ability === "slow10") opponent.spd = Math.max(0, opponent.spd - 10);
            if (ability === "slow8") opponent.spd = Math.max(0, opponent.spd - 8);
            fighter.battleStarted = true;
        }
    });
    fighters.forEach((fighter, index) => {
        if (atkLosses[index]) {
            fighter.atk = Math.max(1, fighter.atk - atkLosses[index]);
            fighters[1 - index].atk += atkLosses[index];
        }
        updateBattleStats(index === 0 ? "left" : "right", fighter);
        updateHP(index === 0 ? "left" : "right", fighter);
    });
}

function finishBattleTurn(first, second, firstSide, secondSide) {
    [first, second].forEach((fighter, index) => {
        fighter.burns = fighter.burns || [];
        fighter.burns = fighter.burns.filter(burn => {
            fighter.currentHp = Math.max(0, fighter.currentHp - burn.damage);
            burn.turnsLeft--;
            addBattleLog(`🔥 ${fighter.name} takes ${burn.damage} burn damage.`, index === 0 ? firstSide : secondSide);
            if (fighter.currentHp <= 0 && fighter.abilityKey === "revive20" && !fighter.abilityUsed) {
                fighter.currentHp = Math.ceil(fighter.hp * 0.2);
                fighter.abilityUsed = true;
                addBattleLog(`🌑 ${fighter.name} revives with ${fighter.currentHp} HP!`, index === 0 ? firstSide : secondSide);
            }
            return burn.turnsLeft > 0;
        });
        if (fighter.atkBuffTurns) {
            fighter.atkBuffTurns--;
            if (!fighter.atkBuffTurns) fighter.atk -= 5;
        }
        if (fighter.defBuffTurns) {
            fighter.defBuffTurns--;
            if (!fighter.defBuffTurns) fighter.def -= 4;
        }
        updateBattleStats(index === 0 ? firstSide : secondSide, fighter);
        updateHP(index === 0 ? firstSide : secondSide, fighter);
    });

    const firstDefeated = first.currentHp <= 0;
    const secondDefeated = second.currentHp <= 0;
    if (firstDefeated && secondDefeated) {
        first.currentHp = 0;
        second.currentHp = 0;
        updateHP(firstSide, first);
        updateHP(secondSide, second);
        endMatch(null);
    } else if (firstDefeated) {
        first.currentHp = 0;
        updateHP(firstSide, first);
        endMatch(second);
    } else if (secondDefeated) {
        second.currentHp = 0;
        updateHP(secondSide, second);
        endMatch(first);
    } else if (battleSequenceRunning) {
        scheduleAutomaticTurn(battleSequenceId);
    }
}

function addBattleLog(message, side = "") {
    const log = $("battle-log");
    const entry = document.createElement("div");
    entry.className = `blog-entry blog-${side}`;
    entry.textContent = message;
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
}

function animateAttack(side) {
    const fighter = $(`fighter-${side}`);
    fighter.classList.add("attacking");
    setTimeout(() => fighter.classList.remove("attacking"), 400);

    const otherSide = side === "left" ? "right" : "left";
    const other = $(`fighter-${otherSide}`);
    other.classList.add("hit");
    setTimeout(() => other.classList.remove("hit"), 300);
}

function showBattleEffect(text, color) {
    const effect = $("battle-effect");
    effect.textContent = text;
    effect.style.color = color;
    effect.classList.add("show");
    setTimeout(() => effect.classList.remove("show"), 1200);
}

function endMatch(winner) {
    GameState.battle.battleOver = true;
    const match = GameState.battle.currentFighters;
    const leftDefeated = match.left.currentHp <= 0;
    const rightDefeated = match.right.currentHp <= 0;
    if (leftDefeated) $("fighter-left").classList.add("fighter-defeated");
    if (rightDefeated) $("fighter-right").classList.add("fighter-defeated");
    if (leftDefeated) {
        GameState.players[match.left.owner].score = Math.max(0, GameState.players[match.left.owner].score - 1);
    }
    if (rightDefeated) {
        GameState.players[match.right.owner].score = Math.max(0, GameState.players[match.right.owner].score - 1);
    }
    $("battle-p1-score").textContent = GameState.players[0].score;
    $("battle-p2-score").textContent = GameState.players[1].score;

    if (leftDefeated && rightDefeated) {
        addBattleLog("💥 DOUBLE K.O.! Both teams send in their next fighter.", "blog-announce");
        const nextLeft = GameState.battle.rosters[0][GameState.battle.nextFighter[0]];
        const nextRight = GameState.battle.rosters[1][GameState.battle.nextFighter[1]];
        if (nextLeft && nextRight) {
            GameState.battle.nextFighter[0]++;
            GameState.battle.nextFighter[1]++;
            GameState.battle.matches.push({
                left: { ...nextLeft, currentHp: nextLeft.hp },
                right: { ...nextRight, currentHp: nextRight.hp },
            });
            continueAutomaticTournament("DOUBLE K.O.! NEXT FIGHTERS UP", true);
        } else {
            continueAutomaticTournament("DOUBLE K.O.! TOURNAMENT OVER", false);
        }
        return;
    }

    addBattleLog(`🏆 ${winner.name} WINS THE ROUND!`, "blog-announce");

    const defeated = leftDefeated ? match.left : match.right;
    const defeatedOwner = defeated.owner;
    const nextIndex = GameState.battle.nextFighter[defeatedOwner];
    const nextFighter = GameState.battle.rosters[defeatedOwner][nextIndex];

    if (!nextFighter) {
        continueAutomaticTournament(`${winner.name} WINS!`, false);
    } else {
        GameState.battle.nextFighter[defeatedOwner] += 1;
        const replacement = {
            ...nextFighter,
            currentHp: nextFighter.hp,
        };
        GameState.battle.matches.push(defeatedOwner === 0
            ? { left: replacement, right: winner }
            : { left: winner, right: replacement });
        continueAutomaticTournament(`${winner.name} WINS!`, true);
    }
}

// ==================== VICTORY SCREEN ====================
function showVictoryScreen() {
    battleSequenceRunning = false;
    const p1 = GameState.players[0];
    const p2 = GameState.players[1];

    let winnerName, finalScore;
    if (p1.score > p2.score) {
        winnerName = p1.name;
        finalScore = `${p1.score} - ${p2.score}`;
    } else if (p2.score > p1.score) {
        winnerName = p2.name;
        finalScore = `${p2.score} - ${p1.score}`;
    } else {
        winnerName = "IT'S A TIE";
        finalScore = `${p1.score} - ${p2.score}`;
    }

    $("victory-title").textContent = winnerName === "IT'S A TIE" ? "IT'S A TIE!" : `${winnerName} WINS!`;
    $("victory-subtitle").textContent = `GAME OVER · Fighters Standing: ${finalScore}`;

    // Stats summary
    $("victory-stats").innerHTML = `
        <div class="v-stat-row">
            <div class="v-stat p1-v">
                <h4>${p1.name}</h4>
                <p>Team: ${p1.team.map(c => c.name).join(", ")}</p>
                <p>Total Power: ${formatPowerLevel(teamTotalPower(p1))}</p>
                <p>Budget Remaining: ${formatBudget(p1.budget)}</p>
                <p>Synergies: ${(p1.activeSynergies || []).length}</p>
            </div>
            <div class="v-stat p2-v">
                <h4>${p2.name}</h4>
                <p>Team: ${p2.team.map(c => c.name).join(", ")}</p>
                <p>Total Power: ${formatPowerLevel(teamTotalPower(p2))}</p>
                <p>Budget Remaining: ${formatBudget(p2.budget)}</p>
                <p>Synergies: ${(p2.activeSynergies || []).length}</p>
            </div>
        </div>
    `;

    showScreen("screen-victory");
    sfxVictory();
    startConfetti();
}

// ==================== CONFETTI ====================
function startConfetti() {
    const canvas = $("confetti-canvas");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext("2d");
    const confettiPieces = [];
    const colors = ["#a855f7", "#ec4899", "#f59e0b", "#10b981", "#3b82f6", "#ef4444", "#fbbf24"];

    for (let i = 0; i < 200; i++) {
        confettiPieces.push({
            x: Math.random() * canvas.width,
            y: Math.random() * -canvas.height,
            w: rand(5, 12),
            h: rand(3, 8),
            color: colors[rand(0, colors.length - 1)],
            vy: Math.random() * 3 + 2,
            vx: (Math.random() - 0.5) * 2,
            rot: Math.random() * 360,
            rotSpeed: (Math.random() - 0.5) * 10,
        });
    }

    let frameCount = 0;
    function animateConfetti() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        confettiPieces.forEach(p => {
            p.x += p.vx;
            p.y += p.vy;
            p.rot += p.rotSpeed;
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate((p.rot * Math.PI) / 180);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            ctx.restore();
        });
        frameCount++;
        if (frameCount < 300) {
            requestAnimationFrame(animateConfetti);
        }
    }
    animateConfetti();
}

// ==================== PLAY AGAIN ====================
$("btn-play-again").addEventListener("click", () => {
    resetGameState();
    localStorage.removeItem("aaa_save");
    if (GameState.currentMode === "online" && socket?.connected && GameState.online.roomCode) {
        updateOnlineLobbyControls();
        updateOnlineBidControls();
        $("online-room-status").textContent = GameState.online.myPlayerIndex === 0
            ? "Same room, same players. Start the next auction when you're ready."
            : "Same room, same players. Waiting for the room creator to start again.";
        showScreen("screen-lobby");
        return;
    }
    showScreen("screen-lobby");
});

const homeDialog = $("home-confirm-dialog");

$("btn-home-global").addEventListener("click", () => {
    homeDialog.showModal();
});

$("btn-home-cancel").addEventListener("click", () => {
    homeDialog.close();
});

$("btn-home-confirm").addEventListener("click", () => {
    homeDialog.close();
    let hasReturnedHome = false;
    const returnHome = () => {
        if (hasReturnedHome) return;
        hasReturnedHome = true;
        GameState.currentMode = "friend";
        GameState.online.roomCode = "";
        GameState.online.myPlayerIndex = null;
        GameState.online.state = null;
        GameState.online.connected = false;
        if (socket?.connected) socket.disconnect();
        localStorage.removeItem(ONLINE_ROOM_CODE_KEY);
        localStorage.removeItem("aaa_save");
        resetGameState();
        stopCharacterTheme();
        if (GameState.soundEnabled) playBackgroundMusic();
        showScreen("screen-mode-select");
    };

    if (GameState.currentMode === "online" && socket?.connected && GameState.online.roomCode) {
        socket.timeout(3000).emit("online:leaveRoom", {
            roomCode: GameState.online.roomCode,
            playerId: onlinePlayerId,
        }, returnHome);
        setTimeout(returnHome, 3000);
    } else {
        returnHome();
    }
});

// ==================== SAVE / LOAD (localStorage) ====================
function saveGame() {
    const saveData = {
        players: GameState.players.map(p => ({
            name: p.name,
            budget: p.budget,
            team: p.team,
            score: p.score,
            activeSynergies: p.activeSynergies || [],
        })),
        phase: GameState.currentScreen,
        timestamp: Date.now(),
    };
    localStorage.setItem("aaa_save", JSON.stringify(saveData));
}

function loadGame() {
    const raw = localStorage.getItem("aaa_save");
    if (!raw) return false;
    try {
        const data = JSON.parse(raw);
        data.players.forEach((p, i) => {
            GameState.players[i].name = p.name;
            GameState.players[i].budget = p.budget;
            GameState.players[i].team = p.team;
            GameState.players[i].score = p.score;
            GameState.players[i].activeSynergies = p.activeSynergies || [];
        });
        return data.phase;
    } catch { return false; }
}

// Auto-save after each phase transition
const originalShowScreen = showScreen;
showScreen = function(screenId) {
    originalShowScreen(screenId);
    if (["screen-power-reveal", "screen-teams", "screen-bracket", "screen-battle"].includes(screenId)) {
        saveGame();
    }
};

// Check for saved game on load
(function checkSave() {
    const raw = localStorage.getItem("aaa_save");
    if (raw) {
        try {
            const data = JSON.parse(raw);
            const mins = Math.round((Date.now() - data.timestamp) / 60000);
            if (mins < 120) { // Only offer resume if < 2 hours old
                const resumed = loadGame();
                if (resumed && ["screen-power-reveal", "screen-teams", "screen-bracket"].includes(resumed)) {
                    // Offer resume via a brief prompt
                    const resumeDiv = document.createElement("div");
                    resumeDiv.className = "resume-prompt";
                    resumeDiv.innerHTML = `
                        <div class="resume-inner">
                            <p>🎮 Saved game found (${mins}m ago)</p>
                            <p><strong>${data.players[0].name}</strong> vs <strong>${data.players[1].name}</strong></p>
                            <button class="btn btn-primary" id="btn-resume">RESUME</button>
                            <button class="btn btn-secondary" id="btn-new-game">NEW GAME</button>
                        </div>
                    `;
                    document.body.appendChild(resumeDiv);
                    $("btn-resume").addEventListener("click", () => {
                        resumeDiv.remove();
                        showTeamReview();
                        showScreen(resumed);
                    });
                    $("btn-new-game").addEventListener("click", () => {
                        resumeDiv.remove();
                        localStorage.removeItem("aaa_save");
                    });
                }
            }
        } catch { /* ignore corrupt saves */ }
    }
})();
