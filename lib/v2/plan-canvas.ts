// 概念方案图形产出：平面布局图与概念效果图（Canvas 合成，均为概念示意、非施工依据）。
import { imageBasis, type Spatial } from '../spatial';

export function drawPlanSheet(s: Spatial): string {
  const basis = imageBasis(s);
  const W = 1240, H = 860, pad = 70;
  const scale = Math.min((W - pad * 2) / basis.w, (H - pad * 2 - 100) / basis.h);
  const ox = (W - basis.w * scale) / 2;
  const oy = pad + 46;
  const px = (x: number) => ox + x * scale;
  const py = (y: number) => oy + y * scale;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const c = canvas.getContext('2d')!;
  c.fillStyle = '#f6f8f2';
  c.fillRect(0, 0, W, H);
  // 标题行
  c.fillStyle = '#1f5c3a';
  c.font = 'bold 26px "Microsoft YaHei", sans-serif';
  c.textAlign = 'left';
  c.fillText(`${s.address || '乡村场地'} · 概念平面布局图`, pad, 44);
  c.font = '14px "Microsoft YaHei", sans-serif';
  c.fillStyle = '#6b7f6e';
  c.textAlign = 'right';
  c.fillText(`V${s.version} · ${new Date().toLocaleDateString('zh-CN')} · 概念示意，无施工尺寸`, W - pad, 44);
  c.textAlign = 'left';
  // 场地边界
  c.strokeStyle = '#9cc3a5';
  c.lineWidth = 3;
  c.setLineDash([14, 8]);
  c.strokeRect(ox, oy, basis.w * scale, basis.h * scale);
  c.setLineDash([]);
  // 道路网
  c.strokeStyle = '#c9b98a';
  c.lineWidth = Math.max(6, 10 * scale);
  c.lineCap = 'round';
  for (const r of s.roads) {
    const a = s.nodes.find(n => n.id === r.a);
    const b = s.nodes.find(n => n.id === r.b);
    if (!a || !b) continue;
    c.beginPath();
    c.moveTo(px(a.x), py(a.y));
    c.lineTo(px(b.x), py(b.y));
    c.stroke();
  }
  // 现状建筑
  for (const b of s.buildings) {
    c.fillStyle = '#dfe7da';
    c.strokeStyle = '#8fa58c';
    c.lineWidth = 1.5;
    c.fillRect(px(b.x - b.w / 2), py(b.y - b.h / 2), b.w * scale, b.h * scale);
    c.strokeRect(px(b.x - b.w / 2), py(b.y - b.h / 2), b.w * scale, b.h * scale);
    if (b.w * scale > 36) {
      c.fillStyle = '#41543f';
      c.font = '12px "Microsoft YaHei", sans-serif';
      c.textAlign = 'center';
      c.fillText(b.name, px(b.x), py(b.y) + 4);
      c.textAlign = 'left';
    }
  }
  // 布局组件（新增/调整）
  for (const l of s.layout) {
    c.beginPath();
    c.arc(px(l.x), py(l.y), 9, 0, Math.PI * 2);
    c.fillStyle = '#2f7d4f';
    c.fill();
    c.strokeStyle = '#ffffff';
    c.lineWidth = 2;
    c.stroke();
    c.font = 'bold 13px "Microsoft YaHei", sans-serif';
    const tw = c.measureText(l.kind).width;
    c.fillStyle = 'rgba(255,255,255,0.92)';
    c.fillRect(px(l.x) + 12, py(l.y) - 12, tw + 14, 24);
    c.fillStyle = '#1f5c3a';
    c.fillText(l.kind, px(l.x) + 19, py(l.y) + 4);
  }
  // 图例与目标
  const ly = oy + basis.h * scale + 40;
  c.font = '13px "Microsoft YaHei", sans-serif';
  c.beginPath();
  c.arc(pad + 6, ly - 5, 7, 0, Math.PI * 2);
  c.fillStyle = '#2f7d4f';
  c.fill();
  c.fillStyle = '#41543f';
  c.fillText('新增/调整组件', pad + 20, ly);
  c.fillStyle = '#c9b98a';
  c.fillRect(pad + 156, ly - 9, 26, 6);
  c.fillStyle = '#41543f';
  c.fillText('道路', pad + 190, ly);
  c.fillStyle = '#dfe7da';
  c.fillRect(pad + 248, ly - 11, 18, 14);
  c.strokeStyle = '#8fa58c';
  c.strokeRect(pad + 248, ly - 11, 18, 14);
  c.fillStyle = '#41543f';
  c.fillText('现状建筑', pad + 272, ly);
  c.fillStyle = '#6b7f6e';
  c.textAlign = 'right';
  c.fillText(`设计目标：${(s.goal || '').replace(/\s+/g, ' ').slice(0, 36)}`, W - pad, ly);
  c.textAlign = 'left';
  return canvas.toDataURL('image/png');
}

export async function drawEffectSheet(s: Spatial, photo: string): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('现状照片无法加载，请先上传或选择演示素材'));
    im.src = photo;
  });
  const W = Math.min(1280, Math.max(640, img.width));
  const H = Math.round((W * img.height) / img.width);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const c = canvas.getContext('2d')!;
  c.drawImage(img, 0, 0, W, H);
  // 概念色调层（绿意罩染，示意「改造后氛围」）
  const grad = c.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(31,92,58,0.16)');
  grad.addColorStop(0.5, 'rgba(31,92,58,0.05)');
  grad.addColorStop(1, 'rgba(31,92,58,0.22)');
  c.fillStyle = grad;
  c.fillRect(0, 0, W, H);
  // 布局组件标记
  const r = Math.max(10, Math.round(W * 0.011));
  for (const l of s.layout) {
    const x = (l.x / 100) * W;
    const y = (l.y / 100) * H;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = 'rgba(47,125,79,0.85)';
    c.fill();
    c.strokeStyle = '#ffffff';
    c.lineWidth = 3;
    c.stroke();
    c.font = `bold ${Math.max(14, Math.round(W * 0.019))}px "Microsoft YaHei", sans-serif`;
    const tw = c.measureText(l.kind).width;
    c.fillStyle = 'rgba(255,255,255,0.94)';
    c.fillRect(x + 14, y - 16, tw + 18, 30);
    c.fillStyle = '#1f5c3a';
    c.fillText(l.kind, x + 23, y + 5);
  }
  // 顶部设计目标条
  const barH = Math.max(44, Math.round(H * 0.075));
  c.fillStyle = 'rgba(20,45,32,0.74)';
  c.fillRect(0, 0, W, barH);
  c.fillStyle = '#eaf4ea';
  c.font = `bold ${Math.max(15, Math.round(W * 0.02))}px "Microsoft YaHei", sans-serif`;
  c.fillText(`概念效果 · ${(s.goal || '').replace(/\s+/g, ' ').slice(0, 40)}`, 18, barH * 0.66);
  // 底部声明
  const footH = Math.max(30, Math.round(H * 0.055));
  c.fillStyle = 'rgba(20,45,32,0.74)';
  c.fillRect(0, H - footH, W, footH);
  c.fillStyle = '#cfe3cf';
  c.font = `${Math.max(12, Math.round(W * 0.014))}px "Microsoft YaHei", sans-serif`;
  c.fillText('AI 概念示意（基于现状照片合成）· 非真实渲染 · 须以现场核验为准', 16, H - footH * 0.32);
  return canvas.toDataURL('image/jpeg', 0.9);
}
