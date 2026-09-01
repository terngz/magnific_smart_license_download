const monthSelect = document.getElementById("month");
const yearSelect = document.getElementById("year");
const dateFormatSelect = document.getElementById("dateFormat");
const maxItemsInput = document.getElementById("maxItems");
const autoNextPageCheckbox = document.getElementById("autoNextPage");
const maxPagesInput = document.getElementById("maxPages");
const nextSelectorInput = document.getElementById("nextSelector");
const minWaitInput = document.getElementById("minWait");
const maxWaitInput = document.getElementById("maxWait");
const resetHistoryCheckbox = document.getElementById("resetHistory");
const runBtn = document.getElementById("runBtn");
const logEl = document.getElementById("log");

const MONTH_NAMES_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTH_NAMES_LONG = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const YEAR_MIN = 2020;
const YEAR_MAX = 2030;

function populateMonths() {
  MONTH_NAMES_SHORT.forEach((short, idx) => {
    const opt = document.createElement("option");
    opt.value = idx; // 0-11
    opt.textContent = `${short} / ${MONTH_NAMES_LONG[idx]}`;
    monthSelect.appendChild(opt);
  });
  monthSelect.value = new Date().getMonth();
}

function populateYears() {
  const currentYear = new Date().getFullYear();
  for (let y = YEAR_MAX; y >= YEAR_MIN; y--) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    yearSelect.appendChild(opt);
  }
  // Default to current system year; if outside the fixed range, fall back to closest bound.
  if (currentYear >= YEAR_MIN && currentYear <= YEAR_MAX) {
    yearSelect.value = currentYear;
  } else {
    yearSelect.value = currentYear < YEAR_MIN ? YEAR_MIN : YEAR_MAX;
  }
}

populateMonths();
populateYears();

function appendLog(text) {
  logEl.style.display = "block";
  logEl.textContent += text + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "sld_log") appendLog(msg.text);
  if (msg && msg.type === "sld_progress") {
    runBtn.textContent = "⏳ " + msg.current + "/" + msg.total;
  }
  if (msg && msg.type === "sld_done") {
    runBtn.disabled = false;
    runBtn.textContent = "▶ เริ่มดาวน์โหลด";
  }
});

// ---- Injected into the active tab. Must be fully self-contained (no outer closures except `args`). ----
function injectedDownloader({
  targetMonth,      // 0-11
  targetYear,
  dateFormat,       // 'ddmon' | 'monxdd' | 'iso' | 'dmy' | 'mdy'
  maxItems,
  minWait,
  maxWait,
  resetHistory,
  autoNextPage,
  maxPages,
  nextSelector,
}) {
  const storageKey = "sld_history_" + location.hostname;
  const MONTH_SHORT = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

  function log(text) {
    try { chrome.runtime.sendMessage({ type: "sld_log", text }); } catch (e) {}
    console.log(text);
  }

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function getRandomDelay() {
    const minMs = minWait * 1000;
    const maxMs = maxWait * 1000;
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  }

  function monthNameToIndex(name) {
    const n = name.toLowerCase().substring(0, 3);
    return MONTH_SHORT.indexOf(n);
  }

  // Parses month/year out of a row's text according to the chosen format.
  // Day is intentionally ignored — we only need to know which month/year the row belongs to.
  function parseRowDate(text) {
    let m;
    switch (dateFormat) {
      case "ddmon":
        m = text.match(/\b\d{1,2}\s+([A-Za-z]{3,9})\.?\s*,?\s*(\d{4})\b/);
        if (!m) return null;
        return { month: monthNameToIndex(m[1]), year: parseInt(m[2], 10) };
      case "monxdd":
        m = text.match(/\b([A-Za-z]{3,9})\.?\s+\d{1,2}\s*,?\s*(\d{4})\b/);
        if (!m) return null;
        return { month: monthNameToIndex(m[1]), year: parseInt(m[2], 10) };
      case "iso":
        m = text.match(/\b(\d{4})-(\d{2})-\d{2}\b/);
        if (!m) return null;
        return { month: parseInt(m[2], 10) - 1, year: parseInt(m[1], 10) };
      case "dmy":
        m = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
        if (!m) return null;
        return { month: parseInt(m[2], 10) - 1, year: parseInt(m[3], 10) };
      case "mdy":
        m = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
        if (!m) return null;
        return { month: parseInt(m[1], 10) - 1, year: parseInt(m[3], 10) };
      default:
        return null;
    }
  }

  function isDisabled(el) {
    if (!el) return true;
    return (
      el.disabled === true ||
      el.getAttribute("aria-disabled") === "true" ||
      el.hasAttribute("disabled") ||
      el.classList.contains("disabled") ||
      el.classList.contains("Mui-disabled")
    );
  }

  function findNextButton() {
    if (nextSelector && nextSelector.trim() !== "") {
      return document.querySelector(nextSelector.trim());
    }
    const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"));
    return candidates.find((el) => {
      const text = (el.textContent || "").trim().toLowerCase();
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      return (
        /^next\s*page$/.test(text) ||
        /^next$/.test(text) ||
        text === ">" ||
        aria.includes("next page") ||
        aria.includes("next")
      );
    });
  }

  function getTableFingerprint() {
    const rows = document.querySelectorAll("tr");
    if (rows.length === 0) return "empty:" + document.body.innerText.substring(0, 80);
    return rows.length + "|" + (rows[0].innerText || "").substring(0, 60);
  }

  // Counts rows that currently have a recognizable "license" button/link — used to
  // confirm the new page has actually finished rendering its action buttons before we scan it.
  function countRowsWithLicenseButton() {
    const rows = Array.from(document.querySelectorAll("tr"));
    let count = 0;
    rows.forEach((row) => {
      const buttonsInRow = Array.from(row.querySelectorAll("button, a"));
      const has = buttonsInRow.some((b) => {
        const t = (b.textContent || b.innerText || "").toLowerCase();
        const href = (b.getAttribute("href") || "").toLowerCase();
        return t.includes("license") || href.includes("pdf") || href.includes("license");
      });
      if (has) count++;
    });
    return count;
  }

  async function waitForPageChange(oldFingerprint, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(300);
      if (getTableFingerprint() !== oldFingerprint) {
        // Content changed, but action buttons (icons) can render a beat later.
        // Poll for license buttons to actually show up before declaring the page ready.
        const settleStart = Date.now();
        let lastCount = -1;
        while (Date.now() - settleStart < 4000) {
          const currentCount = countRowsWithLicenseButton();
          if (currentCount > 0 && currentCount === lastCount) {
            // Stable (same count two checks in a row) and non-zero — safe to proceed.
            break;
          }
          lastCount = currentCount;
          await sleep(400);
        }
        await sleep(300); // small extra buffer
        return true;
      }
    }
    return false;
  }

  function scanCurrentPage(history) {
    const allRows = Array.from(document.querySelectorAll("tr"));
    const matched = [];
    let pageHasNewerOrEqual = false;
    let totalParsed = 0;
    let totalInTargetMonth = 0;
    let totalWithButtonInTargetMonth = 0;

    allRows.forEach((row) => {
      const text = row.innerText || "";
      const parsed = parseRowDate(text);
      if (!parsed || parsed.month < 0) return;
      totalParsed++;

      const composite = parsed.year * 12 + parsed.month;
      const targetComposite = targetYear * 12 + targetMonth;
      if (composite >= targetComposite) pageHasNewerOrEqual = true;

      if (parsed.month === targetMonth && parsed.year === targetYear) {
        totalInTargetMonth++;
        const buttonsInRow = Array.from(row.querySelectorAll("button, a"));
        const licenseBtn = buttonsInRow.find((b) => {
          const t = (b.textContent || b.innerText || "").toLowerCase();
          const href = (b.getAttribute("href") || "").toLowerCase();
          return t.includes("license") || href.includes("pdf") || href.includes("license");
        });
        if (licenseBtn) {
          totalWithButtonInTargetMonth++;
          const uniqueID = licenseBtn.getAttribute("href") || text.trim().substring(0, 80);
          if (!history.includes(uniqueID)) {
            matched.push({ element: licenseBtn, id: uniqueID, name: text.split("\n")[0] });
          }
        }
      }
    });

    log(
      "🔍 หน้านี้: แถวทั้งหมด " + allRows.length +
      " | อ่านวันที่ได้ " + totalParsed +
      " | ตรงเดือนเป้าหมาย " + totalInTargetMonth +
      " | มีปุ่ม license " + totalWithButtonInTargetMonth +
      " | ใหม่ (ยังไม่เคยโหลด) " + matched.length
    );

    return { matched, pageHasNewerOrEqual };
  }

  async function downloadItem(item, history) {
    const delay = getRandomDelay();
    log('⏳ กำลังดาวน์โหลด: "' + item.name.substring(0, 30) + '..." (รอ ' + delay + " ms)");
    item.element.scrollIntoView({ behavior: "smooth", block: "center" });
    item.element.style.outline = "3px solid orange";
    await sleep(delay);
    try {
      item.element.style.outline = "3px solid #2ecc71";
      ["mouseover", "mousedown", "click", "mouseup"].forEach((eventType) => {
        const event = new MouseEvent(eventType, { bubbles: true, cancelable: true, view: window });
        item.element.dispatchEvent(event);
      });
      log("👆 ดาวน์โหลดแล้ว! (" + item.id.substring(0, 40) + ")");
      history.push(item.id);
    } catch (e) {
      log("⚠️ เกิดข้อผิดพลาด: " + e.message);
    }
    const restTime = Math.floor(Math.random() * 1000) + 2000;
    log("💤 เว้นระยะ " + restTime + " ms...");
    await sleep(restTime);
  }

  (async function run() {
    const monthLabel = MONTH_SHORT[targetMonth];
    log("🤖 Smart License Downloader");
    log("🎯 เป้าหมาย: " + monthLabel + " " + targetYear + " | จำนวน: " + maxItems);

    chrome.storage.local.get([storageKey], async (result) => {
      let history = resetHistory ? [] : result[storageKey] || [];
      if (resetHistory) log("🧹 ล้างประวัติเดิมของเว็บนี้แล้ว");

      let downloadedCount = 0;
      let pageIndex = 1;

      while (downloadedCount < maxItems) {
        log("📄 กำลังสแกนหน้าที่ " + pageIndex + " ...");
        let { matched, pageHasNewerOrEqual } = scanCurrentPage(history);

        // Safety net: if nothing turned up, the page may still be settling
        // (icons/buttons rendering async). Wait a beat and re-scan once before
        // concluding there's genuinely nothing here.
        if (matched.length === 0) {
          await sleep(1500);
          ({ matched, pageHasNewerOrEqual } = scanCurrentPage(history));
        }

        for (const item of matched) {
          if (downloadedCount >= maxItems) break;
          chrome.runtime.sendMessage({ type: "sld_progress", current: downloadedCount + 1, total: maxItems });
          await downloadItem(item, history);
          downloadedCount++;
        }

        chrome.storage.local.set({ [storageKey]: history });

        if (downloadedCount >= maxItems) break;

        if (!pageHasNewerOrEqual && matched.length === 0) {
          log("⏹️ ดูเหมือนผ่านช่วงเดือน " + monthLabel + " " + targetYear + " ไปแล้ว หยุดการค้นหา");
          break;
        }

        if (!autoNextPage) {
          log("ℹ️ ปิดการเปลี่ยนหน้าอัตโนมัติไว้ หยุดที่หน้านี้");
          break;
        }

        if (pageIndex >= maxPages) {
          log("⏹️ ถึงจำนวนหน้าสูงสุดที่กำหนด (" + maxPages + " หน้า) แล้ว หยุดการทำงาน");
          break;
        }

        const nextBtn = findNextButton();
        if (!nextBtn || isDisabled(nextBtn)) {
          log("⏹️ ไม่พบปุ่มหน้าถัดไป (หรือถึงหน้าสุดท้ายแล้ว)");
          break;
        }

        log("➡️ ไปหน้าถัดไป...");
        const fingerprint = getTableFingerprint();
        nextBtn.scrollIntoView({ behavior: "smooth", block: "center" });
        ["mouseover", "mousedown", "click", "mouseup"].forEach((eventType) => {
          const event = new MouseEvent(eventType, { bubbles: true, cancelable: true, view: window });
          nextBtn.dispatchEvent(event);
        });

        const changed = await waitForPageChange(fingerprint, 10000);
        if (!changed) {
          log("⚠️ รอโหลดหน้าถัดไปนานเกินไป หยุดการทำงาน (อาจต้องปรับ selector ปุ่ม Next)");
          break;
        }
        pageIndex++;
      }

      chrome.storage.local.set({ [storageKey]: history }, () => {
        const complete = downloadedCount >= maxItems;
        if (downloadedCount > 0 && complete) {
          log("🎉 เสร็จสิ้น: ดาวน์โหลดครบตามที่ต้องการ " + downloadedCount + " รายการ");
          alert("✅ ดาวน์โหลด License ครบ " + downloadedCount + " รายการ ตามที่ต้องการ");
        } else if (downloadedCount > 0 && !complete) {
          log("⚠️ หยุดกลางทาง: ดาวน์โหลดได้ " + downloadedCount + " จาก " + maxItems + " ที่ต้องการ (ดู log ด้านบนว่าหยุดเพราะอะไร)");
          alert("⚠️ ดาวน์โหลดได้ " + downloadedCount + " จาก " + maxItems + " รายการ — ไม่ครบตามที่ตั้งไว้ ดู log เพื่อดูสาเหตุ");
        } else {
          log("❌ ไม่พบรายการใหม่ที่ตรงกับ " + monthLabel + " " + targetYear);
          alert("ไม่พบรายการใหม่ของเดือน " + monthLabel + " " + targetYear);
        }
        chrome.runtime.sendMessage({ type: "sld_done" });
      });
    });
  })();
}

runBtn.addEventListener("click", async () => {
  const maxItems = parseInt(maxItemsInput.value, 10);
  const minWait = parseInt(minWaitInput.value, 10) || 3;
  const maxWait = parseInt(maxWaitInput.value, 10) || 7;
  const maxPages = parseInt(maxPagesInput.value, 10) || 15;

  if (!maxItems || maxItems < 1) {
    appendLog("❌ กรุณาระบุจำนวนไลเซนส์ให้ถูกต้อง");
    return;
  }
  if (minWait > maxWait) {
    appendLog("❌ ค่ารอขั้นต่ำต้องน้อยกว่าหรือเท่ากับค่ารอสูงสุด");
    return;
  }

  const targetMonth = parseInt(monthSelect.value, 10);
  const targetYear = parseInt(yearSelect.value, 10);
  const dateFormat = dateFormatSelect.value;
  const resetHistory = resetHistoryCheckbox.checked;
  const autoNextPage = autoNextPageCheckbox.checked;
  const nextSelector = nextSelectorInput.value;

  logEl.textContent = "";
  runBtn.disabled = true;
  runBtn.textContent = "⏳ 0/" + maxItems;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      appendLog("❌ ไม่พบแท็บที่ใช้งานอยู่");
      runBtn.disabled = false;
      runBtn.textContent = "▶ เริ่มดาวน์โหลด";
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectedDownloader,
      args: [{
        targetMonth, targetYear, dateFormat, maxItems, minWait, maxWait,
        resetHistory, autoNextPage, maxPages, nextSelector,
      }],
    });
  } catch (e) {
    appendLog("❌ ไม่สามารถรันสคริปต์บนหน้านี้ได้: " + e.message);
    runBtn.disabled = false;
    runBtn.textContent = "▶ เริ่มดาวน์โหลด";
  }
});
