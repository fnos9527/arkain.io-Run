const { chromium } = require('playwright');

// ─── 工具函数 ────────────────────────────────────────────────────────────────

async function sendTelegram(token, chatId, message) {
  if (!token || !chatId) { console.log('未配置 TG，跳过通知'); return; }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
  });
  const data = await res.json();
  if (!data.ok) console.error('TG 发送失败:', JSON.stringify(data));
  else console.log('TG 通知发送成功');
}

function parseCredits(text) {
  const match = text && text.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

async function screenshot(page, name) {
  try {
    const p = `/tmp/arkain_${name}.png`;
    await page.screenshot({ path: p, fullPage: false });
    console.log(`截图: ${p}`);
  } catch (e) { console.log('截图失败:', e.message); }
}

// 关闭弹窗（cookie + 功能介绍）
async function dismissPopups(page) {
  console.log('检查并关闭弹窗...');

  // Cookie 弹窗
  for (const sel of ['button:has-text("Accept all")', 'button:has-text("Confirm my choices")']) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click();
        console.log(`已关闭 cookie 弹窗 (${sel})`);
        await page.waitForTimeout(600);
        break;
      }
    } catch {}
  }

  // 功能介绍弹窗（× 按钮）
  for (const sel of [
    '[role="dialog"] button[aria-label="Close"]',
    '[role="dialog"] button[aria-label="close"]',
    '[role="dialog"] button:has-text("×")',
    '[role="dialog"] button:has-text("✕")',
    'button[aria-label="Close"]',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click();
        console.log(`已关闭功能介绍弹窗 (${sel})`);
        await page.waitForTimeout(600);
        break;
      }
    } catch {}
  }

  // 兜底：Escape
  try {
    if (await page.locator('[role="dialog"]').first().isVisible({ timeout: 1000 })) {
      await page.keyboard.press('Escape');
      console.log('已按 Escape 关闭残余弹窗');
      await page.waitForTimeout(500);
    }
  } catch {}
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const email    = process.env.ARKAIN_EMAIL;
  const password = process.env.ARKAIN_PASSWORD;
  const tgToken  = process.env.TG_TOKEN;
  const tgChatId = process.env.TG_CHAT_ID;

  if (!email || !password) throw new Error('缺少 ARKAIN_EMAIL 或 ARKAIN_PASSWORD');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  try {
    // ── 步骤 1：登录 ──────────────────────────────────────────────────────
    console.log('=== 步骤 1：打开登录页 ===');
    await page.goto('https://account.arkain.io/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('input[placeholder="Your E-mail"]', { state: 'visible', timeout: 20000 });
    await dismissPopups(page);

    console.log('=== 步骤 2：填写邮箱密码 ===');
    await page.locator('input[placeholder="Your E-mail"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await screenshot(page, 'before_login');

    console.log('=== 步骤 3：点击 Login ===');
    await page.locator('button:has-text("Login")').click();

    console.log('=== 步骤 4：等待进入 dashboard ===');
    await page.waitForURL('**/dashboard**', { waitUntil: 'domcontentloaded', timeout: 40000 });
    console.log('已进入 dashboard:', page.url());
    await page.waitForTimeout(3000);

    // 关闭 dashboard 上的弹窗
    await dismissPopups(page);
    await screenshot(page, 'dashboard_clean');

    // ── 步骤 5：读取签到前积分 ────────────────────────────────────────────
    console.log('=== 步骤 5：读取签到前积分 ===');
    let creditsBefore = null;
    try {
      const el = page.locator('text=/\\d+\\s*credits\\s*left/i').first();
      await el.waitFor({ state: 'visible', timeout: 8000 });
      creditsBefore = parseCredits(await el.textContent());
      console.log('签到前积分:', creditsBefore);
    } catch { console.log('未能读取签到前积分'); }

    // ── 步骤 6：打开签到弹窗 ──────────────────────────────────────────────
    // 从截图确认：有两个入口，优先用底部彩色浮动按钮 "Daily check-in"
    // 备用：右上角 D+N 按钮（是 div/span 不是 button，用 text 选择器）
    console.log('=== 步骤 6：点击签到入口 ===');

    // 先打印右上角区域的 HTML，帮助确认 D+N 的真实结构
    try {
      const topbarHtml = await page.evaluate(() => {
        // 找包含 "D+" 文字的元素
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (/D\+\d/.test(node.textContent)) {
            return node.parentElement.outerHTML;
          }
        }
        return '未找到 D+ 元素';
      });
      console.log('D+N 元素 HTML:', topbarHtml);
    } catch {}

    // 尝试所有可能的签到入口选择器
    const checkinEntrySelectors = [
      // 底部浮动按钮（从截图看最醒目）
      'button:has-text("Daily check-in")',
      '[class*="daily-check"]:visible',
      '[class*="dailyCheck"]:visible',
      // 右上角 D+N（可能是 div/span，用 :has-text 宽泛匹配）
      'button:has-text("D+")',
      '*:has-text("D+1"):visible',
      '*:has-text("D+2"):visible',
      '*:has-text("D+3"):visible',
      // 用 text 选择器匹配任意含 D+ 数字的元素
      'text=/D\\+\\d+/',
    ];

    let checkinEntry = null;
    for (const sel of checkinEntrySelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 3000 })) {
          checkinEntry = el;
          console.log(`找到签到入口: ${sel}`);
          break;
        }
      } catch {}
    }

    if (!checkinEntry) {
      // 最后手段：用 JS 找页面上所有含 "Daily check-in" 或 "D+" 文字的可点击元素
      console.log('尝试 JS 查找签到入口...');
      const found = await page.evaluate(() => {
        const all = document.querySelectorAll('*');
        for (const el of all) {
          const t = el.textContent?.trim();
          if ((t === 'Daily check-in' || /^D\+\d+$/.test(t)) && el.children.length === 0) {
            el.style.outline = '3px solid red';
            return el.outerHTML;
          }
        }
        return null;
      });
      console.log('JS 查找结果:', found);
      await screenshot(page, 'checkin_entry_debug');
      throw new Error('找不到签到入口，请查看截图 checkin_entry_debug');
    }

    await checkinEntry.click();
    console.log('已点击签到入口');
    await page.waitForTimeout(1500);
    await screenshot(page, 'checkin_modal');

    // ── 步骤 7：点击弹窗内签到按钮 ──────────────────────────────────────
    console.log('=== 步骤 7：点击签到弹窗按钮 ===');

    // 先打印弹窗内容帮助调试
    try {
      const dialogHtml = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return dialog ? dialog.innerHTML.substring(0, 1000) : '无 dialog';
      });
      console.log('弹窗内容:', dialogHtml);
    } catch {}

    const modalBtnSelectors = [
      'button:has-text("Daily check-in and receive credit")',
      'button:has-text("Daily check-in")',
      'button:has-text("Check in")',
      'button:has-text("Receive")',
      '[role="dialog"] button:not([aria-label])',
    ];

    let modalBtn = null;
    for (const sel of modalBtnSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 5000 })) {
          modalBtn = el;
          console.log(`签到按钮选择器: ${sel}`);
          break;
        }
      } catch {}
    }

    if (!modalBtn) {
      await screenshot(page, 'modal_not_found');
      throw new Error('找不到签到弹窗按钮');
    }

    await modalBtn.click();
    console.log('已点击签到按钮');
    await page.waitForTimeout(2000);

    // ── 步骤 8：刷新读取签到后积分 ───────────────────────────────────────
    console.log('=== 步骤 8：刷新读取积分 ===');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    await dismissPopups(page);

    let creditsAfter = null;
    try {
      const el = page.locator('text=/\\d+\\s*credits\\s*left/i').first();
      await el.waitFor({ state: 'visible', timeout: 10000 });
      creditsAfter = parseCredits(await el.textContent());
      console.log('签到后积分:', creditsAfter);
    } catch { console.log('未能读取签到后积分'); }

    await screenshot(page, 'final');

    // ── 步骤 9：TG 通知 ───────────────────────────────────────────────────
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    let message = '';
    if (creditsAfter !== null && creditsBefore !== null) {
      const gained = creditsAfter - creditsBefore;
      message =
        `✅ <b>Arkain 每日签到成功</b>\n\n` +
        `📅 时间：${now}\n` +
        `💰 签到前：${creditsBefore} credits\n` +
        `💰 签到后：${creditsAfter} credits\n` +
        `🎁 本次获得：<b>+${gained > 0 ? gained : '0（今日已签或数值异常）'}</b>`;
    } else if (creditsAfter !== null) {
      message = `✅ <b>Arkain 每日签到成功</b>\n\n📅 时间：${now}\n💰 当前积分：${creditsAfter} credits`;
    } else {
      message = `✅ <b>Arkain 签到流程已完成</b>\n\n📅 时间：${now}\n⚠️ 积分读取失败，请手动确认`;
    }
    console.log('=== TG 通知 ===\n' + message.replace(/<[^>]+>/g, ''));
    await sendTelegram(tgToken, tgChatId, message);

  } catch (err) {
    console.error('签到出错:', err.message);
    await screenshot(page, 'error');
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    await sendTelegram(tgToken, tgChatId,
      `❌ <b>Arkain 签到失败</b>\n\n📅 时间：${now}\n🔴 错误：${err.message}`
    );
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
