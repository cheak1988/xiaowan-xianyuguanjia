'use strict';

const okButton = document.getElementById('ok');
const agree = document.getElementById('agree');
const quitButton = document.getElementById('quit');

window.legalApi.onInit((payload) => {
  const version = (payload && payload.version) || '';
  const appVersion = (payload && payload.appVersion) || '';
  document.getElementById('ver').textContent = appVersion ? `v${appVersion} · 声明 ${version}` : version;
});

agree.addEventListener('change', () => { okButton.disabled = !agree.checked; });

okButton.addEventListener('click', () => {
  if (!agree.checked) return;
  okButton.disabled = true;
  window.legalApi.result({ action: 'accept' });
});

quitButton.addEventListener('click', () => {
  window.legalApi.result({ action: 'quit' });
});

// 该窗口不可跳过：屏蔽 ESC 与 Ctrl+W，避免用户误以为能跳过阅读
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' || (event.ctrlKey && event.key.toLowerCase() === 'w')) {
    event.preventDefault();
  }
});
