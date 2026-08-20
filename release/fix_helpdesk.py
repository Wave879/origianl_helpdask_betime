#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Fix mojibake in help-desk-v2.html:
1. Decode garbled Thai strings (Windows-874 bytes misread as Latin-1, saved as UTF-8 codepoints)
2. Wrap form in panelInput, analysis in panelAnalysis for inline switching
3. Add switchToPanel() JS function and MutationObserver auto-fixer
4. Remove URL redirect logic (no more ?view=analysis)
"""

import re

SRC = r'd:\betime solution\All_in_betime\BETIME\deploy\pages_bundle\help-desk-v2.html'

def repair_mojibake(s):
    """Repair Thai text that was saved as Latin-1/Windows-874 bytes then stored as UTF-8 codepoints."""
    try:
        # Take low byte of each character (codepoint & 0xFF) as a byte sequence
        raw = bytes(ord(c) & 0xFF for c in s)
        # Try UTF-8 decode
        decoded = raw.decode('utf-8')
        # Check if result looks like Thai (contains Thai Unicode range)
        thai_count = sum(1 for c in decoded if '\u0E00' <= c <= '\u0E7F')
        orig_thai = sum(1 for c in s if '\u0E00' <= c <= '\u0E7F')
        if thai_count > orig_thai:
            return decoded
    except Exception:
        pass
    try:
        raw = bytes(ord(c) & 0xFF for c in s)
        return raw.decode('windows-874')
    except Exception:
        pass
    return s

MOJIBAKE_PATTERN = re.compile(r'[\u0E40\u0E18\u0E19\u0E42][\u0E08-\u0E7F]{2,}')

def fix_text(s):
    def replace_match(m):
        fixed = repair_mojibake(m.group(0))
        return fixed
    return MOJIBAKE_PATTERN.sub(replace_match, s)

with open(SRC, 'r', encoding='utf-8') as f:
    content = f.read()

lines = content.split('\n')
fixed_lines = []
for line in lines:
    fixed_lines.append(fix_text(line))

content = '\n'.join(fixed_lines)

# --- Structural changes ---

# 1. Wrap form section in panelInput div
content = content.replace(
    '        <div class="v2-form">',
    '        <!-- Panel 1: Input Form -->\n        <div class="v2-section-panel active" id="panelInput">\n        <div class="v2-form">',
    1
)
# Close panelInput after </div> that closes v2-form
# Find the closing of v2-form before v2-analysis
old_close = '        </div>\n\n        <div class="v2-analysis"'
new_close = '        </div>\n        </div><!-- end panelInput -->\n\n        <!-- Panel 2: Analysis + Chat -->\n        <div class="v2-section-panel" id="panelAnalysis">\n        <div class="v2-analysis"'
content = content.replace(old_close, new_close, 1)

# Close panelAnalysis before </div><!-- end v2-card -->
old_card_end = '      </div>\n\n      <aside class="v2-side"'
new_card_end = '      </div>\n      </div><!-- end panelAnalysis -->\n\n      <aside class="v2-side"'
content = content.replace(old_card_end, new_card_end, 1)

# 2. Add "back" button + fix result-tabs
old_tabs = '''          <div class="v2-result-tabs" role="tablist" aria-label="มุมมองผลลัพธ์">
            <button class="v2-result-tab active" id="analysisTabBtn" type="button" data-result-tab="analysis" onclick="setResultTab('analysis')">ผลวิเคราะห์</button>
            <button class="v2-result-tab" id="chatTabBtn" type="button" data-result-tab="chat" onclick="setResultTab('chat')">พูดคุย</button>
          </div>'''
new_tabs = '''          <div class="v2-result-tabs" role="tablist" aria-label="มุมมองผลลัพธ์" style="display:flex;align-items:center;gap:8px;padding-bottom:14px">
            <button class="v2-btn secondary" style="padding:8px 14px;font-size:0.82rem" id="backToFormBtn" onclick="switchToPanel('input')">← แก้ไขข้อมูล</button>
            <button class="v2-result-tab active" id="analysisTabBtn" type="button" data-result-tab="analysis" onclick="setResultTab('analysis')">ผลวิเคราะห์</button>
            <button class="v2-result-tab" id="chatTabBtn" type="button" data-result-tab="chat" onclick="setResultTab('chat')">พูดคุย</button>
          </div>'''
if old_tabs in content:
    content = content.replace(old_tabs, new_tabs, 1)
else:
    print("WARNING: result-tabs pattern not found for replacement")

# 3. Add switchToPanel() JS function + MutationObserver auto-fixer before BT.initApp
inject_js = '''
  // ─── Inline Panel Switching (no URL redirect) ───────────────────────────
  function switchToPanel(name) {
    document.querySelectorAll('.v2-section-panel').forEach(p => {
      p.classList.toggle('active', p.id === 'panel' + name.charAt(0).toUpperCase() + name.slice(1));
    });
  }

  // ─── Auto-repair mojibake in DOM text nodes ─────────────────────────────
  function fixDomMojibake(root) {
    const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const orig = node.textContent;
      if (!orig || !/[\\u0e40\\u0e18\\u0e19\\u0e42]/.test(orig)) continue;
      try {
        const bytes = Uint8Array.from(orig, ch => ch.charCodeAt(0) & 0xff);
        const fixed = new TextDecoder('utf-8').decode(bytes);
        const thaiOrig = (orig.match(/[\\u0e00-\\u0e7f]/g) || []).length;
        const thaiFixed = (fixed.match(/[\\u0e00-\\u0e7f]/g) || []).length;
        if (thaiFixed > thaiOrig) node.textContent = fixed;
      } catch(e) {}
    }
  }

  // Observe DOM mutations and auto-repair new text
  const _mojiObserver = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          const orig = node.textContent;
          if (!orig || !/[\\u0e40\\u0e18\\u0e19\\u0e42]/.test(orig)) continue;
          try {
            const bytes = Uint8Array.from(orig, ch => ch.charCodeAt(0) & 0xff);
            const fixed = new TextDecoder('utf-8').decode(bytes);
            const thaiOrig = (orig.match(/[\\u0e00-\\u0e7f]/g) || []).length;
            const thaiFixed = (fixed.match(/[\\u0e00-\\u0e7f]/g) || []).length;
            if (thaiFixed > thaiOrig) node.textContent = fixed;
          } catch(e) {}
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          fixDomMojibake(node);
        }
      }
    }
  });

'''
# Insert before BT.initApp
content = content.replace("  BT.initApp('help-desk-v2.html', 'Chat V2');", inject_js + "  BT.initApp('help-desk-v2.html', 'Chat V2');", 1)

# 4. Update activateFlowView to NOT redirect to ?view=analysis
old_activate = """  function activateFlowView(step) {
    const nextStep = ['input', 'analysis', 'chat', 'send', 'odoo'].includes(step) ? step : 'input';
    if (nextStep === 'analysis' && !isAnalysisMode()) {
      window.location.href = `${window.location.pathname}?view=analysis`;
      return;
    }
    if (nextStep === 'input' && isAnalysisMode()) {
      window.location.href = window.location.pathname;
      return;
    }
    setFlowStep(nextStep);"""
new_activate = """  function activateFlowView(step) {
    const nextStep = ['input', 'analysis', 'chat', 'send', 'odoo'].includes(step) ? step : 'input';
    setFlowStep(nextStep);"""
if old_activate in content:
    content = content.replace(old_activate, new_activate, 1)
else:
    print("WARNING: activateFlowView pattern not found")

# 5. Remove redirect in analyzeIssue
old_redirect = """      if (!isAnalysisMode()) {
        window.location.href = `${window.location.pathname}?view=analysis`;
        return;
      }"""
new_redirect = "      switchToPanel('analysis');"
if old_redirect in content:
    content = content.replace(old_redirect, new_redirect, 1)
else:
    print("WARNING: analyzeIssue redirect not found")

# 6. Update DOMContentLoaded — remove analysis-mode class and URL check
old_dcl = """    try {
      if (isAnalysisMode()) {
        document.body.classList.add('analysis-mode');
      }
      bindFlowStepper();
      await loadProjects();
      await loadDevDirectory();
      if (isAnalysisMode()) {
        const restored = await restoreAnalysisSnapshot();
        if (!restored) {
          document.getElementById('analysisSection').classList.add('show');
          document.getElementById('chatSection').classList.add('show');
          document.getElementById('analysisPreviewSummaryBox').textContent = 'ยังไม่มีข้อมูลวิเคราะห์ กรุณากลับไปหน้าใส่ข้อมูลแล้วกดวิเคราะห์อีกครั้ง';
          document.getElementById('analysisPreviewCauseBox').textContent = '-';
          setFlowStep('analysis');
        }
      }
    }"""
new_dcl = """    try {
      bindFlowStepper();
      await loadProjects();
      await loadDevDirectory();
      // Start MutationObserver for auto-repair
      _mojiObserver.observe(document.body, { childList: true, subtree: true });
      // Fix existing DOM text
      fixDomMojibake(document.body);
    }"""
if old_dcl in content:
    content = content.replace(old_dcl, new_dcl, 1)
else:
    print("WARNING: DOMContentLoaded pattern not found")

# 7. Also fix resetPage to use switchToPanel
old_reset_close = """    closeAnalysisModal();
    closeChatModal();
    closeDevModal();"""
new_reset_close = """    closeAnalysisModal();
    closeChatModal();
    closeDevModal();
    switchToPanel('input');"""
content = content.replace(old_reset_close, new_reset_close, 1)

with open(SRC, 'w', encoding='utf-8') as f:
    f.write(content)

print("Done! help-desk-v2.html fixed successfully.")
print("Changes applied:")
print("  - Mojibake Thai text repaired throughout")
print("  - Form wrapped in #panelInput, analysis in #panelAnalysis")
print("  - Added switchToPanel() + MutationObserver auto-repair")
print("  - Removed URL redirect, switched to inline panel toggle")
print("  - Reset button now returns to input panel")
