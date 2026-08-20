const fs = require('fs');

const filePath = 'd:\\betime solution\\All_in_betime\\BETIME\\deploy\\pages_bundle\\help-desk-v2.html';
let content = fs.readFileSync(filePath, 'utf8');

function fix(str) {
  const bytes = Uint8Array.from(str, (ch) => ch.charCodeAt(0) & 0xff);
  return new TextDecoder('utf-8').decode(bytes);
}

const regex = /([ก-๙เธเนโ]+)/g;
let replacements = {};
let uniqueMatches = [...new Set(content.match(regex) || [])];

for (let match of uniqueMatches) {
    if (match.includes('เธ') || match.includes('เน')) {
        try {
            let fixed = fix(match);
            if (/[\u0E00-\u0E7F]/.test(fixed) && fixed !== match && !fixed.includes('\uFFFD')) {
                replacements[match] = fixed;
            }
        } catch (e) {}
    }
}

let modifiedContent = content;
for (const [from, to] of Object.entries(replacements)) {
    modifiedContent = modifiedContent.split(from).join(to);
}

// Also replace the repairMojibake function to prevent it from corrupting text
const repairRegex = /function repairMojibake\(value\) \{[\s\S]*?return best;\n  \}/;
const safeRepair = `function repairMojibake(value) {
    return String(value ?? '');
  }`;

modifiedContent = modifiedContent.replace(repairRegex, safeRepair);

fs.writeFileSync(filePath, modifiedContent, 'utf8');
console.log('Fixed mojibake in the file successfully.');
