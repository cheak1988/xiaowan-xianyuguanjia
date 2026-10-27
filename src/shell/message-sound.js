'use strict';

(() => {
  let audio, playedAt = 0;
  async function play(rawVolume) {
    const parsed = Number(rawVolume), volume = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 60;
    if (volume === 0) throw new Error('当前音量为 0，请调高音量后试听。');
    if (!audio) { audio = new Audio('message-alert.wav'); audio.preload = 'auto'; }
    audio.pause(); audio.currentTime = 0; audio.volume = volume / 100;
    await audio.play();
    playedAt = Date.now();
    return { ok: true };
  }
  window.MessageSound = { play, status: () => ({ playedAt, volume: audio?.volume, paused: audio?.paused }) };
  window.api.messageAlerts.onSound(({ volume }) => {
    play(volume).catch(() => window.dispatchEvent(new CustomEvent('message-sound-error')));
  });
})();
