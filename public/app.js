--- public/app.js	2026-09-17 01:34:15.000000000 +0000
+++ /home/claude/inspect/straindex_app/straindex-app/public/app.js	2026-09-17 23:34:03.558305880 +0000
@@ -820,34 +820,59 @@
   if (btn) btn.classList.add('active');
 }
 
-// PWA install prompt -- captures the browser's own beforeinstallprompt
-// event (fired only on browsers that support one-tap install: Android
-// Chrome, desktop Chrome/Edge, and similar Chromium browsers) and wires it
-// up to any [data-install-trigger] button already on the page. iOS Safari
-// never fires this event at all -- Apple doesn't expose any install API to
-// websites, by design -- so on iOS these buttons simply stay hidden
-// forever and the manual Add to Home Screen instructions (see
-// /add-to-home-screen) are the only path. Nothing here can change that;
-// it's a platform restriction, not a bug.
-(function initInstallPrompt() {
+// PWA install -- captures the browser's own beforeinstallprompt event
+// (fired only on browsers that support one-tap install: Android Chrome,
+// desktop Chrome/Edge, and similar Chromium browsers), wires it up to any
+// [data-install-trigger] button already on the page, AND exposes a small
+// shared window.StrainDexInstall API so other scripts on the page (the
+// onboarding install-offer step, /add-to-home-screen) can trigger the same
+// native prompt or check platform/install state without each maintaining
+// their own beforeinstallprompt listener. iOS Safari never fires this
+// event at all -- Apple doesn't expose any install API to websites, by
+// design -- so isIOS() is how callers know to fall back to manual Share ->
+// Add to Home Screen instructions instead of waiting on a prompt that will
+// never come. Nothing here can change that; it's a platform restriction,
+// not a bug.
+window.StrainDexInstall = (function initInstallPrompt() {
   let deferredPrompt = null;
+  let installed = false;
+  const availableCallbacks = [];
+
+  function isStandalone() {
+    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
+  }
+  // iPadOS 13+ reports itself as "Macintosh" in the user agent, so a plain
+  // /iphone|ipad/i test misses iPads -- the ontouchend check catches those
+  // without also matching an actual Mac (which has no touch events).
+  function isIOS() {
+    return /iP(hone|od|ad)/.test(navigator.platform) ||
+      (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
+  }
+
+  function hideButtons() {
+    document.querySelectorAll('[data-install-trigger]').forEach(b => { b.style.display = 'none'; });
+  }
+
+  async function triggerPrompt() {
+    if (!deferredPrompt) return 'unavailable';
+    deferredPrompt.prompt();
+    const { outcome } = await deferredPrompt.userChoice;
+    deferredPrompt = null;
+    if (outcome === 'accepted') hideButtons();
+    return outcome; // 'accepted' | 'dismissed'
+  }
 
   function revealButtons() {
     document.querySelectorAll('[data-install-trigger]').forEach(btn => {
       btn.style.display = '';
       btn.onclick = async () => {
-        if (!deferredPrompt) return;
         btn.disabled = true;
-        deferredPrompt.prompt();
-        const { outcome } = await deferredPrompt.userChoice;
-        deferredPrompt = null;
-        if (outcome === 'accepted') {
-          document.querySelectorAll('[data-install-trigger]').forEach(b => { b.style.display = 'none'; });
-        } else {
-          btn.disabled = false;
-        }
+        const outcome = await triggerPrompt();
+        if (outcome !== 'accepted') btn.disabled = false;
       };
     });
+    availableCallbacks.forEach(cb => cb());
+    availableCallbacks.length = 0;
   }
 
   window.addEventListener('beforeinstallprompt', (e) => {
@@ -859,9 +884,23 @@
   // Already installed (or just got installed this session) -- no reason to
   // keep offering the button.
   window.addEventListener('appinstalled', () => {
+    installed = true;
     deferredPrompt = null;
-    document.querySelectorAll('[data-install-trigger]').forEach(b => { b.style.display = 'none'; });
+    hideButtons();
   });
+
+  return {
+    isIOS,
+    isStandalone,
+    isAvailable: () => !!deferredPrompt,
+    isInstalled: () => installed || isStandalone(),
+    // Fires the native one-tap prompt and resolves to 'accepted',
+    // 'dismissed', or 'unavailable' (no captured prompt to show).
+    prompt: triggerPrompt,
+    // Calls back immediately if the prompt is already available, otherwise
+    // once beforeinstallprompt eventually fires.
+    onAvailable: (cb) => { if (deferredPrompt) cb(); else availableCallbacks.push(cb); },
+  };
 })();
 
 (function initFormSubmitFeedback() {
