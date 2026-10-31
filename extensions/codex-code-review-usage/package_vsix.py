"""Build a dependency-free local VSIX using the standard VSIX/OPC layout."""
import json
import sys
from html import escape
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

source = Path(__file__).resolve().parent
meta = {key: escape(value, quote=True) if isinstance(value, str) else value for key, value in json.loads((source / 'package.json').read_text(encoding='utf-8')).items()}
output = Path(sys.argv[1]).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Language="en-US" Id="{meta['name']}" Version="{meta['version']}" Publisher="{meta['publisher']}"/><DisplayName>{meta['displayName']}</DisplayName><Description xml:space="preserve">{meta['description']}</Description><Tags>codex,review</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.85.0"/></Properties></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon.png" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>'''
with ZipFile(output, 'x', ZIP_DEFLATED) as archive:
    archive.writestr('extension.vsixmanifest', manifest)
    archive.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="svg" ContentType="image/svg+xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>')
    for name in ['package.json', 'extension.js', 'core.js', 'usage.js', 'monthly-usage.js', 'backend-quota.js', 'dashboard-panel.js', 'README.md']:
        archive.write(source / name, f'extension/{name}')
    for asset in (source / 'media').iterdir():
        if asset.suffix not in {'.svg', '.png'}:
            continue
        archive.write(asset, f'extension/media/{asset.name}')
with ZipFile(output) as archive:
    assert archive.testzip() is None
print(output)
