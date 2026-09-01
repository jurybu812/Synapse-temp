const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

async function generateIcon() {
  const sourcePath = path.resolve(__dirname, '..', 'public', 'favicon.svg');
  const outputPath = path.resolve(__dirname, '..', 'public', 'icon.png');
  const svg = fs.readFileSync(sourcePath, 'utf8');
  const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const html = `<!doctype html>
    <html>
      <body style="margin:0;width:512px;height:512px;display:grid;place-items:center;background:transparent;overflow:hidden">
        <img id="icon" alt="" src="${source}" style="width:416px;height:416px;object-fit:contain" />
      </body>
    </html>`;
  const window = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });

  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const icon = document.getElementById('icon');
      if (icon.complete && icon.naturalWidth > 0) return resolve();
      icon.addEventListener('load', resolve, { once: true });
      icon.addEventListener('error', () => reject(new Error('icon SVG failed to load')), { once: true });
    })`);
    const captured = await window.capturePage();
    if (captured.isEmpty()) throw new Error('captured icon is empty');
    const image = captured.resize({ width: 512, height: 512, quality: 'best' });
    const size = image.getSize();
    if (size.width !== 512 || size.height !== 512) {
      throw new Error(`unexpected icon size ${size.width}x${size.height}`);
    }
    fs.writeFileSync(outputPath, image.toPNG());
    console.log(`Generated ${outputPath} (${size.width}x${size.height})`);
  } finally {
    window.destroy();
  }
}

app.whenReady()
  .then(generateIcon)
  .then(() => app.quit())
  .catch(error => {
    console.error(error);
    app.exit(1);
  });
