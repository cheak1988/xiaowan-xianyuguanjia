'use strict';

(() => {
  let audio, playedAt = 0, currentSrc = '';
  async function play(rawVolume, customSrc) {
    const parsed = Number(rawVolume), volume = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 60;
    if (volume === 0) throw new Error('当前音量为 0，请调高音量后试听。');
    // 自定义提示音优先；为空时用内置默认音
    const src = customSrc ? String(customSrc) : 'message-alert.wav';
    if (!audio || currentSrc !== src) {
      audio = new Audio(src); audio.preload = 'auto'; currentSrc = src;
    }
    audio.pause(); audio.currentTime = 0; audio.volume = volume / 100;
    await audio.play();
    playedAt = Date.now();
    return { ok: true };
  }
  window.MessageSound = { play, status: () => ({ playedAt, volume: audio?.volume, paused: audio?.paused }) };
  window.api.messageAlerts.onSound(({ volume, soundFile }) => {
    play(volume, soundFile).catch(() => window.dispatchEvent(new CustomEvent('message-sound-error')));
  });
})();
