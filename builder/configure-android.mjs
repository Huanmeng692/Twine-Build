import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const config = JSON.parse(fs.readFileSync(path.join(root, 'twine-build.json'), 'utf8'));
const androidRoot = path.join(root, 'android');

if (!fs.existsSync(androidRoot)) {
  console.error('[ERROR] Android 工程不存在，请先运行 npx cap add android。');
  process.exit(1);
}

const appBuildGradlePath = path.join(androidRoot, 'app', 'build.gradle');
if (!fs.existsSync(appBuildGradlePath)) {
  console.error('[ERROR] Cannot find android/app/build.gradle.');
  process.exit(1);
}
if (!Number.isInteger(config.versionCode) || config.versionCode < 1) {
  console.error('[ERROR] versionCode must be a positive integer.');
  process.exit(1);
}

let appBuildGradle = fs.readFileSync(appBuildGradlePath, 'utf8');
const versionCodePattern = /^(\s*)versionCode\s+\d+\s*$/m;
const versionNamePattern = /^(\s*)versionName\s+["'][^"']+["']\s*$/m;
if (!versionCodePattern.test(appBuildGradle) || !versionNamePattern.test(appBuildGradle)) {
  console.error('[ERROR] Cannot locate versionCode/versionName in the Capacitor Android template.');
  process.exit(1);
}
appBuildGradle = appBuildGradle
  .replace(versionCodePattern, `$1versionCode ${config.versionCode}`)
  .replace(versionNamePattern, `$1versionName "${config.version}"`);
fs.writeFileSync(appBuildGradlePath, appBuildGradle);
console.log(`[OK] Android versionCode=${config.versionCode}, versionName=${config.version}`);

function findFile(directory, filename) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(fullPath, filename);
      if (found) return found;
    } else if (entry.name === filename) {
      return fullPath;
    }
  }
  return null;
}

const activityPath = findFile(path.join(androidRoot, 'app', 'src', 'main', 'java'), 'MainActivity.java');
if (!activityPath) {
  console.error('[ERROR] 找不到 Android MainActivity.java。');
  process.exit(1);
}

if (config.android?.immersive !== false) {
  const fullscreenBackground = /^#[0-9a-f]{6}$/i.test(config.android?.fullscreenBackgroundColor || '')
    ? config.android.fullscreenBackgroundColor
    : '#000000';

  let source = fs.readFileSync(activityPath, 'utf8');
  if (!source.includes('TWINE_BUILD_IMMERSIVE')) {
    source = source.replace(
      'import com.getcapacitor.BridgeActivity;',
      `import com.getcapacitor.BridgeActivity;\nimport android.os.Bundle;\nimport android.os.Build;\nimport android.graphics.Color;\nimport android.view.WindowManager;\nimport androidx.core.view.WindowCompat;\nimport androidx.core.view.WindowInsetsCompat;\nimport androidx.core.view.WindowInsetsControllerCompat;`
    );
    source = source.replace(
      /public class MainActivity extends BridgeActivity\s*\{\s*\}/,
      `public class MainActivity extends BridgeActivity {\n  // TWINE_BUILD_IMMERSIVE\n  private void hideSystemBars() {\n    WindowCompat.setDecorFitsSystemWindows(getWindow(), false);\n    WindowInsetsControllerCompat controller =\n        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());\n    controller.hide(WindowInsetsCompat.Type.systemBars());\n    controller.setSystemBarsBehavior(\n        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);\n  }\n\n  @Override\n  protected void onCreate(Bundle savedInstanceState) {\n    super.onCreate(savedInstanceState);\n    WindowCompat.enableEdgeToEdge(getWindow());\n    getWindow().getDecorView().setBackgroundColor(Color.parseColor("${fullscreenBackground}"));\n    if (getBridge() != null && getBridge().getWebView() != null) {\n      getBridge().getWebView().setBackgroundColor(Color.parseColor("${fullscreenBackground}"));\n    }\n    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {\n      WindowManager.LayoutParams attributes = getWindow().getAttributes();\n      attributes.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R\n          ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS\n          : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;\n      getWindow().setAttributes(attributes);\n    }\n    hideSystemBars();\n  }\n\n  @Override\n  public void onResume() {\n    super.onResume();\n    hideSystemBars();\n  }\n\n  @Override\n  public void onWindowFocusChanged(boolean hasFocus) {\n    super.onWindowFocusChanged(hasFocus);\n    if (hasFocus) hideSystemBars();\n  }\n}`
    );
    if (!source.includes('TWINE_BUILD_IMMERSIVE')) {
      console.error('[ERROR] 无法修改 MainActivity.java，Capacitor 模板结构可能已经变化。');
      process.exit(1);
    }
    fs.writeFileSync(activityPath, source);
    console.log('[OK] 已启用 Android 沉浸式全屏；从屏幕边缘滑动可临时呼出系统栏。');
  }
}

// 注入的 Java 源码含中文提示，必须固定编译编码，否则在 GBK 环境下会乱码。
{
  const currentGradle = fs.readFileSync(appBuildGradlePath, 'utf8');
  if (!currentGradle.includes('TWINE_BUILD_UTF8')) {
    fs.writeFileSync(
      appBuildGradlePath,
      `${currentGradle}\n// TWINE_BUILD_UTF8\ntasks.withType(JavaCompile).configureEach {\n    options.encoding = 'UTF-8'\n}\n`
    );
    console.log('[OK] Java 编译编码已固定为 UTF-8。');
  }
}

// 补齐 WebView 下载通道，让 SugarCube 的「保存到磁盘」真正落盘。
{
  let source = fs.readFileSync(activityPath, 'utf8');
  if (!source.includes('TWINE_BUILD_DOWNLOADS')) {
    const downloadImports = [
      'import android.app.Activity;',
      'import android.app.DownloadManager;',
      'import android.content.ContentValues;',
      'import android.content.Context;',
      'import android.content.Intent;',
      'import android.net.Uri;',
      'import android.os.Environment;',
      'import android.provider.MediaStore;',
      'import android.util.Base64;',
      'import android.webkit.DownloadListener;',
      'import android.webkit.JavascriptInterface;',
      'import android.webkit.URLUtil;',
      'import android.webkit.WebView;',
      'import android.widget.Toast;',
      'import java.io.File;',
      'import java.io.FileOutputStream;',
      'import java.io.OutputStream;',
      'import java.text.SimpleDateFormat;',
      'import java.util.Date;',
      'import java.util.Locale;',
      'import org.json.JSONObject;'
    ].join('\n');

    const downloadBody = `
  // TWINE_BUILD_DOWNLOADS
  private boolean twineDownloadsReady = false;

  private void twineAttachDownloads() {
    if (twineDownloadsReady || getBridge() == null) { return; }
    final WebView webView = getBridge().getWebView();
    if (webView == null) { return; }
    twineDownloadsReady = true;

    webView.addJavascriptInterface(new TwineFileSaver(this), "TwineFileSaver");
    webView.setDownloadListener(new DownloadListener() {
      @Override
      public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
        final String fileName = twineResolveFileName(url, contentDisposition, mimeType);
        if (url != null && url.startsWith("blob:")) {
          String script = "(function(){try{"
              + "var x=new XMLHttpRequest();x.open('GET'," + JSONObject.quote(url) + ",true);"
              + "x.responseType='blob';"
              + "x.onload=function(){var r=new FileReader();"
              + "r.onloadend=function(){TwineFileSaver.save(r.result," + JSONObject.quote(fileName) + ");};"
              + "r.readAsDataURL(x.response);};x.send();"
              + "}catch(e){}})()";
          webView.evaluateJavascript(script, null);
        } else {
          twineDownloadWithManager(url, userAgent, mimeType, fileName);
        }
      }
    });
  }

  private static String twineResolveFileName(String url, String contentDisposition, String mimeType) {
    String name = null;
    try {
      name = URLUtil.guessFileName(url, contentDisposition, mimeType);
    } catch (Exception ignored) {
    }
    if (name == null || name.trim().isEmpty() || "downloadfile.bin".equals(name)) {
      String suffix = (mimeType != null && mimeType.contains("json")) ? ".json" : ".save";
      name = "twine-save-" + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date()) + suffix;
    }
    return name;
  }

  private void twineDownloadWithManager(String url, String userAgent, String mimeType, String fileName) {
    try {
      DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
      if (mimeType != null) { request.setMimeType(mimeType); }
      if (userAgent != null) { request.addRequestHeader("User-Agent", userAgent); }
      request.setTitle(fileName);
      request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
      request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
      DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
      if (manager != null) { manager.enqueue(request); }
    } catch (Exception ignored) {
    }
  }

  public static class TwineFileSaver {
    private final Activity host;

    TwineFileSaver(Activity host) {
      this.host = host;
    }

    @JavascriptInterface
    public void save(final String dataUrl, final String fileName) {
      if (dataUrl == null) { return; }
      new Thread(new Runnable() {
        @Override
        public void run() {
          String message;
          try {
            String payload = dataUrl;
            String mime = "application/octet-stream";
            int comma = payload.indexOf(',');
            if (payload.startsWith("data:") && comma > 0) {
              String header = payload.substring(5, comma);
              int semi = header.indexOf(';');
              mime = (semi > 0) ? header.substring(0, semi) : header;
              payload = payload.substring(comma + 1);
            }
            byte[] bytes = Base64.decode(payload, Base64.DEFAULT);
            message = "已保存到 " + write(bytes, fileName, mime);
          } catch (Exception error) {
            String detail = error.getMessage();
            message = "保存失败：" + (detail == null ? error.getClass().getSimpleName() : detail);
          }
          final String text = message;
          host.runOnUiThread(new Runnable() {
            @Override
            public void run() {
              Toast.makeText(host, text, Toast.LENGTH_LONG).show();
            }
          });
        }
      }).start();
    }

    private String write(byte[] bytes, String fileName, String mime) throws Exception {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        Uri uri = host.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) { throw new IllegalStateException("无法在下载目录创建文件"); }
        OutputStream stream = host.getContentResolver().openOutputStream(uri);
        if (stream == null) { throw new IllegalStateException("无法写入下载目录"); }
        stream.write(bytes);
        stream.flush();
        stream.close();
        return "下载/" + fileName;
      }
      File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
      if (!dir.exists() && !dir.mkdirs()) { throw new IllegalStateException("无法创建下载目录"); }
      File out = new File(dir, fileName);
      FileOutputStream stream = new FileOutputStream(out);
      stream.write(bytes);
      stream.flush();
      stream.close();
      host.sendBroadcast(new Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, Uri.fromFile(out)));
      return out.getAbsolutePath();
    }
  }
`;

    source = source.replace(/^(package [^\n]+;\n)/m, `$1\n${downloadImports}\n`);

    const closing = source.lastIndexOf('}');
    source = source.slice(0, closing) + downloadBody + '\n}\n';

    const hookAnchor = 'super.onResume();\n    hideSystemBars();';
    if (source.includes(hookAnchor)) {
      source = source.replace(hookAnchor, `${hookAnchor}\n    twineAttachDownloads();`);
    } else {
      source = source.replace(
        'super.onCreate(savedInstanceState);',
        'super.onCreate(savedInstanceState);\n    twineAttachDownloads();'
      );
    }

    if (!source.includes('twineAttachDownloads();')) {
      console.error('[ERROR] 无法在 MainActivity 中挂载下载支持，Capacitor 模板结构可能已变化。');
      process.exit(1);
    }

    fs.writeFileSync(activityPath, source);
    console.log('[OK] 已启用下载支持：故事里的「保存到磁盘」会写入系统下载目录。');
  }
}

const configuredIcon = config.icon ? path.resolve(root, config.icon) : null;
if (configuredIcon && fs.existsSync(configuredIcon)) {
  const resDirectory = path.join(androidRoot, 'app', 'src', 'main', 'res');
  const densities = {
    mdpi: { legacy: 48, adaptive: 108 },
    hdpi: { legacy: 72, adaptive: 162 },
    xhdpi: { legacy: 96, adaptive: 216 },
    xxhdpi: { legacy: 144, adaptive: 324 },
    xxxhdpi: { legacy: 192, adaptive: 432 }
  };
  const background = config.android?.iconBackgroundColor || '#ffffff';

  for (const [density, sizes] of Object.entries(densities)) {
    const directory = path.join(resDirectory, `mipmap-${density}`);
    fs.mkdirSync(directory, { recursive: true });
    for (const entry of fs.readdirSync(directory)) {
      if (/^ic_launcher(?:_round|_foreground)?\./.test(entry)) {
        fs.rmSync(path.join(directory, entry), { force: true });
      }
    }
    await sharp(configuredIcon)
      .resize(sizes.legacy, sizes.legacy, { fit: 'contain', background })
      .png()
      .toFile(path.join(directory, 'ic_launcher.png'));
    await sharp(configuredIcon)
      .resize(sizes.legacy, sizes.legacy, { fit: 'contain', background })
      .png()
      .toFile(path.join(directory, 'ic_launcher_round.png'));
    const foregroundSize = Math.round(sizes.adaptive * 0.66);
    await sharp(configuredIcon)
      .resize(foregroundSize, foregroundSize, { fit: 'contain' })
      .extend({
        top: Math.floor((sizes.adaptive - foregroundSize) / 2),
        bottom: Math.ceil((sizes.adaptive - foregroundSize) / 2),
        left: Math.floor((sizes.adaptive - foregroundSize) / 2),
        right: Math.ceil((sizes.adaptive - foregroundSize) / 2),
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toFile(path.join(directory, 'ic_launcher_foreground.png'));
  }

  const valuesDirectory = path.join(resDirectory, 'values');
  fs.mkdirSync(valuesDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(valuesDirectory, 'ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${background}</color>\n</resources>\n`
  );
  console.log(`[OK] 已从 ${config.icon} 生成 Android 各尺寸图标。`);
} else {
  console.warn(`[WARN] 图标文件不存在：${config.icon || '(未配置)'}；Android 将使用默认图标。`);
}
