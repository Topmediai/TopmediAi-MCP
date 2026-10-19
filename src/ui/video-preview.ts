import { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { videoPreviewItems, type VideoPreviewItem, type VideoPreviewTask } from '../video-display.js';

const app = new App({ name: 'TopMediai video preview', version: '1.0.0' }, {});
const status = document.querySelector<HTMLElement>('#task-status')!;
const model = document.querySelector<HTMLElement>('#model')!;
const notice = document.querySelector<HTMLElement>('#notice')!;
const videos = document.querySelector<HTMLElement>('#videos')!;
let connected = false;
let cleanup: (() => void)[] = [];
const players = new Set<HTMLVideoElement>();

function clearPlayers() { cleanup.forEach(stop => stop()); cleanup = []; players.clear(); videos.replaceChildren(); }

function videoCard(item: VideoPreviewItem, task: VideoPreviewTask, index: number, count: number) {
  const card = document.createElement('article');
  const label = item.label === 'Video' && count > 1 ? `Video ${index + 1}` : item.label;
  card.setAttribute('aria-label', label);
  const title = document.createElement('h2');
  title.textContent = typeof task.params?.title === 'string' && task.params.title.trim() ? `${task.params.title} · ${label}` : label;
  const player = document.createElement('div'); player.className = 'player';
  const video = document.createElement('video');
  video.controls = true; video.playsInline = true; video.preload = 'none'; video.crossOrigin = 'anonymous'; video.src = item.url;
  video.setAttribute('aria-label', `${label} player`);
  // Native playback/seek/volume/fullscreen. No autoplay, account credentials or media proxy.
  players.add(video);
  const play = document.createElement('button'); play.type = 'button'; play.className = 'play'; play.textContent = '▶ Play video';
  play.setAttribute('aria-label', `Play ${label}`);
  player.append(video, play);
  const footer = document.createElement('footer');
  const state = document.createElement('p'); state.className = 'playback-status'; state.setAttribute('role', 'status'); state.textContent = 'Click play to watch';
  const actions = document.createElement('div'); actions.className = 'actions';
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'retry'; retry.textContent = 'Retry loading'; retry.hidden = true;
  const link = document.createElement('a'); link.textContent = 'Open original video / Download'; link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
  const manual = document.createElement('p'); manual.className = 'manual-url'; manual.hidden = true;
  actions.append(retry, link); footer.append(state, actions); card.append(title, player, footer, manual); videos.append(card);

  let disposed = false, playbackFailed = false, attempt = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const failure = () => {
    if (disposed) return;
    playbackFailed = true; clearTimeout(timer); video.pause(); play.hidden = true; retry.hidden = false;
    state.textContent = 'This video cannot be played. Retry or open the original video.';
  };
  const waiting = () => { if (disposed) return; clearTimeout(timer); state.textContent = 'Loading video…'; timer = setTimeout(failure, 20_000); };
  video.addEventListener('play', () => {
    playbackFailed = false;
    for (const other of players) if (other !== video) other.pause();
    play.hidden = true; retry.hidden = true; waiting();
  });
  video.addEventListener('playing', () => { clearTimeout(timer); state.textContent = 'Playing'; retry.hidden = true; });
  video.addEventListener('waiting', waiting);
  video.addEventListener('pause', () => { clearTimeout(timer); if (!playbackFailed) state.textContent = 'Paused'; });
  video.addEventListener('ended', () => { clearTimeout(timer); state.textContent = 'Playback ended'; play.hidden = false; });
  video.addEventListener('error', failure);
  const start = async () => {
    const current = ++attempt; playbackFailed = false;
    try { await video.play(); } catch (error) {
      if (!disposed && current === attempt && !(error instanceof DOMException && error.name === 'AbortError')) failure();
    }
  };
  play.addEventListener('click', () => { void start(); });
  retry.addEventListener('click', () => { video.load(); void start(); });
  link.addEventListener('click', async event => {
    if (!connected) return;
    event.preventDefault();
    try { const result = await app.openLink({ url: item.url }); if (!result.isError) return; } catch { /* Keep a copyable fallback. */ }
    if (!disposed) { manual.textContent = `The client could not open the link. Copy the video URL: ${item.url}`; manual.hidden = false; }
  });
  cleanup.push(() => { disposed = true; ++attempt; clearTimeout(timer); video.pause(); video.removeAttribute('src'); video.load(); });
}

function render(result: CallToolResult) {
  clearPlayers(); notice.textContent = ''; model.textContent = '';
  if (result.isError) { status.textContent = 'Could not read video results'; notice.textContent = 'Check the original task result.'; return; }
  const task = result.structuredContent as VideoPreviewTask | undefined;
  if (!task) { status.textContent = 'No video available for playback'; return; }
  model.textContent = task.display?.model?.name ?? '';
  const { items, unavailable } = videoPreviewItems(task);
  const labels: Record<string, string> = { completed: 'Generation completed', partially_completed: 'Partially completed', queued: 'Queued', running: 'Generating', failed: 'Generation failed', submission_unknown: 'Submission needs verification' };
  status.textContent = `${labels[task.status ?? ''] ?? 'Task status needs verification'}${items.length ? ` · ${items.length} ${items.length === 1 ? 'video' : 'videos'}` : ''}`;
  items.forEach((item, index) => videoCard(item, task, index, items.length));
  if (unavailable) notice.textContent = 'Some videos cannot be played here. Use the original links in the chat or task results.';
  else if (!items.length) notice.textContent = ['running', 'queued'].includes(task.status ?? '') ? 'Video is still being generated. Query the same task later.'
    : task.status === 'submission_unknown' ? 'Check the task in the original account history.' : 'This task has no video available for playback.';
  else if (task.status === 'partially_completed') notice.textContent = 'Completed versions are ready to play. Check task status for the remaining versions.';
}

app.ontoolresult = render;
app.ontoolcancelled = () => { clearPlayers(); status.textContent = 'Result loading cancelled'; };
app.onhostcontextchanged = context => { if (context.theme) document.documentElement.style.colorScheme = context.theme; };
app.onteardown = async () => { clearPlayers(); return {}; };
void app.connect().then(() => {
  connected = true;
  const theme = app.getHostContext()?.theme; if (theme) document.documentElement.style.colorScheme = theme;
}).catch(() => { status.textContent = 'The client could not connect to the video preview'; notice.textContent = 'Use the original video links in the chat.'; });
