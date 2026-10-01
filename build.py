# -*- coding: utf-8 -*-
"""
离线 VSIX 打包器

VSIX 本质就是一个约定结构的 zip：
  extension.vsixmanifest     <- 清单（XML，含 Identity / Engine / Assets）
  [Content_Types].xml        <- 内容类型声明
  extension/                 <- 扩展本体（package.json + 代码）

用法：python build.py
输出：releases/agl-context-pro-<version>.vsix
"""
import json
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'releases')

EXT_FILES = ['package.json', 'extension.js', 'lsclient.js', 'README.md']

MANIFEST = '''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="zh-cn" Id="{ext_id}" Version="{version}" Publisher="{publisher}"/>
    <DisplayName>{display_name}</DisplayName>
    <Description xml:space="preserve">{description}</Description>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{engine}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui,workspace"/>
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value=""/>
    </Properties>
    <Assets>
      <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    </Assets>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
</PackageManifest>
'''

CONTENT_TYPES = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="js" ContentType="application/javascript"/>
</Types>
'''


def xml_escape(s):
    return (s.replace('&', '&amp;').replace('<', '&lt;')
             .replace('>', '&gt;').replace('"', '&quot;'))


def main():
    with open(os.path.join(HERE, 'package.json'), encoding='utf-8') as f:
        pkg = json.load(f)

    os.makedirs(OUT, exist_ok=True)
    out_path = os.path.join(OUT, '%s-%s.vsix' % (pkg['name'], pkg['version']))

    manifest = MANIFEST.format(
        ext_id=pkg['name'],
        version=pkg['version'],
        publisher=pkg['publisher'],
        display_name=xml_escape(pkg.get('displayName', pkg['name'])),
        description=xml_escape(pkg.get('description', '')),
        engine=pkg['engines']['vscode'],
    )

    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('extension.vsixmanifest', manifest)
        z.writestr('[Content_Types].xml', CONTENT_TYPES)
        for name in EXT_FILES:
            src = os.path.join(HERE, name)
            if os.path.isfile(src):
                z.write(src, 'extension/' + name)
            else:
                print('  [跳过] 缺少 %s' % name)

    size = os.path.getsize(out_path)
    print('打包完成: %s (%.1f KB)' % (out_path, size / 1024.0))


if __name__ == '__main__':
    main()
