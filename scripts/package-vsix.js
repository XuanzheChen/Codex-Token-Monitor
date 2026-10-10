"use strict";

const fs = require("fs");
const path = require("path");

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const buildRoot = path.join(root, ".vsix-build");
const extensionRoot = path.join(buildRoot, "extension");
const distRoot = path.join(root, "dist");
const output = path.join(distRoot, `${pkg.name}-${pkg.version}.vsix`);

clean(buildRoot);
fs.mkdirSync(extensionRoot, { recursive: true });
fs.mkdirSync(distRoot, { recursive: true });

copyFile("package.json");
copyFile("README.md");
copyFile("LICENSE");
copyFile("CHANGELOG.md");
copyDir("src");

writeFile(
  path.join(buildRoot, "[Content_Types].xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
</Types>
`
);

writeFile(
  path.join(buildRoot, "extension.vsixmanifest"),
  `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${escapeXml(pkg.name)}" Version="${escapeXml(pkg.version)}" Publisher="${escapeXml(pkg.publisher)}"/>
    <DisplayName>${escapeXml(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${escapeXml(pkg.description)}</Description>
    <Tags>codex token usage monitor vscode</Tags>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(pkg.engines.vscode)}"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true"/>
  </Assets>
</PackageManifest>
`
);

if (fs.existsSync(output)) {
  fs.unlinkSync(output);
}

writeZip(output, listFiles(buildRoot));

clean(buildRoot);
console.log(`Created ${output}`);

function copyFile(relativePath) {
  fs.copyFileSync(path.join(root, relativePath), path.join(extensionRoot, relativePath));
}

function copyDir(relativePath) {
  const source = path.join(root, relativePath);
  const target = path.join(extensionRoot, relativePath);
  fs.mkdirSync(target, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const entrySource = path.join(source, entry.name);
    const entryTarget = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDir(path.join(relativePath, entry.name));
    } else if (entry.isFile()) {
      fs.copyFileSync(entrySource, entryTarget);
    }
  }
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function clean(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function listFiles(baseDir) {
  const files = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile()) {
        files.push({
          fullPath,
          zipPath: path.relative(baseDir, fullPath).replace(/\\/g, "/")
        });
      }
    }
  }

  walk(baseDir);
  return files.sort((a, b) => a.zipPath.localeCompare(b.zipPath));
}

function writeZip(outputPath, files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const data = fs.readFileSync(file.fullPath);
    const name = Buffer.from(file.zipPath, "utf8");
    const stat = fs.statSync(file.fullPath);
    const dos = toDosDateTime(stat.mtime);
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dos.time, 10);
    localHeader.writeUInt16LE(dos.date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dos.time, 12);
    centralHeader.writeUInt16LE(dos.date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(outputPath, Buffer.concat([...localParts, ...centralParts, end]));
}

function toDosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
