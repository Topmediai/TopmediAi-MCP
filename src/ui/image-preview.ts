import { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { previewImageUrl } from '../image-display.js';

const app = new App({ name: 'TopMediai image preview', version: '1.0.0' }, {});
const status = document.querySelector<HTMLElement>('#task-status')!;
const notice = document.querySelector<HTMLElement>('#notice')!;
const gallery = document.querySelector<HTMLElement>('#gallery')!;
let connected = false;
let cleanup: (() => void)[] = [];

function clearImages() { cleanup.forEach(stop => stop()); cleanup = []; gallery.replaceChildren(); }

function imageCard(url: string, index: number) {
  const card = document.createElement('article');
  card.setAttribute('aria-label', `Image ${index + 1}`);
  const stage = document.createElement('div'); stage.className = 'stage';
  const img = document.createElement('img'); img.alt = `TopMediai generated image ${index + 1}`;
  img.referrerPolicy = 'no-referrer'; img.decoding = 'async';
  const placeholder = document.createElement('div'); placeholder.className = 'placeholder';
  const footer = document.createElement('footer');
  const state = document.createElement('p'); state.className = 'image-status'; state.setAttribute('role', 'status');
  const actions = document.createElement('div'); actions.className = 'actions';
  const retry = document.createElement('button'); retry.textContent = 'Retry loading'; retry.type = 'button';
  const link = document.createElement('a'); link.textContent = 'Open original image'; link.href = url;
  link.target = '_blank'; link.rel = 'noopener noreferrer';
  const manual = document.createElement('p'); manual.className = 'manual-url'; manual.hidden = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  const failed = (message: string) => {
    clearTimeout(timer); img.hidden = true; placeholder.hidden = false; placeholder.className = 'placeholder';
    placeholder.textContent = message; state.textContent = 'Preview unavailable. The original image link is still available.'; retry.hidden = false;
  };
  const load = () => {
    clearTimeout(timer); const current = ++attempt;
    img.hidden = true; retry.hidden = true; placeholder.hidden = false; placeholder.className = 'placeholder loading';
    placeholder.textContent = 'Loading image…'; state.textContent = `Image ${index + 1} · Loading`;
    img.onload = () => {
      if (current !== attempt) return;
      clearTimeout(timer); img.hidden = false; placeholder.hidden = true; retry.hidden = true;
      state.textContent = `Image ${index + 1} · ${img.naturalWidth} × ${img.naturalHeight}`;
    };
    img.onerror = () => { if (current === attempt) failed('This image cannot be displayed. Retry loading or open the original image.'); };
    timer = setTimeout(() => { if (current === attempt) failed('This image is taking a while to load. Retry or open the original image.'); }, 20_000);
    // Retry only the same media URL. Never call a generation tool or mutate signed URLs.
    img.removeAttribute('src'); img.src = url;
  };
  retry.addEventListener('click', load);
  link.addEventListener('click', async event => {
    if (!connected) return;
    event.preventDefault();
    try {
      const result = await app.openLink({ url });
      if (!result.isError) return;
    } catch { /* Host may not support opening links. Keep an explicit copyable fallback. */ }
    manual.textContent = `The client could not open the link. Copy the original image URL: ${url}`; manual.hidden = false;
  });
  stage.append(img, placeholder); actions.append(retry, link); footer.append(state, actions); card.append(stage, footer, manual);
  gallery.append(card); load();
  cleanup.push(() => { ++attempt; clearTimeout(timer); img.onload = null; img.onerror = null; img.removeAttribute('src'); });
}

function render(result: CallToolResult) {
  clearImages(); notice.textContent = '';
  if (result.isError) { status.textContent = 'Could not read image results'; notice.textContent = 'Check the original task result. Do not regenerate because a preview failed.'; return; }
  const task = result.structuredContent as { status?: string; images?: { url?: unknown }[] } | undefined;
  if (!task) { status.textContent = 'No results to display'; return; }
  const labels: Record<string, string> = { completed: 'Generation completed', queued: 'Queued', running: 'Generating', failed: 'Generation failed', submission_unknown: 'Submission needs verification' };
  const images = Array.isArray(task.images) ? task.images.slice(0, 4) : [];
  const urls = images.flatMap(image => { const url = previewImageUrl(image?.url); return url ? [url] : []; });
  status.textContent = `${labels[task.status ?? ''] ?? 'Task status needs verification'}${urls.length ? ` · ${urls.length} images` : ''}`;
  gallery.classList.toggle('multiple', urls.length > 1);
  urls.forEach(imageCard);
  if (urls.length < images.length) notice.textContent = 'Some images cannot be previewed here. Use the original links in the task results.';
  else if (!urls.length) notice.textContent = task.status === 'submission_unknown' ? 'Check the original account history. Do not submit again.'
    : ['running', 'queued'].includes(task.status ?? '') ? 'Images are still being generated. Query the same task later.' : 'This task has no images available for preview.';
}

app.ontoolresult = render;
app.ontoolcancelled = () => { clearImages(); status.textContent = 'Result loading cancelled'; };
app.onhostcontextchanged = context => { if (context.theme) document.documentElement.style.colorScheme = context.theme; };
app.onteardown = async () => { clearImages(); return {}; };
void app.connect().then(() => {
  connected = true;
  const theme = app.getHostContext()?.theme; if (theme) document.documentElement.style.colorScheme = theme;
}).catch(() => { status.textContent = 'The client could not connect to the preview'; notice.textContent = 'Use the original image links in the chat.'; });
