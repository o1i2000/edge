import sys, json
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8765/"
errors = []

def check(cond, msg):
    print(("PASS  " if cond else "FAIL  ") + msg)
    if not cond:
        errors.append(msg)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, color_scheme="dark")
    pg = ctx.new_page()
    logs = []
    pg.on("console", lambda m: logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
    pg.on("pageerror", lambda e: logs.append(("pageerror", str(e))))

    pg.goto(BASE + "?debug&speed=8")
    pg.wait_for_selector("text=Connect Progressor")
    pg.screenshot(path="/tmp/edge-shots/01-connect.png")
    check(pg.locator("text=This browser cannot use Bluetooth").count() == 1, "headless Chromium has no Web Bluetooth -> unsupported notice shown")

    pg.click("text=Try the demo")
    pg.wait_for_selector("text=Start session")
    check("Demo Progressor" in pg.inner_text("#view-pull"), "demo device connected, name shown")
    pg.fill("#bw", "72"); pg.dispatch_event("#bw", "change")
    check("Peak force" in pg.inner_text("#view-pull"), "ready screen names the peak force test")
    check(pg.locator("text=Repeaters").count() == 0 and pg.locator("text=Max hang").count() == 0, "no other test options offered")
    pg.screenshot(path="/tmp/edge-shots/02-ready.png")

    # --- max hang session
    pg.click("#start")
    pg.wait_for_selector("#finish")
    pg.wait_for_timeout(1900)   # 8x speed: ~15 s of device time -> mid second pull
    pg.screenshot(path="/tmp/edge-shots/03-running.png")
    state = pg.inner_text(".pullstate")
    print("      state mid-session:", state)
    pg.wait_for_function("document.querySelectorAll('#pulls .pull').length >= 3", timeout=15000)
    n = pg.locator("#pulls .pull").count()
    check(n == 3, f"3 max-hang pulls detected live (got {n})")
    peaks = [float(x.split()[0]) for x in pg.locator("#pulls .pull .v").all_inner_texts()]
    print("      peaks (newest first):", peaks)
    check(all(34 < v < 39 for v in peaks), "peaks match the scripted 35.5-37.5 kg pulls")
    pg.screenshot(path="/tmp/edge-shots/04-pulls.png")
    pg.click("#finish")
    pg.wait_for_selector("text=Start session")
    check("Saved 3 pulls" in pg.inner_text("#toast"), "toast confirms save")
    saved = pg.evaluate("window.__edge.S.sessions.length")
    check(saved == 1, "session held in app state")
    # persisted to IndexedDB?
    pg.reload()
    pg.wait_for_selector("text=Connect Progressor")
    cnt = pg.evaluate("""() => new Promise(res => { const r = indexedDB.open('edge-finger-tests',1); r.onsuccess = () => { const q = r.result.transaction('sessions').objectStore('sessions').count(); q.onsuccess = () => res(q.result); }; })""")
    check(cnt == 1, f"session persisted in IndexedDB across reload (count={cnt})")

    # --- right hand session, hand chosen on the ready screen
    pg.click("text=Try the demo"); pg.wait_for_selector("text=Start session")
    pg.click("text=Right")
    pg.click("#start"); pg.wait_for_selector("#finish")
    pg.wait_for_function("document.querySelectorAll('#pulls .pull').length >= 3", timeout=25000)
    pg.screenshot(path="/tmp/edge-shots/05-right-hand.png")
    hands = pg.locator("#pulls .pull .hand").evaluate_all("els => els.map(e => e.title)")
    check(hands == ["Right"] * 3, f"pulls tagged with the Right hand (got {hands})")
    pg.click("#finish"); pg.wait_for_selector("text=Start session")
    check(pg.evaluate("window.__edge.S.sessions.length") == 2, "second session saved")

    # --- history with seeded data
    pg.evaluate("window.__edge.seed()")
    pg.click("#tab-history")
    pg.wait_for_selector(".chartbox svg")
    pg.screenshot(path="/tmp/edge-shots/06-history.png", full_page=True)
    check(pg.locator(".chartbox svg circle").count() >= 28, "trend chart has markers for both hands")
    check(pg.locator(".legend").count() == 1, "legend present for 2 series")
    txt = pg.inner_text("#view-history")
    print("      history text sample:", txt.replace("\n", " | ")[:420])
    check("a week" in txt, "weekly trend stat rendered")
    # tooltip
    box = pg.locator(".chartbox svg rect[fill=transparent]").first.bounding_box()
    pg.locator(".chartbox svg rect[fill=transparent]").first.scroll_into_view_if_needed()
    box = pg.locator(".chartbox svg rect[fill=transparent]").first.bounding_box()
    pg.mouse.click(box["x"] + box["width"] * 0.9, box["y"] + box["height"] * 0.4)
    pg.wait_for_selector(".tip.act button")
    pg.screenshot(path="/tmp/edge-shots/07-tooltip.png")
    print("      tip:", pg.inner_text(".tip.act").replace("\n", " | "))
    check(pg.locator(".tip button").count() == 1, "tooltip offers Open session")
    pg.click(".tip button")
    pg.wait_for_selector("text=Peak per pull")
    pg.screenshot(path="/tmp/edge-shots/08-detail.png", full_page=True)
    check(pg.locator("dl.metrics dt").count() >= 7, "pull metrics listed")
    # select another bar
    pg.locator("svg rect[role=button]").nth(1).click()
    pg.wait_for_selector("text=Pull 2")
    check("Pull 2" in pg.inner_text("#view-history"), "tapping a bar selects that pull")
    # repeaters history
    pg.click("text=‹ History")
    pg.wait_for_selector(".chartbox svg")
    check(pg.locator("#view-history >> text=Repeaters").count() == 0, "history has no test-type switch")
    check("Peak force" in pg.inner_text("#view-history"), "sessions are labelled Peak force")
    # open the repeater session -> fade text
    pg.locator(".list .item").first.click() if False else None
    # settings
    pg.click("#tab-settings")
    pg.screenshot(path="/tmp/edge-shots/10-settings.png", full_page=True)
    lg = pg.inner_text("#log")
    print("      log:\n        " + lg.replace("\n", "\n        "))
    check("streaming:" in lg and "Hz" in lg, "connection log records the sample rate")
    check("first packet" in lg and "battery reply: 2950 mV" in lg, "connection log records first packet and battery")

    # --- light mode + wide check
    ctx2 = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, color_scheme="light")
    pg2 = ctx2.new_page()
    pg2.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    pg2.goto(BASE + "?debug&autodemo&speed=8")
    pg2.wait_for_selector("text=Start session")
    pg2.evaluate("window.__edge.seed()")
    pg2.click("#start"); pg2.wait_for_selector("#finish"); pg2.wait_for_timeout(1500)
    pg2.screenshot(path="/tmp/edge-shots/11-running-light.png")
    pg2.click("#tab-history"); pg2.wait_for_selector(".chartbox svg")
    pg2.screenshot(path="/tmp/edge-shots/12-history-light.png", full_page=True)

    bad = [l for l in logs if l[0] in ("error", "pageerror")]
    print("console errors:", bad)
    check(not bad, "no console errors / page errors")
    b.close()

print("\nFAILURES:", errors if errors else "none")
sys.exit(1 if errors else 0)
