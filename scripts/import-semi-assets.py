"""Vendor pinned Semi theme and SVG icons. No npm runtime dependencies are needed."""
import hashlib
import io
import json
import re
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path

VERSION = "2.104.0"
ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / "src/shell/vendor/semi"
ICONS = {
    "chat": "CustomerSupportStroked", "shop": "ShoppingBagStroked", "product": "Box",
    "order": "Article", "customer": "UserGroup", "task": "Bolt", "chart": "BarChartVStroked",
    "settings": "SettingStroked", "search": "SearchStroked", "add": "PlusStroked",
    "refresh": "Refresh", "columns": "ColumnsStroked", "more": "MoreStroked",
    "chevron-down": "ChevronDownStroked", "chevron-left": "ChevronLeft", "chevron-right": "ChevronRightStroked",
    "arrow-right": "ArrowRight", "close": "Close", "check": "Tick", "warning": "AlertTriangle",
    "info": "InfoCircle", "moon": "MoonStroked", "sun": "SunStroked", "help": "HelpCircleStroked",
    "link": "Link", "download": "DownloadStroked", "upload": "Upload", "key": "KeyStroked",
    "shield": "ShieldStroked", "bell": "BellStroked", "copy": "CopyStroked", "edit": "EditStroked",
    "trash": "DeleteStroked", "image": "ImageStroked", "send": "SendStroked", "user": "UserStroked",
    "coin": "CoinMoneyStroked", "timer": "ClockStroked", "folder": "FolderStroked", "palette": "ColorPalette",
}


def archive(name):
    url = f"https://registry.npmjs.org/@douyinfe/{name}/-/{name}-{VERSION}.tgz"
    cache = Path(tempfile.gettempdir()) / "xianyu-semi-assets" / (name + ".tgz")
    cache.parent.mkdir(parents=True, exist_ok=True)
    data = cache.read_bytes() if cache.exists() else urllib.request.urlopen(url, timeout=45).read()
    cache.write_bytes(data)
    return tarfile.open(fileobj=io.BytesIO(data), mode="r:gz"), url, hashlib.sha256(data).hexdigest()


DESTINATION.mkdir(parents=True, exist_ok=True)
theme, theme_url, theme_hash = archive("semi-theme-default")
palette = theme.extractfile("package/scss/_palette.scss").read().decode("utf-8")
tokens = theme.extractfile("package/scss/global.scss").read().decode("utf-8")
# These two source files contain ordinary CSS variables plus an import and line comments.
assert not re.search(r"\$[\w-]+|#\{|@(?:include|mixin|if|each|function|extend)", palette + tokens)
tokens = re.sub(r'@import\s+"\./_palette.scss";', "", tokens)
css = re.sub(r"//[^\n]*", "", palette + "\n" + tokens)
(DESTINATION / "tokens.css").write_text(f"/* Semi Design {VERSION}; MIT; see NOTICE.md. */\n" + css, encoding="utf-8")
(DESTINATION / "LICENSE-theme.txt").write_bytes(theme.extractfile("package/LICENSE").read())

icons, icons_url, icons_hash = archive("semi-icons")
sources = {name: icons.extractfile(f"package/lib/cjs/icons/Icon{component}.js").read().decode("utf-8")
           for name, component in ICONS.items()}
# Evaluate only the published static SVG renderers in a restricted VM, without loading React.
converter = r'''
const vm=require('vm'), fs=require('fs');
const sources=JSON.parse(fs.readFileSync(0,'utf8'));
const attrs={fillRule:'fill-rule',clipRule:'clip-rule',strokeWidth:'stroke-width',strokeLinecap:'stroke-linecap',strokeLinejoin:'stroke-linejoin'};
const escape=s=>String(s).replace(/[&"<>]/g,c=>({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'}[c]));
function render(node){if(node==null)return '';if(typeof node!=='object')return escape(node);
 if(typeof node.tag!=='string'||!['svg','path','g','circle','rect','ellipse','line','polyline','polygon','defs','clipPath'].includes(node.tag))throw Error('Unexpected SVG node');
 return '<'+node.tag+Object.entries(node.props||{}).filter(([key])=>key!=='children').map(([key,value])=>' '+(attrs[key]||key)+'="'+escape(value)+'"').join('')+'>'+node.children.map(render).join('')+'</'+node.tag+'>';}
const output={};for(const [name,source]of Object.entries(sources)){
 const module={exports:{}};
 const react={createElement:(tag,props,...children)=>({tag,props,children})};
 const requireMock=name=>{if(name==='react')return react;if(name==='../components/Icon')return{convertIcon:fn=>fn};throw Error('Unexpected import');};
 vm.runInNewContext('(function(require,module,exports){'+source+'\n})',{}, {timeout:1000})(requireMock,module,module.exports);
 output[name]=render(module.exports.default({}));
}process.stdout.write(JSON.stringify(output));
'''
result = subprocess.run(["node", "-e", converter], input=json.dumps(sources), encoding="utf-8", capture_output=True, check=True)
svg_icons = json.loads(result.stdout)
(DESTINATION / "icons").mkdir(exist_ok=True)
for name, svg in svg_icons.items():
    (DESTINATION / "icons" / (name + ".svg")).write_text(svg, encoding="utf-8")
(DESTINATION / "icons.css").write_text("\n".join(
    f'.icon-{name} {{ -webkit-mask-image: url("icons/{name}.svg"); mask-image: url("icons/{name}.svg"); }}'
    for name in ICONS), encoding="utf-8")
(DESTINATION / "LICENSE-icons.txt").write_bytes(icons.extractfile("package/LICENSE").read())
(DESTINATION / "NOTICE.md").write_text(f"""# Semi Design local assets

Version: {VERSION}. Copyright holders and MIT terms: LICENSE-theme.txt and LICENSE-icons.txt.

- Theme source: {theme_url}
  SHA-256: {theme_hash}
- Icon source: {icons_url}
  SHA-256: {icons_hash}

Generated by scripts/import-semi-assets.py. Theme CSS combines the published palette and global
variables with import directives and Sass line comments removed. Icons are the unmodified static
SVG shapes rendered from the published icon functions. No React runtime or Semi React component
implementation is included; the existing DOM interface uses Semi theme variables and SVG icons.
All assets are packaged locally and require no CDN at runtime.
""", encoding="utf-8")
print(json.dumps({"version": VERSION, "icons": len(svg_icons), "theme_bytes": len(css.encode("utf-8"))}))
