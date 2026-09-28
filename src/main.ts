import './style.css';
import { Engine } from './core/Engine';

function showFatal(message: string): void {
  const overlay = document.createElement('div');
  overlay.className = 'fatal';
  overlay.innerHTML = `<h1>启动失败</h1><pre>${message.replace(/</g, '&lt;')}</pre>
    <p>请确认浏览器支持 WebGL2（设置 → 硬件加速），或查看控制台错误。</p>`;
  document.body.appendChild(overlay);
}

function bootstrap(): void {
  const container = document.getElementById('app');
  const canvas = document.getElementById('viewport');

  if (!(container instanceof HTMLElement)) throw new Error('找不到 #app 容器');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('找不到 #viewport 画布');

  const engine = new Engine({ container, canvas });
  engine.start();

  // 方便在浏览器控制台调试：engine.time.setPaused(true) 之类
  (window as unknown as { engine: Engine }).engine = engine;
}

try {
  bootstrap();
} catch (error) {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  console.error(error);
  showFatal(message);
}
