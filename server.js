const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const THEMES = require('./themes');

const MAX_PLAYERS = 8;
const ROUNDS = 10;
const ROUND_MS = 30_000;
const REVEAL_MS = 5_000;
const RANK_POINTS = [100, 70, 50, 30]; // urutan penebak benar; sisanya 20
const pointsFor = rank => RANK_POINTS[rank] ?? 20;

const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const squash = s => norm(s).replace(/^the /, '').replace(/ /g, '');

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1]));
    prev = cur;
  }
  return prev[b.length];
}
// Toleransi salah ketik: 1 huruf untuk judul >= 5 huruf, 2 huruf untuk judul >= 12 huruf.
function isCorrect(guess, film) {
  const g = squash(guess);
  return film.answers.some(a => {
    const t = squash(a);
    return editDistance(g, t) <= (t.length >= 12 ? 2 : t.length >= 5 ? 1 : 0);
  });
}

if (process.argv[2] === 'test') {
  const assert = require('assert');
  const nemo = { answers: ['Finding Nemo'] };
  assert(isCorrect('finding  nemo!', nemo));
  assert(isCorrect('findng nemo', nemo));            // 1 typo
  assert(!isCorrect('nemo', nemo));
  assert(isCorrect('Up', { answers: ['Up'] }));
  assert(!isCorrect('Us', { answers: ['Up'] }));     // judul pendek harus persis
  assert(isCorrect('The Matrix', { answers: ['Matrix'] }));
  assert(isCorrect('fast and furious', { answers: ['Fast & Furious'] }));
  assert(isCorrect('Pokémon', { answers: ['Pokemon'] }));
  assert.deepStrictEqual([0, 1, 4, 7].map(pointsFor), [100, 70, 20, 20]);
  for (const [theme, films] of Object.entries(THEMES)) for (const f of films) {
    assert(!isCorrect(f.clue, f), `${theme}: petunjuk "${f.clue}" sama dengan jawabannya`);
  }
  console.log('ok');
  process.exit(0);
}

const imageCache = new Map();
async function getImage(wiki) {
  if (!wiki) return null;
  if (!imageCache.has(wiki)) {
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wiki.replace(/ /g, '_'))}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'tebak-judul/1.0' }, signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      imageCache.set(wiki, data.thumbnail?.source || data.originalimage?.source || null);
    } catch {
      return null; // gagal tidak di-cache, dicoba lagi lain kali
    }
  }
  return imageCache.get(wiki);
}

const app = express();
app.use(express.static(__dirname + '/public'));
const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map();
function newCode() {
  let c;
  do c = Math.random().toString(36).slice(2, 6).toUpperCase(); while (c.length < 4 || rooms.has(c));
  return c;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function publicState(r) {
  const rd = r.round;
  return {
    code: r.code, hostId: r.hostId, state: r.state, theme: r.theme, themes: Object.keys(THEMES),
    players: r.players, turn: r.turn + 1, totalTurns: r.totalTurns,
    round: rd && { clue: rd.film.clue, solved: rd.solved, msLeft: rd.endsAt - Date.now() },
    reveal: r.reveal,
  };
}
const broadcast = r => io.to(r.code).emit('state', publicState(r));
const chat = (r, text, kind = 'info', name) => io.to(r.code).emit('chat', { text, kind, name });

function startGame(r) {
  r.state = 'playing';
  r.turn = -1;
  r.totalTurns = Math.min(ROUNDS, THEMES[r.theme].length);
  r.players.forEach(p => (p.score = 0));
  r.deck = shuffle([...THEMES[r.theme]]);
  nextRound(r);
}

function nextRound(r) {
  r.reveal = null;
  r.round = null;
  r.turn++;
  if (r.turn >= r.totalTurns) {
    r.state = 'end';
    return broadcast(r);
  }
  const film = r.deck.pop();
  const image = getImage(film.wiki); // dimuat sambil ronde berjalan, baru ditampilkan saat jawaban dibuka
  r.round = { film, image, solved: [], endsAt: Date.now() + ROUND_MS, timer: setTimeout(() => endRound(r), ROUND_MS) };
  broadcast(r);
}

async function endRound(r) {
  const rd = r.round;
  if (!rd) return;
  clearTimeout(rd.timer);
  r.round = null;
  const title = rd.film.answers[0];
  const text = rd.solved.length
    ? `Tercepat: ${rd.solved.map(s => `${s.name} (+${s.points})`).join(', ')}.`
    : 'Tidak ada yang berhasil menebak.';
  r.reveal = { clue: rd.film.clue, title, image: await rd.image, text };
  if (!rooms.has(r.code)) return;
  chat(r, `Jawabannya "${title}". ${text}`, rd.solved.length ? 'good' : 'info');
  broadcast(r);
  setTimeout(() => rooms.has(r.code) && nextRound(r), REVEAL_MS);
}

io.on('connection', socket => {
  let r = null, me = null;

  socket.on('join', ({ name, code } = {}, cb) => {
    if (typeof cb !== 'function' || r) return;
    name = String(name ?? '').trim().slice(0, 16);
    code = String(code ?? '').trim().toUpperCase();
    if (!name) return cb('Nama wajib diisi');
    let room = code ? rooms.get(code) : null;
    if (code && !room) return cb('Room tidak ditemukan');
    if (room && room.players.length >= MAX_PLAYERS) return cb(`Room penuh (maks ${MAX_PLAYERS} pemain)`);
    if (room?.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return cb('Nama sudah dipakai di room ini');
    if (!room) {
      room = { code: newCode(), hostId: socket.id, players: [], state: 'lobby', theme: Object.keys(THEMES)[0] };
      rooms.set(room.code, room);
    }
    r = room;
    me = { id: socket.id, name, score: 0 };
    r.players.push(me);
    socket.join(r.code);
    cb(null, { code: r.code, id: socket.id });
    chat(r, `${name} bergabung`);
    broadcast(r);
  });

  socket.on('start', theme => {
    if (!r || r.hostId !== socket.id || r.state === 'playing' || r.players.length < 2) return;
    if (Object.hasOwn(THEMES, theme)) r.theme = theme;
    startGame(r);
  });

  socket.on('msg', text => {
    text = String(text ?? '').trim().slice(0, 200);
    if (!r || !text) return;
    const rd = r.round;
    if (!rd) return chat(r, text, 'chat', me.name);
    if (rd.solved.some(s => s.id === me.id)) {
      return socket.emit('chat', { text: 'Kamu sudah benar. Tunggu ronde berikutnya supaya jawabannya tidak bocor.', kind: 'bad' });
    }
    if (!isCorrect(text, rd.film)) return chat(r, text, 'chat', me.name);
    const points = pointsFor(rd.solved.length);
    me.score += points;
    rd.solved.push({ id: me.id, name: me.name, points });
    chat(r, `${me.name} menebak benar! Urutan ke-${rd.solved.length}, +${points}`, 'good');
    if (rd.solved.length === r.players.length) endRound(r);
    else broadcast(r);
  });

  socket.on('disconnect', () => {
    if (!r) return;
    r.players = r.players.filter(p => p !== me);
    if (!r.players.length) {
      clearTimeout(r.round?.timer);
      return rooms.delete(r.code);
    }
    if (r.hostId === socket.id) r.hostId = r.players[0].id;
    chat(r, `${me.name} keluar`);
    const rd = r.round;
    if (rd && r.players.every(p => rd.solved.some(s => s.id === p.id))) endRound(r);
    else broadcast(r);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Tebak Judul jalan di http://localhost:${PORT}`));
