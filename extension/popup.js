/**
 * popup 逻辑。
 *
 * 这里不 import 动效源码 —— popup 与内容脚本是两个独立的执行环境，
 * 而且 popup 只需要效果名和显示名。清单与 src/effects/index.js 保持一致。
 */

const EFFECTS = [
  ['snow', '雪花'], ['ice', '冰晶'], ['pixel', '像素'], ['sun', '太阳'], ['silk', '丝绸'],
  ['refract', '光折射'], ['orb', '光球'], ['geom', '几何'], ['ball', '弹球'], ['planet', '星球'],
  ['mist', '迷雾'], ['code', '代码'], ['rainbow', '彩虹'], ['moon', '月亮'], ['bubble', '气泡'],
  ['ink', '墨迹'], ['doodle', '涂鸦'], ['firefang', '火牙'], ['hole', '黑洞'], ['lightning', '闪电'],
  ['kaleido', '万花筒'], ['cell', '细胞'], ['fish', '鱼群'], ['firework', '烟花'], ['radar', '雷达']
];

const DEFAULTS = {
  enabled: true,
  effect: 'snow',
  cursor: true,
  wheel: true,
  disabledSites: []
};

const $ = (id) => document.getElementById(id);
const gridEl = $('grid');
const hostEl = $('host');
const panelEl = $('panel');
const hintEl = $('hint');

let settings = { ...DEFAULTS };
let hostname = '';

/* ---------- 渲染 ---------- */

function renderChips() {
  gridEl.textContent = '';
  for (const [key, name] of EFFECTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (key === settings.effect ? ' on' : '');
    b.textContent = name;
    b.title = `<cursor-${key}>`;
    b.dataset.key = key;
    gridEl.appendChild(b);
  }
}

function renderState() {
  $('enabled').checked = settings.enabled;
  $('cursor').checked = settings.cursor;
  $('wheel').checked = settings.wheel;
  $('site').checked = !settings.disabledSites.includes(hostname);
  panelEl.classList.toggle('off', !settings.enabled);

  for (const chip of gridEl.children) {
    chip.classList.toggle('on', chip.dataset.key === settings.effect);
  }

  if (!settings.enabled) {
    hintEl.textContent = '已全局关闭，开启后立即生效。';
  } else if (settings.disabledSites.includes(hostname)) {
    hintEl.textContent = '本站已单独关闭，勾选「在本站启用」可恢复。';
  } else {
    hintEl.textContent = '改动立即生效，无需刷新页面。';
  }
}

/* ---------- 持久化 ---------- */

async function save(patch) {
  settings = { ...settings, ...patch };
  renderState();
  await chrome.storage.sync.set(patch);
}

/* ---------- 事件 ---------- */

gridEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  save({ effect: chip.dataset.key });
});

$('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
$('cursor').addEventListener('change', (e) => save({ cursor: e.target.checked }));
$('wheel').addEventListener('change', (e) => save({ wheel: e.target.checked }));

$('site').addEventListener('change', (e) => {
  const set = new Set(settings.disabledSites);
  if (e.target.checked) set.delete(hostname);
  else set.add(hostname);
  save({ disabledSites: [...set] });
});

/* ---------- 启动 ---------- */

async function init() {
  // 当前标签页的域名（popup 拿不到 location，需要问 tabs；
  // 这里只用 activeTab 的 URL，不需要 tabs 权限之外的任何能力）
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) hostname = new URL(tab.url).hostname;
  } catch {
    hostname = '';
  }
  hostEl.textContent = hostname || '当前页面';
  hostEl.title = hostname;

  settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };

  renderChips();
  renderState();
}

init();
