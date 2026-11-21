import sys
from playwright.sync_api import sync_playwright
errs=[]
with sync_playwright() as p:
    b=p.chromium.launch()
    pg=b.new_page(viewport={"width":820,"height":1180})
    pg.on("pageerror",lambda e:errs.append(str(e)))
    pg.on("console",lambda m: m.type=="error" and errs.append(m.text))
    pg.route("**/cdn.jsdelivr.net/**", lambda r: r.abort())
    pg.goto("http://localhost:8765/"); pg.wait_for_selector("text=Demo mode")
    pg.click("#sample"); pg.wait_for_selector("text=Repair items (9)")
    pg.screenshot(path="/tmp/s1_setup.png", full_page=False)
    # edit + reorder + add screenshot
    pg.locator(".item").nth(0).locator("[data-k=flag]").fill("Bring ladder")
    pg.locator(".item").nth(0).locator(".add input").set_input_files("/tmp/t.jpg")
    pg.wait_for_selector(".item >> nth=0 >> .m img")
    pg.locator(".item").nth(1).locator("[data-a=up]").click(); pg.wait_for_timeout(300)
    assert pg.locator(".item").nth(0).locator(".code").input_value()=="III.6", "reorder failed"
    pg.click("#ready"); pg.wait_for_selector("text=Ready for field")
    pg.click(".acts a.p"); pg.wait_for_selector("text=Item 1 of 9")
    for i,(c,h) in enumerate([("12.50","1.5"),("40","2")]):
        pg.fill("[data-k=materials_cost]",c); pg.fill("[data-k=labor_hours]",h); pg.fill("[data-k=supply_list]","stuff %d"%i)
        if i==0:
            pg.locator("#fc .add input").set_input_files("/tmp/t.jpg"); pg.wait_for_selector("#fc .m img")
        pg.click("#next"); pg.wait_for_selector("text=Item %d of 9"%(i+2))
    pg.screenshot(path="/tmp/s2_field.png")
    pg.goto("http://localhost:8765/#/field/x/0")  # bad id -> home
    pg.wait_for_selector("text=Jobs")
    pg.click(".acts a.p"); pg.wait_for_selector("text=Item 1 of 9")
    assert pg.locator("[data-k=materials_cost]").input_value()=="12.5", pg.locator("[data-k=materials_cost]").input_value()
    assert pg.locator("#fc .m img").count()==1, "field photo not persisted"
    pg.click(".tabs a:has-text('Totals')"); pg.wait_for_selector("text=Total materials")
    assert "$52.50" in pg.inner_text(".big") and "3.5 hrs" in pg.inner_text(".big"), pg.inner_text(".big")
    pg.screenshot(path="/tmp/s3_totals.png")
    pg.click("#fin"); pg.wait_for_selector("dialog[open]"); pg.click("#dy")
    pg.wait_for_selector("text=Repair Estimate"); pg.screenshot(path="/tmp/s4_est.png", full_page=True)
    pg.goto("http://localhost:8765/"); pg.wait_for_selector("text=Estimate done")
    # reload persistence of photo blob
    pg.reload(); pg.click(".acts a:has-text('Office')"); pg.wait_for_selector(".item >> nth=1 >> .m img")
    # new manual job + delete
    pg.goto("http://localhost:8765/#/new"); pg.click("#manual"); pg.wait_for_selector("text=Repair items (0)")
    pg.click("#add"); pg.wait_for_selector("text=Repair items (1)")
    pg.click("#ready"); pg.wait_for_selector("text=Jobs")
    pg.goto("http://localhost:8765/#/new"); pg.click("#ai"); pg.wait_for_selector(".toast.bad")
    b.close()
print("ERRORS:",errs)
