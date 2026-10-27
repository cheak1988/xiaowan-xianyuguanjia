'use strict';

/**
 * 轻量图表（纯 Canvas，零依赖）
 *
 * 支持：
 *   - 折线图（趋势）
 *   - 环形图（占比）
 *   - 柱状图（对比）
 *
 * 设计：
 *   - 自适应容器宽度（ResizeObserver）
 *   - 支持高 DPI 屏幕
 *   - Semi 主题配色与自适应文字颜色
 */

(function () {
  const PALETTE = ['#0064fa', '#69b1ff', '#3bb346', '#ff9300', '#f93920', '#7f61ff', '#05a4b6'];

  const themeColor = (name, fallback) => getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
  function withAlpha(color, alpha) {
    const hex = /^#([0-9a-f]{6})$/i.exec(color);
    const values = hex ? [0, 2, 4].map((start) => parseInt(hex[1].slice(start, start + 2), 16))
      : (color.match(/[\d.]+/g) || []).slice(0, 3);
    return values.length === 3 ? `rgba(${values.join(',')},${alpha})` : color;
  }

  function setupCanvas(canvas, height) {
    const dpr = window.devicePixelRatio || 1;
    const parentStyle = getComputedStyle(canvas.parentElement);
    const w = Math.max(100, canvas.parentElement.clientWidth - parseFloat(parentStyle.paddingLeft || 0) - parseFloat(parentStyle.paddingRight || 0));
    const h = height || 200;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  /* ---------------- 折线图 ---------------- */

  function line(canvas, { labels = [], values = [], height = 220, color = themeColor('--y-500', '#0064fa') } = {}) {
    const { ctx, w, h } = setupCanvas(canvas, height);
    const padL = 42, padR = 16, padT = 16, padB = 28;
    const cw = w - padL - padR;
    const ch = h - padT - padB;

    if (!values.length) {
      ctx.fillStyle = themeColor('--ink-3', '#6b7075');
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('暂无数据', w / 2, h / 2);
      return;
    }

    const max = Math.max(...values, 1);
    const niceMax = Math.ceil(max / 5) * 5 || 5;
    const stepX = values.length > 1 ? cw / (values.length - 1) : cw;

    // 网格 + Y 轴
    ctx.strokeStyle = themeColor('--line', '#eceef0');
    ctx.lineWidth = 1;
    ctx.font = '10px sans-serif';
    ctx.fillStyle = themeColor('--ink-3', '#6b7075');
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = padT + (ch / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + cw, y);
      ctx.stroke();
      const v = Math.round(niceMax - (niceMax / 4) * i);
      ctx.fillText(String(v), padL - 7, y + 3);
    }

    // 数据点
    const pts = values.map((v, i) => ({
      x: padL + stepX * i,
      y: padT + ch - (v / niceMax) * ch,
    }));

    // 渐变填充
    const grad = ctx.createLinearGradient(0, padT, 0, padT + ch);
    grad.addColorStop(0, withAlpha(color, .16));
    grad.addColorStop(1, withAlpha(color, 0));
    ctx.beginPath();
    ctx.moveTo(pts[0].x, padT + ch);
    pts.forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.lineTo(pts[pts.length - 1].x, padT + ch);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // 折线
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();

    // 点
    pts.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = themeColor('--card', '#fff');
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    // X 轴标签（最多显示 7 个）
    ctx.fillStyle = themeColor('--ink-3', '#6b7075');
    ctx.textAlign = 'center';
    const skip = Math.ceil(labels.length / 7);
    labels.forEach((lb, i) => {
      if (i % skip !== 0 && i !== labels.length - 1) return;
      ctx.fillText(lb, padL + stepX * i, h - 8);
    });
  }

  /* ---------------- 环形图 ---------------- */

  function donut(canvas, { data = [], height = 220, centerLabel = '' } = {}) {
    const { ctx, w, h } = setupCanvas(canvas, height);

    const items = data.filter((d) => d.value > 0);
    if (!items.length) {
      ctx.fillStyle = themeColor('--ink-3', '#6b7075');
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('暂无数据', w / 2, h / 2);
      return;
    }

    const total = items.reduce((s, d) => s + d.value, 0);
    const cx = w * 0.38;
    const cy = h / 2;
    const r = Math.min(w * 0.3, h * 0.38);
    const inner = r * 0.62;

    let angle = -Math.PI / 2;
    items.forEach((d, i) => {
      const slice = (d.value / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, angle, angle + slice);
      ctx.arc(cx, cy, inner, angle + slice, angle, true);
      ctx.closePath();
      ctx.fillStyle = d.color || PALETTE[i % PALETTE.length];
      ctx.fill();
      angle += slice;
    });

    // 中心文字
    ctx.fillStyle = themeColor('--ink', '#1c1f23');
    ctx.textAlign = 'center';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(String(total), cx, cy + 2);
    if (centerLabel) {
      ctx.font = '11px sans-serif';
      ctx.fillStyle = themeColor('--ink-3', '#6b7075');
      ctx.fillText(centerLabel, cx, cy + 19);
    }

    // 图例
    const lgX = w * 0.72;
    let lgY = cy - (items.length * 24) / 2 + 6;
    ctx.textAlign = 'left';
    items.forEach((d, i) => {
      const c = d.color || PALETTE[i % PALETTE.length];
      ctx.beginPath();
      ctx.arc(lgX, lgY - 3, 4, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();

      ctx.fillStyle = themeColor('--ink', '#1c1f23');
      ctx.font = '11.5px sans-serif';
      ctx.fillText(d.label, lgX + 10, lgY + 1);

      ctx.fillStyle = themeColor('--ink-2', '#41464c');
      ctx.font = 'bold 11.5px sans-serif';
      ctx.fillText(String(d.value), lgX + 10, lgY + 15);

      lgY += 40;
    });
  }

  /* ---------------- 柱状图 ---------------- */

  function bar(canvas, { labels = [], values = [], height = 220, color = themeColor('--y-500', '#0064fa') } = {}) {
    const { ctx, w, h } = setupCanvas(canvas, height);
    const padL = 42, padR = 16, padT = 16, padB = 28;
    const cw = w - padL - padR;
    const ch = h - padT - padB;

    if (!values.length) {
      ctx.fillStyle = themeColor('--ink-3', '#6b7075');
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('暂无数据', w / 2, h / 2);
      return;
    }

    const max = Math.max(...values, 1);
    const niceMax = Math.ceil(max / 5) * 5 || 5;

    // 网格
    ctx.strokeStyle = themeColor('--line', '#eceef0');
    ctx.lineWidth = 1;
    ctx.font = '10px sans-serif';
    ctx.fillStyle = themeColor('--ink-3', '#6b7075');
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = padT + (ch / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + cw, y);
      ctx.stroke();
      ctx.fillText(String(Math.round(niceMax - (niceMax / 4) * i)), padL - 7, y + 3);
    }

    // 柱
    const slot = cw / values.length;
    const bw = Math.min(slot * 0.55, 34);
    values.forEach((v, i) => {
      const bh = (v / niceMax) * ch;
      const x = padL + slot * i + (slot - bw) / 2;
      const y = padT + ch - bh;

      const g = ctx.createLinearGradient(0, y, 0, padT + ch);
      g.addColorStop(0, color);
      g.addColorStop(1, withAlpha(color, .65));
      ctx.fillStyle = g;

      const radius = Math.min(4, bw / 2);
      ctx.beginPath();
      ctx.moveTo(x, y + radius);
      ctx.arcTo(x, y, x + radius, y, radius);
      ctx.lineTo(x + bw - radius, y);
      ctx.arcTo(x + bw, y, x + bw, y + radius, radius);
      ctx.lineTo(x + bw, padT + ch);
      ctx.lineTo(x, padT + ch);
      ctx.closePath();
      ctx.fill();
    });

    // X 标签
    ctx.fillStyle = themeColor('--ink-3', '#6b7075');
    ctx.textAlign = 'center';
    labels.forEach((lb, i) => {
      ctx.fillText(lb, padL + slot * i + slot / 2, h - 8);
    });
  }

  window.Chart = { line, donut, bar, PALETTE };
})();
