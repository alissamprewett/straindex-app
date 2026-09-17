--- server.js	2026-09-17 23:20:35.000000000 +0000
+++ /home/claude/inspect/straindex_app/straindex-app/server.js	2026-09-17 23:35:02.785054394 +0000
@@ -1771,44 +1771,207 @@
     { icon: '📊', title: 'See your own patterns', body: 'Your Patterns reflects your check-in history back at you — favorite effects, top strain type, even a tolerance break tracker.' },
     { icon: '🧑\u200d🤝\u200d🧑', title: 'Bring your friends', body: 'Add friends to see their check-ins, message them, share strains, and trade duplicate cards.' },
     { icon: '⭐', title: 'A lot more in "More"', body: 'Compare strains side by side, check what’s trending, look up your state’s cannabis laws, keep a wishlist, and more — it’s all grouped by category in the More tab.' },
+    // Deliberately last: a straight yes/no offer to add StrainDex to the
+    // home screen, right while someone's already paying attention during
+    // signup. On Chromium (Android/desktop) "Yes" fires the browser's own
+    // one-tap install; on iOS, where Apple gives websites no install API
+    // at all, "Yes" instead reveals the manual Share -> Add to Home Screen
+    // steps in place. See StrainDexInstall in app.js and, for anyone who
+    // skips this or comes back later, the permanent guide at
+    // /add-to-home-screen.
+    { icon: '📲', title: 'Add StrainDex to your phone', install: true },
   ];
+  const installStepIndex = steps.length - 1;
   const body = `
     <div class="card" style="text-align:center;padding:32px 20px;">
       <div id="onboarding-steps">
         ${steps.map((s, i) => `
           <div class="onboarding-step" data-step="${i}" style="${i === 0 ? '' : 'display:none;'}">
-            <div style="font-size:44px;margin-bottom:16px;">${s.icon}</div>
-            <h2 style="margin:0 0 8px;font-size:18px;">${esc(s.title)}</h2>
-            <p style="color:var(--ink-secondary);font-size:13.5px;line-height:1.6;margin:0;">${esc(s.body)}</p>
+            ${s.install ? `
+              <div style="font-size:44px;margin-bottom:16px;">${s.icon}</div>
+              <h2 style="margin:0 0 8px;font-size:18px;">${esc(s.title)}</h2>
+              <p style="color:var(--ink-secondary);font-size:13.5px;line-height:1.6;margin:0 0 18px;">One tap gets you a real icon and a full-screen app — no app store needed.</p>
+              <div id="onboarding-install-offer" style="display:flex;gap:8px;">
+                <button type="button" id="onboarding-install-no" class="btn secondary" style="flex:1;">Not now</button>
+                <button type="button" id="onboarding-install-yes" class="btn" style="flex:1;">📲 Yes, add it</button>
+              </div>
+              <div id="onboarding-install-ios" style="display:none;text-align:left;">
+                <p class="empty-note" style="padding:0 0 6px;">On iPhone/iPad, Safari makes you do this one manually:</p>
+                <ol style="margin:0 0 14px;padding-left:20px;font-size:13px;">
+                  <li style="margin-bottom:6px;">Tap the <b>Share</b> icon in Safari's toolbar.</li>
+                  <li style="margin-bottom:6px;">Scroll down and tap <b>Add to Home Screen</b>.</li>
+                  <li>Tap <b>Add</b> in the top right.</li>
+                </ol>
+                <button type="button" id="onboarding-install-done" class="btn block">Got it</button>
+              </div>
+            ` : `
+              <div style="font-size:44px;margin-bottom:16px;">${s.icon}</div>
+              <h2 style="margin:0 0 8px;font-size:18px;">${esc(s.title)}</h2>
+              <p style="color:var(--ink-secondary);font-size:13.5px;line-height:1.6;margin:0;">${esc(s.body)}</p>
+            `}
           </div>`).join('')}
       </div>
       <div style="display:flex;justify-content:center;gap:6px;margin:22px 0 6px;">
         ${steps.map((_, i) => `<span class="onboarding-dot" data-dot="${i}" style="width:6px;height:6px;border-radius:50%;background:${i === 0 ? 'var(--brand-green)' : 'var(--border)'};"></span>`).join('')}
       </div>
     </div>
-    <div style="display:flex;gap:8px;margin-top:14px;">
+    <div style="display:flex;gap:8px;margin-top:14px;" id="onboarding-standard-actions">
       <a href="/" class="btn secondary block" style="flex:1;">Skip</a>
       <button type="button" id="onboarding-next" class="btn block" style="flex:1;">Next</button>
     </div>
     <script>
       (function() {
-        const total = ${steps.length};
+        let total = ${steps.length};
+        let installStepIndex = ${installStepIndex};
         let i = 0;
         const nextBtn = document.getElementById('onboarding-next');
+        const standardActions = document.getElementById('onboarding-standard-actions');
+
         function render() {
           document.querySelectorAll('.onboarding-step').forEach(el => { el.style.display = Number(el.dataset.step) === i ? '' : 'none'; });
           document.querySelectorAll('.onboarding-dot').forEach(el => { el.style.background = Number(el.dataset.dot) === i ? 'var(--brand-green)' : 'var(--border)'; });
+          standardActions.style.display = i === installStepIndex ? 'none' : 'flex';
           nextBtn.textContent = i === total - 1 ? 'Get started' : 'Next';
         }
         nextBtn.addEventListener('click', () => {
           if (i < total - 1) { i++; render(); } else { window.location.href = '/'; }
         });
+
+        // Already running installed (e.g. re-opened this link from inside
+        // the installed app, or installed earlier via a [data-install-trigger]
+        // button elsewhere) -- nothing to offer, so drop the step entirely
+        // rather than showing a dead-end screen.
+        const install = window.StrainDexInstall;
+        if (install && install.isInstalled && install.isInstalled()) {
+          const stepEl = document.querySelector('.onboarding-step[data-step="' + installStepIndex + '"]');
+          const dotEl = document.querySelector('.onboarding-dot[data-dot="' + installStepIndex + '"]');
+          if (stepEl) stepEl.remove();
+          if (dotEl) dotEl.remove();
+          total -= 1;
+          installStepIndex = -1;
+        }
+
+        const yesBtn = document.getElementById('onboarding-install-yes');
+        const noBtn = document.getElementById('onboarding-install-no');
+        const doneBtn = document.getElementById('onboarding-install-done');
+        const offerBox = document.getElementById('onboarding-install-offer');
+        const iosBox = document.getElementById('onboarding-install-ios');
+        if (yesBtn) {
+          yesBtn.addEventListener('click', async () => {
+            if (install && install.isAvailable && install.isAvailable()) {
+              yesBtn.disabled = true;
+              yesBtn.textContent = 'Adding…';
+              await install.prompt();
+              window.location.href = '/';
+            } else if (install && install.isIOS && install.isIOS()) {
+              offerBox.style.display = 'none';
+              iosBox.style.display = '';
+            } else {
+              // Not iOS, and the browser hasn't offered a native prompt
+              // (e.g. Firefox, or Chromium just hasn't decided to yet) --
+              // send them to the full guide instead of a dead end.
+              window.location.href = '/add-to-home-screen';
+            }
+          });
+        }
+        if (noBtn) noBtn.addEventListener('click', () => { window.location.href = '/'; });
+        if (doneBtn) doneBtn.addEventListener('click', () => { window.location.href = '/'; });
+
+        render();
       })();
     </script>
   `;
   sendHtml(res, layout({ title: 'Welcome', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)), showBack: false }));
 }
 
+// ---------------------------------------------------------------- add to home screen
+// StrainDex is a PWA, not something distributed through the App Store or
+// Play Store -- most people have never installed a website before, so this
+// exists as the permanent, findable version of "how do I actually do that"
+// (the onboarding install step covers the same ground once, right after
+// signup, but this is here for anyone who skipped it, switched devices, or
+// just wants the instructions again). Shows all three platforms rather
+// than trying to guess right from the server side (no reliable signal
+// pre-JS), then a small inline script auto-selects the tab that matches
+// the visitor's actual device and reveals the one-tap install button only
+// where the browser has actually offered one (see StrainDexInstall in
+// app.js) -- Chromium never fires that offer on the very first page view,
+// so the button starts hidden and appears if/when the browser decides to.
+function pageAddToHomeScreen(req, res) {
+  const body = `
+    <h1 class="screen-title">📲 Add StrainDex to Your Home Screen</h1>
+    <p class="screen-sub">StrainDex is a <b>web app</b>, not something you download from an app store — but you can still add it to your home screen so it opens full-screen with its own icon, just like any other app.</p>
+
+    <button type="button" class="btn block" data-install-trigger style="display:none;margin-bottom:8px;">📲 Install StrainDex</button>
+    <p class="empty-note" id="a2hs-auto-note" style="display:none;padding:0 0 14px;">Tap above and confirm — your browser will add the icon automatically.</p>
+
+    <div style="margin-bottom:14px;">
+      <button type="button" class="filter-pill active" data-a2hs-tab="ios">📱 iPhone / iPad</button>
+      <button type="button" class="filter-pill" data-a2hs-tab="android">🤖 Android</button>
+      <button type="button" class="filter-pill" data-a2hs-tab="desktop">💻 Desktop</button>
+    </div>
+
+    <div class="card a2hs-panel" data-a2hs-panel="ios">
+      <h2 style="margin:0 0 8px;font-size:15px;">iPhone &amp; iPad (Safari)</h2>
+      <ol style="margin:0;padding-left:20px;">
+        <li style="margin-bottom:8px;">Open StrainDex in <b>Safari</b> — this only works in Safari itself, not Chrome, Instagram, or another in-app browser.</li>
+        <li style="margin-bottom:8px;">Tap the <b>Share</b> icon (the square with an arrow pointing up) in the toolbar.</li>
+        <li style="margin-bottom:8px;">Scroll down and tap <b>Add to Home Screen</b>.</li>
+        <li>Tap <b>Add</b> in the top right — that's it.</li>
+      </ol>
+      <p class="empty-note" style="padding-top:8px;">Apple doesn't let any website trigger this automatically — the Share menu is the only way in on iOS.</p>
+    </div>
+
+    <div class="card a2hs-panel" data-a2hs-panel="android" style="display:none;">
+      <h2 style="margin:0 0 8px;font-size:15px;">Android (Chrome)</h2>
+      <ol style="margin:0;padding-left:20px;">
+        <li style="margin-bottom:8px;">Tap the <b>Install StrainDex</b> button above if you see it — Chrome will prompt you and add the icon for you.</li>
+        <li style="margin-bottom:8px;">Don't see the button? Tap the <b>⋮</b> menu in the top right of Chrome.</li>
+        <li>Tap <b>Install app</b> (or <b>Add to Home screen</b>), then confirm.</li>
+      </ol>
+    </div>
+
+    <div class="card a2hs-panel" data-a2hs-panel="desktop" style="display:none;">
+      <h2 style="margin:0 0 8px;font-size:15px;">Desktop (Chrome / Edge)</h2>
+      <ol style="margin:0;padding-left:20px;">
+        <li style="margin-bottom:8px;">Tap the <b>Install StrainDex</b> button above if you see it.</li>
+        <li style="margin-bottom:8px;">Or click the install icon at the right edge of the address bar.</li>
+        <li>Or open the <b>⋮</b> menu and choose <b>Install StrainDex…</b>.</li>
+      </ol>
+      <p class="empty-note" style="padding-top:8px;">Firefox and Safari on desktop don't currently support installing websites this way — StrainDex still works fine in a regular browser tab either way.</p>
+    </div>
+
+    <p class="empty-note" style="margin-top:14px;">Already installed? Look for the StrainDex leaf icon on your home screen or desktop next time instead of coming back to a browser tab.</p>
+
+    <script>
+      (function () {
+        const tabs = document.querySelectorAll('[data-a2hs-tab]');
+        const panels = document.querySelectorAll('[data-a2hs-panel]');
+        function selectTab(name) {
+          tabs.forEach(t => t.classList.toggle('active', t.dataset.a2hsTab === name));
+          panels.forEach(p => { p.style.display = p.dataset.a2hsPanel === name ? '' : 'none'; });
+        }
+        tabs.forEach(t => t.addEventListener('click', () => selectTab(t.dataset.a2hsTab)));
+
+        const install = window.StrainDexInstall;
+        const autoNote = document.getElementById('a2hs-auto-note');
+        if (install && install.isInstalled && install.isInstalled()) {
+          if (autoNote) { autoNote.textContent = 'StrainDex is already installed on this device.'; autoNote.style.display = ''; }
+        } else if (install && install.onAvailable) {
+          install.onAvailable(() => { if (autoNote) autoNote.style.display = ''; });
+        }
+
+        // Auto-select whichever tab matches this device -- doesn't affect
+        // the button above, just saves a tap for the common case.
+        if (install && install.isIOS && install.isIOS()) selectTab('ios');
+        else if (/android/i.test(navigator.userAgent)) selectTab('android');
+        else selectTab('desktop');
+      })();
+    </script>
+  `;
+  sendHtml(res, layout({ title: 'Add to Home Screen', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
+}
+
 // "Find your first strain" quiz -- a lightweight 3-question filter over the
 // same THC-bucket logic already used by the Strain Library's filters, plus
 // simple effect-tag scoring. Not a medical tool, just a starting point for
@@ -3120,6 +3283,7 @@
     {
       title: 'Support',
       tiles: [
+        { href: '/add-to-home-screen', icon: '📲', t: 'Add to Home Screen', s: 'Install StrainDex like an app' },
         { href: '/feedback', icon: '📝', t: 'Send Feedback', s: 'Bugs, ideas — anything' },
         { href: '/support-the-app', icon: '💚', t: 'Support the App', s: 'Help cover hosting costs' },
       ],
@@ -4235,6 +4399,7 @@
     if (method === 'GET' && pathname === '/effects-guide') return pageEffectsGuide(req, res);
     if (method === 'GET' && pathname === '/mood-finder') return pageMoodFinder(req, res, url.searchParams);
     if (method === 'GET' && pathname === '/breeder-guide') return pageBreederGuide(req, res);
+    if (method === 'GET' && pathname === '/add-to-home-screen') return pageAddToHomeScreen(req, res);
     if (method === 'POST' && pathname === '/report') return await handleReport(req, res);
     if (method === 'POST' && (m = pathname.match(/^\/block\/(\d+)$/))) return await handleBlock(req, res, m[1]);
     if (method === 'POST' && (m = pathname.match(/^\/unblock\/(\d+)$/))) return await handleUnblock(req, res, m[1]);
