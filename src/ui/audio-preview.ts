import { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { audioPreviewItems, type AudioPreviewItem, type AudioPreviewTask } from '../audio-display.js';

const app = new App({ name: 'TopMediai audio preview', version: '1.0.0' }, {});
const heading = document.querySelector<HTMLElement>('#heading')!;
const status = document.querySelector<HTMLElement>('#task-status')!;
const model = document.querySelector<HTMLElement>('#model')!;
const notice = document.querySelector<HTMLElement>('#notice')!;
const tracks = document.querySelector<HTMLElement>('#tracks')!;
let connected = false;
let cleanup: (() => void)[] = [];
const players = new Set<HTMLAudioElement>();

function clearPlayers() { cleanup.forEach(stop => stop()); cleanup = []; players.clear(); tracks.replaceChildren(); }
function time(value: number) { return Number.isFinite(value) && value >= 0 ? `${Math.floor(value / 60)}:${Math.floor(value % 60).toString().padStart(2, '0')}` : '—:—'; }

function audioCard(item: AudioPreviewItem, task: AudioPreviewTask) {
  const card = document.createElement('article'); card.setAttribute('aria-label', item.label);
  const top = document.createElement('div'); top.className = 'track-heading';
  const icon = document.createElement('span'); icon.className = 'music-icon'; icon.textContent = '♫'; icon.setAttribute('aria-hidden', 'true');
  const info = document.createElement('div'); info.className = 'track-info';
  const title = document.createElement('h2');
  const workTitle = task.kind === 'tts' ? task.params?.article_title : task.params?.title;
  title.textContent = typeof workTitle === 'string' && workTitle.trim() ? `${workTitle} · ${item.label}` : item.label;
  const type = document.createElement('p'); type.className = 'track-type';
  type.textContent = `${task.kind === 'music' ? task.params?.instrumental ? 'Instrumental music' : 'Vocal music' : task.kind === 'sts' ? 'Voice conversion' : 'Speech synthesis'} · ${item.mimeType === 'audio/mpeg' ? 'MP3' : item.mimeType.split('/')[1]!.toUpperCase()}`;
  if (task.kind === 'tts' && typeof task.params?.accent === 'string' && task.params.accent.trim()) type.textContent += ` · ${task.params.accent}`;
  info.append(title, type); top.append(icon, info);

  const audio = document.createElement('audio');
  audio.preload = 'none'; audio.crossOrigin = 'anonymous'; audio.src = item.url;
  // No autoplay, account headers, cookies, media proxy or generation calls.
  players.add(audio);
  const controls = document.createElement('div'); controls.className = 'player';
  const play = document.createElement('button'); play.type = 'button'; play.className = 'play';
  play.textContent = 'Play'; play.setAttribute('aria-label', `Play ${item.label}`); play.setAttribute('aria-pressed', 'false');
  const progress = document.createElement('input'); progress.type = 'range'; progress.className = 'progress';
  progress.min = '0'; progress.max = '100'; progress.step = '0.1'; progress.value = '0'; progress.disabled = true;
  progress.setAttribute('aria-label', `${item.label} playback position`);
  const duration = document.createElement('span'); duration.className = 'time'; duration.textContent = '0:00 / —:—';
  controls.append(play, progress, duration);
  const footer = document.createElement('footer');
  const state = document.createElement('p'); state.className = 'playback-status'; state.setAttribute('role', 'status'); state.textContent = 'Click play to listen';
  const actions = document.createElement('div'); actions.className = 'actions';
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'retry'; retry.textContent = 'Retry loading'; retry.hidden = true;
  const audioLabel = task.kind === 'tts' ? 'Synthesized speech' : task.kind === 'sts' ? 'Voice conversion result' : 'Original audio';
  const link = document.createElement('a'); link.textContent = `Open ${audioLabel.toLowerCase()} / Download`; link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
  const manual = document.createElement('p'); manual.className = 'manual-url'; manual.hidden = true;
  actions.append(retry, link); footer.append(state, actions);
  card.append(top, audio, controls, footer, manual); tracks.append(card);

  let disposed = false, playbackFailed = false, attempt = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    const knownDuration = Number.isFinite(audio.duration) && audio.duration > 0;
    progress.disabled = !knownDuration;
    progress.value = knownDuration ? String(100 * audio.currentTime / audio.duration) : '0';
    progress.setAttribute('aria-valuetext', `${time(audio.currentTime)} / ${time(audio.duration)}`);
    duration.textContent = `${time(audio.currentTime)} / ${time(audio.duration)}`;
  };
  const paused = () => { play.textContent = 'Play'; play.setAttribute('aria-label', `Play ${item.label}`); play.setAttribute('aria-pressed', 'false'); };
  const failure = () => {
    if (disposed) return;
    playbackFailed = true;
    clearTimeout(timer); audio.pause(); paused(); retry.hidden = false;
    state.textContent = `Preview unavailable. Retry or open the ${audioLabel.toLowerCase()}.`;
  };
  const waiting = () => { if (disposed) return; clearTimeout(timer); state.textContent = 'Loading audio…'; timer = setTimeout(failure, 20_000); };
  audio.addEventListener('loadedmetadata', update);
  audio.addEventListener('durationchange', update);
  audio.addEventListener('timeupdate', update);
  audio.addEventListener('play', () => {
    for (const other of players) if (other !== audio) other.pause();
    play.textContent = 'Pause'; play.setAttribute('aria-label', `Pause ${item.label}`); play.setAttribute('aria-pressed', 'true');
    retry.hidden = true; waiting();
  });
  audio.addEventListener('playing', () => { clearTimeout(timer); state.textContent = 'Playing'; retry.hidden = true; });
  audio.addEventListener('waiting', waiting);
  audio.addEventListener('pause', () => { clearTimeout(timer); paused(); if (!playbackFailed) state.textContent = 'Paused'; });
  audio.addEventListener('ended', () => { clearTimeout(timer); paused(); state.textContent = 'Playback ended'; });
  audio.addEventListener('error', failure);
  const start = async () => {
    const current = ++attempt;
    playbackFailed = false;
    try { await audio.play(); } catch (error) {
      if (!disposed && current === attempt && !(error instanceof DOMException && error.name === 'AbortError')) failure();
    }
  };
  play.addEventListener('click', () => { if (audio.paused) void start(); else audio.pause(); });
  retry.addEventListener('click', () => { audio.load(); void start(); });
  progress.addEventListener('input', () => { if (Number.isFinite(audio.duration)) { audio.currentTime = Number(progress.value) / 100 * audio.duration; update(); } });
  link.addEventListener('click', async event => {
    if (!connected) return;
    event.preventDefault();
    try { const result = await app.openLink({ url: item.url }); if (!result.isError) return; } catch { /* Keep an explicit copyable fallback. */ }
    if (!disposed) { manual.textContent = `The client could not open the link. Copy the audio URL: ${item.url}`; manual.hidden = false; }
  });
  cleanup.push(() => { disposed = true; clearTimeout(timer); audio.pause(); audio.removeAttribute('src'); audio.load(); });
}

function render(result: CallToolResult) {
  clearPlayers(); notice.textContent = ''; model.textContent = '';
  if (result.isError) { status.textContent = 'Could not read audio results'; notice.textContent = 'Check the original task result.'; return; }
  const task = result.structuredContent as AudioPreviewTask | undefined;
  if (!task) { status.textContent = 'No audio available for playback'; return; }
  heading.textContent = task.kind === 'music' ? 'Music Preview' : task.kind === 'tts' ? 'Speech Preview' : task.kind === 'sts' ? 'Voice Conversion Preview' : 'Audio Preview';
  model.textContent = task.kind === 'tts' || task.kind === 'sts'
    ? [task.display?.model?.name ? `Model: ${task.display.model.name}` : '', task.display?.voice?.name ? `Voice: ${task.display.voice.name}` : ''].filter(Boolean).join(' · ')
    : task.display?.model?.name ?? '';
  const { items, unavailable } = audioPreviewItems(task);
  const labels: Record<string, string> = { completed: 'Generation completed', partially_completed: 'Partially completed', queued: 'Queued', running: 'Generating', failed: 'Generation failed', submission_unknown: 'Submission needs verification' };
  status.textContent = `${labels[task.status ?? ''] ?? 'Task status needs verification'}${items.length ? ` · ${items.length} audio tracks` : ''}`;
  items.forEach(item => audioCard(item, task));
  if (unavailable) notice.textContent = 'Some audio cannot be played here. Use the original links in the chat or task results.';
  else if (!items.length) notice.textContent = ['running', 'queued'].includes(task.status ?? '') ? 'Audio is still being generated. Query the same task later.'
    : task.status === 'submission_unknown' ? 'Check the task in the original account history.' : 'This task has no audio available for playback.';
  else if (task.status === 'partially_completed') notice.textContent = 'Completed versions are ready to play. Check task status for the remaining versions.';
}

app.ontoolresult = render;
app.ontoolcancelled = () => { clearPlayers(); status.textContent = 'Result loading cancelled'; };
app.onhostcontextchanged = context => { if (context.theme) document.documentElement.style.colorScheme = context.theme; };
app.onteardown = async () => { clearPlayers(); return {}; };
void app.connect().then(() => {
  connected = true;
  const theme = app.getHostContext()?.theme; if (theme) document.documentElement.style.colorScheme = theme;
}).catch(() => { status.textContent = 'The client could not connect to the audio preview'; notice.textContent = 'Use the original audio links in the chat.'; });
