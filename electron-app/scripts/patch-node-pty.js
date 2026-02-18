/**
 * Patch node-pty to remove Spectre mitigation requirement.
 * node-pty requires Spectre-mitigated MSVC libraries which are not commonly installed.
 * This script patches the binding.gyp files to disable that requirement.
 */

const fs = require('fs');
const path = require('path');

const files = [
  path.join(__dirname, '..', 'node_modules', 'node-pty', 'binding.gyp'),
  path.join(__dirname, '..', 'node_modules', 'node-pty', 'deps', 'winpty', 'src', 'winpty.gyp'),
];

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log(`Skipping (not found): ${file}`);
    continue;
  }
  let content = fs.readFileSync(file, 'utf-8');
  if (content.includes("'SpectreMitigation': 'Spectre'")) {
    content = content.replace(/'SpectreMitigation': 'Spectre'/g, "'SpectreMitigation': ''");
    fs.writeFileSync(file, content, 'utf-8');
    console.log(`Patched Spectre mitigation: ${path.basename(file)}`);
  } else {
    console.log(`Already patched: ${path.basename(file)}`);
  }
}
